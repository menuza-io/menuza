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
`0038_inventory_transfers`). Control-plane D1 holds only permissions, folded
config flags (`0040_inventory`), and menu item availability overrides.

---

## Feature Flags & Permissions

### Config flags (control plane)

`inventory.enabled` is the parent switch; every child flag is folded with
`inventory.enabled` in `getInventoryFeatureState(orgId)`:

| Flag                   | Controls                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `inventory.enabled`    | Master switch for the organization (Today, Items, Counts, Waste, Deliveries, Settings)    |
| `inventory.purchasing` | Par levels, suggested orders, purchase orders (`GET/PUT /levels*`, `/orders*`)            |
| `inventory.recipes`    | Dish & option recipes, batch production, theoretical usage from sales, auto sold-out      |
| `inventory.prep`       | Daily prep list, weekday prep targets, cook task actions (`/prep*`)                       |
| `inventory.transfers`  | Multi-location comparison and stock transfers (`/compare`, `/transfers*`)                 |

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

- **Per-device participation (`inv_count_devices`)**: Each tablet or browser
  that records entries or sends its part of a count is tracked in
  `inv_count_devices` (`countId`, `deviceKey`, `actorName`, `joinedAt`,
  `sentAt`).
- **Sending a count (`POST /counts/:id/send` / `/pos/inventory/counts/:id/send`)**:
  - From Station (or when a `deviceKey` has joined alongside other active
    devices), sending marks that device's `sentAt` timestamp. The count moves to
    `in_review` automatically once all joined devices have sent their parts.
  - A manager in the Operator App can also close and send the count to
    `in_review` directly (or pass `closeAll: true`).
- **Approval adjustment math (`POST /counts/:id/approve`)**:
  - Each count line compares the counted quantity against the ledger stock as of
    the count's snapshot (`entries.createdAt` / `count.startedAt`), excluding
    movements that happened after the count started:
    `adjustment = counted - (currentOnHand - movementsAfterSnapshot)`.
  - Sales, deliveries, waste, and batch movements recorded while the count was
    open are preserved on top of the counted baseline.

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
3. **KSA / OCI Object Storage note**: Verify browser-direct presigned `PUT`
   CORS on the KSA bucket before enabling photo uploads for KSA organizations.
   If `RECORDING_S3_BUCKET` is unset, photo upload routes degrade gracefully
   with `503 upload_not_configured`.
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

## Scheduled Jobs, Alarms & Data Retention

- **Hourly fan-out (`apps/jobs-cron`)**: Calls `POST /api/inventory/tick` on
  each regional `tenant-api`.
- **Durable Object follow-up alarm (US Worker)**: Registered via
  `inventoryAlarmModule` (`/api/inventory/tick`). When outbox rows, auto
  sold-out sync, or pending App alerts need a retry, the tick returns
  `needsFollowUp: true` and `nextDueAt` (5-minute retry).
- **Node interval (KSA / OCI)**: `INVENTORY_TICK_INTERVAL_SECONDS` (default
  `300`, min `60`, `0` disables) runs the tick in-process between hourly crons.

| Table / Storage          | Retention & Purge Policy                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `inv_outbox`             | Settled rows pruned after 14 days in `runInventoryTickForOrg` (`pruneInventoryOutbox`)   |
| `inv_idempotency_keys`   | Expired rows (`expires_at < now`, 48h TTL) pruned in `runInventoryTickForOrg`            |
| `inv_alert_log`          | Pending alerts stop retrying after 3 days or 40 attempts                                 |
| `inv_movements` / ledger | Append-only by design (`note` columns clearable for privacy)                             |
| `inventory-invoices/*`   | Deleted when replaced on a delivery or when the organization is deprovisioned            |

---

## Rollout Order

All `inventory.*` flags default to `false`, so code deploys are dark until Step
7.

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
   migrations `0033`–`0038` on first open.
4. **Tenant API — KSA (`apps/tenant-api` OCI)**: Applies `0033`–`0038` lazily
   per `tenant_<orgId>.db` on first open (and across all active orgs on the
   next tick).
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
