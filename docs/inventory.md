# Inventory & Stock

Inventory for restaurant locations: bought items, made items, storage areas,
count lists, multi-tablet stock counts, waste, suppliers, deliveries, invoice
photos, purchase orders, dish recipes, food-cost tracking, automatic sold-out
availability, daily prep lists, and multi-location stock transfers.

Status: built behind feature flags (default `false`) in two surfaces:

- **Operator App (`apps/app`)** under `/<orgSlug>/inventory/*`
- **Station tablet (`apps/station`)** in the **Stock** app (`/stock/*`, paired
  terminal with `inventoryEnabled`)

All inventory tables (`inv_*`) live in the regional tenant database
(`packages/tenant-db`, migrations `0033_inventory` through
`0039_inventory_location_settings`). Control-plane D1 holds only permissions,
folded config flags (`0040_inventory`), and menu item availability overrides.

---

## Feature Flags & Permissions

### Config flags (control plane)

`inventory.enabled` is the parent switch; every child flag is folded with
`inventory.enabled` in `getInventoryFeatureState(orgId)`:

| Flag                   | Controls                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `inventory.enabled`    | Master switch for the organization (Today, Items, Counts, Waste, Deliveries, Settings) |
| `inventory.purchasing` | Par levels, suggested orders, purchase orders (`GET/PUT /levels*`, `/orders*`)         |
| `inventory.recipes`    | Dish & option recipes, batch production, theoretical usage from sales, auto sold-out   |
| `inventory.prep`       | Daily prep list, weekday prep targets, cook task actions (`/prep*`)                    |
| `inventory.transfers`  | Multi-location comparison and stock transfers (`/compare`, `/transfers*`)              |

### Operator permissions

Seeded by `0040_inventory.sql` and granted by default to `org_role_admin` only:

- `read:inventory:any` — view stock, counts, waste, deliveries, recipes, prep,
  and transfers (without money unless `read:inventory_cost:any` is also held).
- `update:inventory:any` — manage items, storage areas, count lists, counts,
  waste, deliveries, batches, prep, and transfers.
- `read:inventory_cost:any` — see unit costs, stock value, delivery prices,
  price rises, and recipe food-cost percentages (implies `read:inventory:any`).
- `update:inventory_purchasing:any` — manage suppliers, supplier products, par
  levels, purchase orders, invoice reader, and delivery payment/price updates.
- `update:inventory_recipe:any` — edit dish and modifier recipes.

### Node kill switch

- `INVENTORY_ENABLED` on `tenant-api` (default on; `false`, `0`, `off`, `no`,
  `disabled` turns it off).
- When `false`, every `/operator/inventory/*` and `/pos/inventory/*` route
  answers `503 inventory_unavailable`.
- Sale-side outbox queueing (`inv_outbox`) continues during a kill-switch pause
  so sales are not lost while the node is paused; the tick settles queued sales
  when flags are readable.

---

## Architecture & Data Residency

- **Regional isolation**: Stock levels, movements, count entries, supplier
  contacts, delivery prices, invoice photos, and recipes never leave the
  organization's data region (`us` or `ksa`).
- **Control-plane context (`GET /resources/inventory/context`)**: The regional
  `tenant-api` reads the organization's folded `inventory.*` flags and location
  time zone / tax settings from the App using `INTERNAL_COMMAND_TOKEN` and
  caches them in `inv_location_settings`.
- **Currency**: Keyed per location in `inv_location_settings.currency`. The
  control plane provides a region hint (`USD` for `us`, `SAR` for `ksa`), and a
  location locks its currency on its first priced delivery (`currency_mismatch`
  refuses mixed-currency deliveries at the same location).
- **Notifications (`POST /resources/inventory/notify`)**: The regional tick
  posts idempotent, PII-free alert events (`orgId`, `eventId`, `kind`,
  `locationId`, `count` only) to the App.
- **Auto sold-out (`POST /resources/inventory/availability`)**: When an item
  with `autoSoldOut = true` crosses zero on-hand stock, the regional node asks
  the App to mark linked dishes unavailable (or restore them when stock returns
  above zero).

---

## Multi-Tablet Counting & Approval

- **Station "I'm done" (`POST /pos/inventory/counts/:id/send`, contract v2)**:
  Writes an audit row only (`markCountDeviceDone`). It does **not** move the
  count to `in_review` or track which tablets are still counting. The Operator
  App sends the count with `POST /counts/:id/send`, which moves it to
  `in_review`.
- **Approval adjustment math (`POST /counts/:id/approve`)**:
  - Each counted line compares the entered quantity with ledger stock **as of
    that line's latest entry time** (`inv_count_entries.createdAt`, including
    `madeAt` from Station). Movements recorded after that instant are excluded
    from `expected` but stay on hand after approval.
  - Sales, deliveries, waste, and batch movements that happened after an item
    was counted are not part of its `expected` and survive approval on top of
    the counted baseline.
- **Devices still counting (#474)**: every device and person that joins a count
  is a row in `inv_count_devices` with the last sync and the number of entries
  it said it still holds (`unsent`): Station sends it with each entries request
  (and `0` with "I'm done"), the App and the phone send
  `device: { id, unsent }`. A device that has not synced for 2 hours is "not
  responding". The review lists every device that has not said it is done, and
  approving answers 409 `devices_still_counting` (with the list) until the
  manager sends `approveAnyway: true` ("Approve anyway").
- **Late entries (#474)**: an entry that reaches a count after it was approved
  is not refused: it is kept in `inv_count_late_entries` (the response lists its
  `clientId` in `late`, and it still counts as accepted so a device settles it).
  A manager sees them on the approved count and adds one to a correction (one
  `adjustment` movement, reason `correction`, source `count_late`; for an item
  that was counted it is one more shelf on top, for one nobody counted it is the
  entry against the ledger as of the moment it was counted) or dismisses it.
  Needs the cost grant to apply. Entries to a cancelled count are still refused
  per entry.

---

## Count controls: key items, quick counts, schedules, second person (#490, #491, #525)

- **Key item (#490)**: a star on the item (`inv_items.is_key`). Stock filters to
  key items (`GET /items?key=true`); Station marks them.
- **Quick count (#490)**: an ordinary count of `kind: 'quick'`
  (`inv_counts.kind`) whose scope is the key items, or a chosen count list. It
  posts adjustments for the items it counted only (uncounted items default to
  keep) and is never a food-cost period: `computeFoodCost` reads full counts
  only (`kind = 'full'` and no list). One count being counted per location, kind
  and list. The review shows the money gap of the key items
  (`keyDifferenceValueMinor`).
- **Schedules (#490, #491)**: `inv_count_schedules` (per location: kind,
  optional list, slot opening/close/custom, local `HH:MM`, weekdays, assignee)
  beside the older single weekly count day (`inv_settings.countDayOfWeek`),
  which keeps working. A time before the day start belongs after midnight of
  that business day. A schedule or an edit applies from tomorrow: the edit
  stores today's runs first (`inv_count_schedule_runs`, one per schedule and
  day, with the assignee frozen), so a count already started or a day already
  planned never changes. Runs are projected on read (Today, the Station catalog
  `dueCounts`, my schedule) and stored by the hourly tick, an edit and a count
  start (the first count of the same kind and list started that day claims the
  run).
- **Not finished (#490)**: the tick cancels a quick count still being counted
  when its next scheduled time arrives (`count.not_finished` in the audit
  trail); nothing is merged into stock. A count in review is left to the
  manager.
- **Assignment and the overdue alert (#491)**: the assignee is a staff member of
  the roster or a member with a login
  (`assignee: { kind: 'staff' | 'member', id }`). The assigned person sees the
  run on Station after their PIN (`dueCounts`, `assigneeStaffId` links a member
  to the staff member sharing the login) and on "my schedule"
  (`GET /schedule-link/me/counts`). A run not started one hour after it was due
  posts `inventory_count_overdue` through the existing notify route and engine
  (ids, a kind and a slot only), once per run (`overdue_alerted_at`). Stock has
  "Last counted" and the filter "Not counted in 14 days" (`notCounted=true`, per
  location, items the location keeps); Today shows the number
  (`metrics.notCountedItems`) and the due run (`scheduled_count_due`).
- **Second person (#525)**: the location setting
  `inv_location_settings.second_count_required` (a manager's setting,
  `PUT /settings/locations/:id/count-controls`). When on, Finish ("send") of a
  count that includes key items does not move it to review: `second_state` is
  `waiting`. Entries in that phase are the second person's blind count of key
  items (`pass = 2`, never summed into the count): a person who made the first
  count is refused (`second_count_same_person`, a staff member who shares a
  login with an operator is the same person), non-key items are refused
  (`second_count_not_key_item`), and a first counter's tablet syncing late (made
  before the wait began) still lands in the first count. `second/finish`
  compares: no difference goes straight to review, differences are `settling`
  and shown side by side until each is settled with the first or the second
  figure (`second/settle`); a manager can skip with a recorded reason
  (`second/skip`, `update:settings:any`). The sheet the second person gets lists
  key items only and no figures.
- **Counting by bottle (#470)**: millilitre items store `counted_by_bottle`, the
  bottle size and optional full and empty weights. The screens count whole
  bottles plus the open bottle in tenths or by typed weight and send an ordinary
  entry in millilitres (`@repo/inventory` `bottles.ts`: `bottlesToMl`,
  `openBottleMlFromWeight`). Weight is typed; there is no scale connection.

---

---

## Invoice Photos & Vision Reader

### Object storage (`RECORDING_S3_*`)

Delivery invoice photos are stored under
`inventory-invoices/<orgId>/<deliveryId>/<photoId>.<ext>` in the regional S3 /
R2 / OCI bucket configured via `RECORDING_S3_*`:

1. **IAM permissions**: The node's credentials must allow `PutObject`,
   `GetObject`, `HeadObject`, `ListObjectsV2`, and `DeleteObject` (not
   delete-only).
2. **Bucket CORS**: Because the Operator App browser and Station tablet upload
   directly to the presigned `PUT` URL and view via presigned `GET`, the bucket
   must allow CORS from the App origin (`BASE_URL`) and POS origins
   (`POS_ORIGINS`):
   - Allowed methods: `PUT`, `GET`, `HEAD`
   - Allowed headers: `Content-Type`, `Content-Length`
3. **KSA / OCI Object Storage note**: Verify browser-direct presigned `PUT` CORS
   on the KSA bucket before enabling photo uploads for KSA organizations. If
   `RECORDING_S3_BUCKET` is unset, photo upload routes degrade gracefully with
   `503 upload_not_configured`.
4. **Retention & erasure**: Replacing a delivery's photo deletes the previous
   object; organization deprovision deletes the entire
   `inventory-invoices/<orgId>/` prefix alongside call recordings. Confirm that
   any bucket lifecycle rule scoped to call recordings does not prematurely
   expire `inventory-invoices/` objects.

### Vision reader (`INVOICE_READER_*`)

- Configured per regional node via `INVOICE_READER_BASE_URL`,
  `INVOICE_READER_API_KEY`, `INVOICE_READER_MODEL`, and
  `INVOICE_READER_DATA_REGION`.
- **Residency enforcement**: `isInvoiceReaderConfigured()` requires
  `INVOICE_READER_DATA_REGION === DATA_REGION`. A KSA node refuses to call a
  model endpoint unless `INVOICE_READER_DATA_REGION=ksa`.
- When unset, invoice photos are still stored and displayed, and the "Read
  invoice" action is hidden.

---

## Setup tools: used in, unit change, groups, merge, setup checks, days left, sold-out alerts

Tenant migration `0062_inventory_setup` (one migration, widen only) and no new
flag: everything rides on `inventory.enabled`; groups, "Used in" and the
sold-out alert also need `inventory.recipes`. Deploy tenant-api, then the App.

- **Used in (#518).** `GET /items/:id/used-in`: every dish, size, option and
  made item whose **current** recipe has a line for the item (or for the group
  it belongs to), with the quantity per portion and, with the cost grant, the
  line's cost and share of the plate cost. The archive confirmation shows the
  same list.
- **Change unit (#494).** `POST /items/:id/unit-change/preview` and
  `POST /items/:id/unit-change`. The person types an equation ("1 piece = 180
  g"); one plan (`inventory-unit-change-service.ts`) is both the preview and
  what is applied. On hand (one `unit_changed` adjustment per place carries the
  difference so the ledger still sums to on hand), cost per unit, named units,
  supplier packs, levels, prep levels and open tasks, and settled sale usage are
  converted in place; recipes that use the item get a **new version**. **The
  ledger is never rewritten**: `inv_unit_changes` records the conversion and
  readers bring older rows to today's unit (`quantityInCurrentUnit`: the item
  movement log, the waste list, days left, and sales settled after the change
  for a recipe in force before it). Reports before and after show the same
  money. Blocked while the item is in an open count, open transfer or an order
  that is not closed, and while it is in a group.
- **Groups (#495).** A group is an item (`inv_item_groups`) with ranked members
  (`inv_item_group_members`, with a conversion when the units differ). Recipes
  name the group like any ingredient. A sale takes stock from the first member,
  then the next (`allocateToMembers` in the expand engine; the stock it sees is
  on hand with the sale's own earlier usage added back, so a replay converges),
  food cost uses the first member's price, and auto sold-out looks at the
  members' total, so a dish goes off the menu only when the whole group is at
  zero. Groups never appear in counts, orders, prep or levels.
- **Merge (#493).** `POST /items/:id/merge`, `POST /suppliers/:id/merge`,
  `POST /merges/:id/undo` (24 hours). The kept item takes over recipes (new
  versions), supplier products, places, levels, count lists and prep levels; its
  stock becomes the sum through two `merged` adjustments; the duplicate is
  archived with `merged_into_id`. **History rows are not moved**: the ledger,
  waste, counts and deliveries are append-only, so the duplicate keeps its rows
  and readers (the kept item's movement log, days left, a supplier's unpaid
  totals and deliveries) follow the link. Items must share a base unit (change
  one first), and merging is not grouping.
- **Check your setup (#510).** `GET /setup-checks`,
  `POST /setup-checks/dismiss`, `POST /setup-checks/fix`. Rules only: a supplier
  product priced 1.00 or 0, a price far from the item's other suppliers or last
  price (and the same off by 1000x), a current recipe with no lines, an archived
  ingredient in a recipe, a made item or a dish sold in the last 7 days without
  a recipe, an item in no storage area. A finding carries a `key` and a
  `fingerprint` of its evidence; dismissing stores both and the finding returns
  when the fingerprint changes. "Fix" calls the write function of the screen it
  mirrors (`updateSupplierProduct`, `putItemPlace`) or opens the recipe with the
  line selected (`?recipeLine=<item id>`).
- **Days left (#492).** Computed on read (`@repo/inventory` `days-left.ts`): on
  hand over the average use on the days it was used in the last 28 (sales from
  recipes, waste, batches made and stock sent out, from the ledger), shaped
  forward by prep's `weekdayDemand` (Ramadan days against Ramadan days). Fewer
  than 7 days of use is "Not enough history". Stock lists and sorts by it; Today
  flags an item that runs out before its supplier's next delivery day even with
  no level set; an item not counted in 14 days shows the number greyed.
- **Sold-out alerts (#478).** The auto sold-out sync writes one
  `inv_sold_out_alerts` row per dish it takes off or gives back, and
  `dispatchSoldOutAlerts` sends ONE alert per location and kind per 15 minutes
  to `/resources/inventory/notify` (kinds `inventory_sold_out` and
  `inventory_sold_out_back`; dish ids and the ingredient's name only). A dish
  that comes back before its alert went out cancels both. The App delivers them
  on the manager alert engine (see `docs/manager-alerts.md`).

## Transfers, waste and use against recipes (#477, #515, #526, #517, #522, #509)

One migration, tenant `0067_waste_transfers` (no control-plane migration, no new
flag or permission). Everything extends what was there: the same transfer
record, the same waste log, the same ledger and the same food-cost periods.

- **Editing a planned transfer (#477).** `PATCH /transfers/:id` changes lines
  and the note while a transfer is `requested` or `draft`, with
  `expectedVersion` (409 `stale_version`); once sent it is 409 `transfer_closed`
  (checked first). The place that made the record edits it; for a **request**
  the asked place may change the lines too, and the branch then sees
  `changedBySender` and, per changed line, `askedQuantity` (what it first asked
  for; 0 = added). The maker's own edit settles it again. A token covering both
  ends names the editing place with `locationId`.
- **Station transfers (#515).** The catalogue carries `transfers` (open ones and
  those finished in the last two days: what this place must send, what is on its
  way in, what it asked for), `transferItems` and `transferBlocked`; quantities
  only, never a price, value or on-hand figure (a test walks the schemas). Send,
  receive and request go through the existing outbox (new row kinds
  `transfer_send` / `transfer_receive` / `transfer_request`, their own lane) to
  `POST /pos/inventory/transfers/:id/send|receive` and
  `POST /pos/inventory/transfers`, each idempotent by `clientId`, behind
  `inventory.transfers` and the same till-manager rule as deliveries. A send or
  receipt carries the `expectedVersion` the tablet read: if the App changed the
  transfer meanwhile the row is refused for good with `stale_version` and the
  sync screen says so (the lists are read again). A line received short stays as
  **missing in transit** (`missingQuantity`). Nothing leaves a place or arrives
  at one without a person confirming Send or Receive.
- **Transfer prices (#526).** Per item at the **sending** location,
  `inv_transfer_terms`: a fixed price per unit or cost plus a percentage, and
  `branchRequestable` (on unless switched off). The price in force is copied
  onto each line when the transfer is **sent** (`price_micro`, `price_source`)
  and never changes after. What a branch is charged is what its `transfer_in`
  movement is valued at, so the existing food-cost period (`computeFoodCost`:
  deliveries and transfers in, less transfers out) includes received transfers
  at the transfer price; the sender's `transfer_out` leaves at cost.
  `GET /transfers/owed` lists what each branch owes for what was sent in a
  period. Prices need the cost grant; the switch alone needs only
  `update:inventory:any`. A request for an item the sender does not offer is 409
  `item_not_requestable`; `GET /transfers/not-offered` gives ids only for a
  branch's form. A unit change converts the fixed price like a cost.
- **A whole dish as waste (#517).** `POST /waste/dishes` (App, behind
  `inventory.recipes`) and `POST /pos/inventory/waste/dish` (Station) expand the
  dish with the recipe in force now, with its size and options, into one
  `inv_waste` row (and `waste` movement) per ingredient, grouped under an
  `inv_waste_dishes` header (`group_id`). The log reads "2 x Dish"; the region
  stores ids only and the App/Station join names from the menu. A dish with only
  a typed cost is logged at that cost; one with neither is 409 `recipe_missing`.
  Undo (`POST .../waste/dishes/:id/undo`) reverses every row in one transaction.
  Kitchen's "Log it as waste?" now writes the same groups.
- **Later corrections (#522).** `POST /waste/:id/correct` (App only,
  `update:inventory:any`) reverses an entry or changes its quantity (or a dish's
  count) with a reason, at any age, without touching the original row:
  `inv_waste_corrections` is append-only and the log shows both. Stock moves by
  the difference with a `waste` movement (`source_type` `waste_correction`)
  **unless an approved count after the entry already covers its item**: then
  `stockEffect` is `covered_by_count`, stock is left alone and only the waste
  figures change (the list says `countedSince` before the dialog asks anything).
  The waste summary counts the corrected figure, a reversed entry not at all,
  and a dish once. A corrected entry cannot be undone (409 `already_corrected`),
  a reversed or undone one cannot be corrected again. Audited with ids and
  counts only; the reason lives on the correction row.
- **Use against recipes (#509).** `GET /variance` (behind `inventory.recipes`)
  is a report between two approved **full** counts, per item: opening,
  delivered, transfers, waste, closing, actual use (opening + purchases -
  closing) and expected use (what sale and batch movements, i.e. the recipes,
  used), and the gap = actual - expected = waste + adjustments + what the
  closing count found. The totals are exactly the period's actual food cost
  minus its expected food cost (the same instants and movements as
  `computeFoodCost`). An item no recipe uses shows actual use only ("No
  recipe"); its actual use stays in the totals. Sorted by money gap, with a
  trend over the last 6 periods; `GET /variance/movements` lists what moved an
  item in the period. Money columns need the cost grant. The screen is under
  Counts ("Use vs recipes").

Deploy order for this change: **tenant-api first** (migration `0067`), then App,
then Station (Station sends nothing new to an older region: its new routes need
this tenant-api). The Station inventory contract stays at version 2 (new
catalogue fields and routes are optional/additive); `POS_CONTRACT_VERSION` is
unchanged at 11.

---

## Scheduled Jobs, Alarms & Data Retention

- **Hourly fan-out (`apps/jobs-cron`)**: Calls `POST /api/inventory/tick` on
  each regional `tenant-api`.
- **Durable Object follow-up alarm (US Worker)**: Registered via
  `inventoryAlarmModule` (`/api/inventory/tick`). When outbox rows, auto
  sold-out sync, or pending App alerts need a retry, the tick returns
  `needsFollowUp: true` and `nextDueAt` (5-minute retry).
- **Node interval (KSA / OCI)**: `INVENTORY_TICK_INTERVAL_SECONDS` (default
  `300`, min `60`, `0` disables) runs the tick in-process between hourly crons.

| Table / Storage          | Retention & Purge Policy                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `inv_outbox`             | Settled rows pruned after 14 days in `runInventoryTickForOrg` (`pruneInventoryOutbox`) |
| `inv_idempotency_keys`   | Expired rows (`expires_at < now`, 48h TTL) pruned in `runInventoryTickForOrg`          |
| `inv_alert_log`          | Pending alerts stop retrying after 3 days or 40 attempts                               |
| `inv_movements` / ledger | Append-only by design (`note` columns clearable for privacy)                           |
| `inventory-invoices/*`   | Deleted when replaced on a delivery or when the organization is deprovisioned          |

---

## Rollout Order

All `inventory.*` flags default to `false`, so code deploys are dark until
Step 7.

1. **Control-plane D1 (`0040_inventory.sql`)**: Applied first by CI
   (`migrate-control-plane-d1`). Adds permissions and `inventory.*` system flags
   (`false`).
2. **App & Admin (`apps/app`, `apps/admin`)**: Deploy so
   `/resources/inventory/{context,notify,availability}` and
   `/<org>/inventory-token` are live before any organization flag is enabled.
   Note: `terminals-manager.tsx` omits `inventoryEnabled` from pairing-code
   requests when off, so pairing codes remain compatible even if App deploys a
   few minutes ahead of `tenant-api`.
3. **Tenant API — US Worker (`apps/tenant-api`)**: `wrangler.jsonc` runs
   `npm run generate:do-migrations` during build; each Durable Object applies
   migrations `0033`–`0039` on first open.
4. **Tenant API — KSA (`apps/tenant-api` OCI)**: Applies `0033`–`0039` lazily
   per `tenant_<orgId>.db` on first open (and across all active orgs on the next
   tick).
5. **Node environment variables**: Configure `RECORDING_S3_*` (with write
   permissions + bucket CORS), optional `INVOICE_READER_*` (matching
   `DATA_REGION`), and `INVENTORY_TICK_INTERVAL_SECONDS` on Node hosts.
6. **Jobs Cron (`apps/jobs-cron`) & Station (`apps/station`)**: Deploy
   `jobs-cron` once `/api/inventory/tick` is live on both regions, and deploy
   Station last so tablets never run ahead of `tenant-api`.
7. **Per-organization enablement (Admin)**:
   - Enable `inventory.enabled`, then enable child flags (`purchasing`,
     `recipes`, `prep`, `transfers`) as needed.
   - Grant inventory permissions to any non-admin custom roles that need access.
   - Enable **Stock** per terminal in **POS > Terminals** (requires a location
     and staff sign-in on the terminal).

---

## Rollback & Operational Caveats

- **Fastest stop (no deploy)**:
  1. Turn off `inventory.enabled` for the organization in Admin (hides App UI
     and fails closed at the region), or
  2. Set `INVENTORY_ENABLED=false` on the regional `tenant-api` node (returns
     `503 inventory_unavailable` immediately on operator and Station routes
     while continuing to record sale outbox rows).
- **Migrations are forward-only and additive**: Rolling back `tenant-api` code
  does not require a down-migration; older code ignores the `inv_*` tables and
  the defaulted `inventory_enabled` columns on `pos_devices` and
  `pos_pairing_codes`.
- **Purchase order emails (`POST /orders/:id/send`)**: The supplier email is
  sent before the database status transition commits so a transient email error
  never marks an unsent order as sent. In the rare event of a concurrent
  `expectedVersion` conflict immediately after the email leaves, retrying sends
  a second email.
- **Region switch / deprovision with auto-sold-out dishes**: Wiping a regional
  tenant database removes `inv_sold_out`. If the organization had dishes marked
  unavailable by auto-sold-out before a region switch, review menu availability
  in the App after re-provisioning.
