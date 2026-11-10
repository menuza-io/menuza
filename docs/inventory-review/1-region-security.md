# Review 1: Inventory regional API security and data integrity

Branch pr/inventory (HEAD 12b1ce67d). Read-only review; no file in the repo was
edited. All findings were verified by reading the code path; nothing was
reproduced at runtime unless noted. Detailed sub-reports from the two parallel
reviewers are merged below and kept as files:

- Station and App inbound routes (S-1 .. S-9):
  `/private/tmp/claude-501/-Users-zama-menuza/e3a77db0-8812-4ce7-bae0-1ccf5cd0b702/scratchpad/review-1a-station.md`
- Data integrity (D-*):
  `/private/tmp/claude-501/-Users-zama-menuza/e3a77db0-8812-4ce7-bae0-1ccf5cd0b702/scratchpad/review-1b-integrity.md`

This file holds the operator-API findings (M-_: authz, cost grant, location
scope, validation, PII, invoice reader) and a consolidated index of S-_ and D-*.

## Verdict on the core guard

`inventoryGuard` (`apps/tenant-api/src/lib/inventory-guard.ts`) is sound: HS256,
`aud`, `iss`, `typ=inv+jwt`, region, strict claims, TTL cap (15 min, 5
impersonated), grants limited to scope, write grants refused on impersonated
tokens (schema, `restrictInventoryGrantsForImpersonation`, and the `update:`
check in the guard), kill switch before flags, org re-check against the control
plane (503 when unavailable, never 404). Every `operator-inventory-*` route uses
`inventoryGuard`; the only routes that answer with `json()` instead of
`respond()` are `/settings` and `/status` (no money). Routes behind a `reads()`
guard were checked for writes (none).

## Findings

### M-1 (medium, confidence high) Invoice photo read link is returned to tokens without the cost grant

- File: `apps/tenant-api/src/services/inventory-purchasing-service.ts:858-872`
  (`deliveryDetail`, `options.photo` branch has no `cost` condition); reached by
  `GET /deliveries/:id` (line ~786
  `deliveryDetail(db,row,input.caller.cost,{photo:true})`) and by
  `confirmInvoicePhoto` (`inventory-receiving-service.ts:315`).
- What is wrong: every other money path is omitted for a token without
  `read:inventory_cost:any` (service-level `cost` flag plus the `MONEY_FIELDS`
  strip in `respond`). The signed read URL of the scanned supplier invoice (unit
  prices, line totals, VAT, total) is not money by field name, so neither gate
  removes it.
- Scenario: a Receiving user with only `update:inventory:any` (or any
  `read:inventory:any` member, including a read-scope token) calls
  `GET /operator/inventory/deliveries/<id>`, gets `photo.url` valid for 5
  minutes, and opens the invoice with all prices, defeating the cost grant (the
  plan says "Money figures: every money figure ... needs the cost grant").
- Fix: attach `photo` (and the read link in `confirmInvoicePhoto`) only when
  `cost` is true, otherwise return `hasPhoto` only; or require the purchasing
  grant. Keep `hasPhoto` on the summary.
- Regression test: in `operator-inventory-receiving.test.ts`, upload and confirm
  a photo, then GET the delivery with a token that lacks the cost grant: expect
  no `photo` key (and the confirm answer also has none); with the cost grant
  expect `photo.url`.

### M-2 (medium, confidence high by reading) `PATCH /items/:id` can change `baseUnit` while recipes, supplier packs, levels, prep levels or open orders already use the item

- File: `apps/tenant-api/src/services/inventory-items-service.ts:784-806`;
  trigger `inv_items_base_unit_fixed`
  (`packages/tenant-db/drizzle/0033_inventory.sql:347`) and the service check
  both look only at `inv_movements`.
- What is wrong: recipe lines (`inv_recipe_lines.quantity`), supplier packs
  (`pack_base_quantity`), levels, prep levels and order/transfer lines store
  base thousandths with no unit. Changing `g` to `piece` (or `ml`) on an item
  that has no movement yet leaves those numbers untouched but re-labels them:
  200 g (200000) becomes 200 pieces. The check `used` is true only after the
  first stock movement, which a new item with a recipe, a pack or a level
  typically does not have.
- Scenario: an owner sets up items and recipes first (the documented onboarding
  order), then fixes a wrong base unit. Every dish that uses the item then
  deducts 1000x the intended stock on its first sales; supplier pack sizes and
  suggested orders change by the same factor; no error is shown.
- Fix: refuse the change (409 `unit_in_use`) when the item has any recipe line,
  supplier product, place with levels, prep level, order line or transfer line,
  not only movements; add the same existence checks to the trigger or keep it
  service-only.
- Regression test: create item, write a recipe line for it, PATCH `baseUnit`:
  expect 409 `unit_in_use`; same for a supplier product and a level.

### M-3 (low, confidence high) `inv_idempotency_keys` is never pruned (also S-2)

- File: `apps/tenant-api/src/lib/inventory-write.ts:199-215`; no delete of
  `invIdempotencyKeys` exists in `apps/tenant-api/src` (reservations prunes
  `rsv_idempotency_keys` in `rsv-tick-service.ts:239` and
  `reservations-write.ts:456`). Each row stores the full `responseJson` (a whole
  delivery detail, a recipe, a 200-item bulk create).
- Scenario: a busy org with a Station adds rows forever; the Durable Object has
  a per-object storage cap, and every replay-check reads a growing table.
- Fix: delete `expires_at < now` in the inventory tick (index
  `idx_inv_idempotency_keys_expires` already exists). Test: tick test seeding
  one expired and one live key.

### M-4 (low, confidence high) `MONEY_FIELDS` is a name list and does not contain `amountMinor` (latent)

- File: `apps/tenant-api/src/lib/inventory-route.ts:32-65` versus
  `packages/inventory/src/contract/today.ts:111`
  (`unpaid_deliveries.amountMinor: minorOut`).
- Not exploitable today: nothing emits an `unpaid_deliveries` attention item
  (only the priority table at `inventory-today-service.ts:70` mentions it). The
  first change that does will leak the unpaid total to a cost-less token,
  because the name is not stripped and the service-level gate would be the only
  protection.
- Fix: add `amountMinor` (and `currency` is harmless) to `MONEY_FIELDS`; better,
  a test that walks every `minorOut` / `microOut` field in
  `packages/inventory/src/contract/*.ts` and asserts it is in `MONEY_FIELDS`.
  The same test would have caught nothing else missing today (all other `*Minor`
  / `*Micro` response fields are listed; checked by script).

### M-5 (low, confidence high) Concurrent or retried `POST /orders/:id/send` with `channel: email` emails the supplier twice

- File: `apps/tenant-api/src/services/inventory-orders-service.ts:1095-1175`
  (the version check, then `sendTenantEmail` at 1120, then the write transaction
  that re-checks the version at ~1147).
- What is wrong: the email goes out before the order is marked sent and outside
  the lock. Two requests with the same `expectedVersion` (double click, or a
  retry after a lost response, or a transaction failure after delivery) both
  pass the first check and both send; the second then fails with 409
  `stale_version`, so the user sees an error although the supplier got two
  orders. There is no `Idempotency-Key` support on this route.
- Fix: accept an `Idempotency-Key` (or a `clientId`) on send and key a
  short-lived claim on it, or record `sending` state under the lock before the
  email and mark `sent` after; at minimum map the second request to the first
  result.
- Test: fire two concurrent sends with the same version against a stubbed email
  provider and assert one email.

### M-6 (low, confidence high) A location-limited token can change organization-wide settings and the catalogue

- Files: `apps/tenant-api/src/routes/operator-inventory.ts:86-117`
  (`PUT /settings`, `update:inventory:any`, no location check by nature),
  `routes/operator-inventory-items.ts` (`PATCH /items/:id`, archive, restore,
  units, `POST /items`), `operator-inventory-recipes.ts` (recipes are
  organization-wide).
- Settings (`anyStaffCanReceive`, `targetFoodCostBp`, `unitSystem`,
  `countDayOfWeek`), item names and archiving, and recipes are shared by all
  locations, so a branch manager whose token has `locationIds: ['branchA']` can
  archive an item used by branch B or change the receiving policy for every
  Station. The docs say the catalogue is organization-wide, so this is probably
  intended; flagging because `locationIds` otherwise reads as a hard boundary,
  and `anyStaffCanReceive` (a security-relevant switch for Station receiving) is
  the one that does not look catalogue-like.
- Suggested: require `locationIds === null` for `PUT /settings`, or document it.
  Test: token with a location subset gets 403 on `PUT /settings`.

### M-7 (low, confidence medium) Invoice reader: no rate limit or idempotency, and number parsing drops whole reads

- Files:
  `apps/tenant-api/src/services/inventory-invoice-read-service.ts:41-139`,
  `apps/tenant-api/src/lib/invoice-reader.ts:35-45`.
- `POST /deliveries/:id/invoice-photo/read` calls a paid vision model (up to 45
  s) on every request; the only limit is the generic 120/min operator rate limit
  and nothing caches the answer for an unchanged photo. A token with the
  purchasing grant can burn the model budget; each call also writes an audit
  row.
- `numberish` turns `"1,234.50"` into `1.234.50` (NaN), which makes the whole
  `readSchema.safeParse` fail (502 `reader_failed`) for one thousands separator
  or text like "N/A" (becomes 0 for an empty string after cleaning, so a missing
  `lineTotal` reads as 0 and `toMinor` returns 0 instead of omitting). Money
  returned is stripped for cost-less tokens by `respond` (verified:
  `totalMinor`, `lineTotalMinor` are in `MONEY_FIELDS`).
- Fix: per-org limit (for example 10 per hour) and a cached answer keyed by
  `photoKey`; parse `1,234.50` by treating the last separator as the decimal
  one; map an unparsable number to null instead of failing the read.
- Test: reader answer with a thousands separator still yields lines.

### M-8 (low, confidence medium) Currency of a bulk-created starting cost is not tied to the organization's currency

- Files: `packages/inventory/src/contract/items.ts:153-160`,
  `apps/tenant-api/src/services/inventory-items-service.ts:1118-1127`.
- `currency` is any `[A-Z]{3}` per entry; `resolveInventoryCurrency` later picks
  the first `inv_item_costs` row. A bulk entry with a different currency than
  the organization's makes quantity-only deliveries use that currency, and any
  later priced delivery for an item of the other currency fails with
  `currency_mismatch`.
- Fix: validate against the data region currency (SAR for ksa, USD for us) or
  the existing cost rows. Test: bulk create with mixed currencies is refused.

### M-9 (low, informational) Invoice photo presign has no ownership or count limits; unconfirmed uploads are never swept (also S-6)

Covered in S-6. Added here: `requestInvoicePhotoUpload`
(`inventory-receiving-service.ts:216`) only requires an existing received
delivery, so each call mints a new 5 MB-capable PUT target under a fresh key and
nothing deletes the unconfirmed object.

### M-10 (low, informational) Notes on trust model and accepted design

- Locations are opaque ids: no endpoint validates that a `locationId` exists in
  the control plane, so a token with `locationIds: null` can write to phantom
  locations. Cross-organization writes are impossible (per-org database, `orgId`
  from the verified token), so this is data hygiene only.
- The token carries a snapshot of grants, flags and locations for 15 minutes, so
  a revoked member keeps access until expiry (same as the other regional
  modules).
- `onHandByItem` / `onHandByLocation` sum the whole ledger on every read
  (`inventory-common.ts:301-331`); documented in the plan ("daily on-hand
  snapshots only if reads get slow"). It gets slow at roughly hundreds of
  thousands of movements per location (sales post one movement per ingredient),
  and Durable Object billing counts rows read. Consider a running balance or a
  snapshot after each approved count.
- `inventoryNameSchema` / `inventoryNoteSchema` block control characters
  (`\p{Cc}`) but not bidi override or zero-width characters (`\p{Cf}`); names
  are shown to operators and staff only.

## Index of findings from the sub-reviews

No blocker and no high finding anywhere in the review. Totals across M-, S- and
D- (duplicates counted once, see the "same as" notes): 0 blocker, 0 high, 8
medium, about 20 low.

Station and App inbound (full text in `review-1a-station.md`; the reviewer
re-read the Station envelope, catalog, undo rules, batch caps, CORS and App
inbound routes and found them sound):

- S-1 medium (same as D-3): a Station or operator delivery replayed after the 48
  h idempotency TTL posts the stock twice; `inv_deliveries` has no client id (I
  re-checked: `packages/tenant-db/src/schema.ts:7695-7782` has none, line event
  key is `delivery:<random lineId>`).
- S-2 low (same as M-3 and D-8): idempotency table never pruned.
- S-3 low: a duplicate `clientId` inside one waste batch violates
  `uniq_inv_waste_client`, answers 500, and the Station queue retries 500
  forever (`inventory-waste-service.ts:109-215`).
- S-4 low: `madeBy` attribution is unauthenticated; only count entries and waste
  record who synced.
- S-5 low (same as D-12): `madeAt` has no lower bound
  (`contract/station.ts:276`).
- S-6 low (same as M-9): invoice photo replace/orphans on Station.
- S-7 low: `/resources/inventory/availability` restore with no `since` skips the
  manual-override guard (`contract/sold-out.ts:33-45`).
- S-8 low: notify claims the member row before the email is sent, so a failed or
  aborted send is never retried.
- S-9 informational: Station catalog does heavy reads per poll.

Data integrity (full text in `review-1b-integrity.md`; I re-read D-2 and D-4 in
the code to confirm):

- D-1 medium (related to M-8): mixed currencies are accepted
  (`inventory-purchasing-service.ts:1050-1056`, `:1409-1412`, bulk create) while
  `loadItemCosts` (`inventory-recipe-store.ts:185-202`) labels all value with
  the first cost row's currency; append-only movements are then mislabelled
  permanently.
- D-2 medium (confirmed at `inventory-counts-service.ts:144-173` and
  `:966-1010`): count approval sets stock to the counted figure against LIVE
  on-hand, so a delivery or sales between counting and approving are silently
  erased (count 10 at 10:00, +20 delivered at 14:00, approve at 18:00 posts
  -20).
- D-3 medium (= S-1).
- D-4 medium (confirmed: `contract/purchasing.ts:175-196` has no max on
  `lineTotalMinor`, `packPriceMinor`, `vatMinor`, `totalMinor`; `cost.ts:46-55`
  throws a plain error that `inventoryErrorResponse` rethrows as a 500). A
  write-grant token can make deliveries answer 500 and store a cost near 2^53
  that makes later value reads throw for large on-hand.
- D-5 medium (confidence medium): without an `rsv_location_settings` row every
  business date is UTC minus 4 h (an inventory-only org gets wrong day
  boundaries for counts, waste, prep, cut-offs).
- D-6 medium (= M-5): `sendOrder` emails the supplier before taking the lock.
- Low: D-7 bulk create accepts `costMicro` + currency without the cost or
  purchasing grant; D-9 cancelling a delivery that closed an order leaves the
  order `received` and not re-receivable; D-10 restore skips the 5000 item
  limit; D-11 count `liveKey` includes the entered unit (5 kg then corrected to
  5000 g counts 10 kg); D-13 auto sold out calls the App after every write and
  settle with an 8 s timeout and no back-off; D-14 (= M-6); D-15
  transfers/orders accept any location id string and `createTransfer` returns
  the old record for a reused `clientId` without a hash check.

## Severity counts (merged)

- blocker: 0
- high: 0
- medium: M-1 (invoice photo link bypasses cost grant), M-2 (baseUnit change
  with recipes/packs/levels), S-1/D-3 (delivery replay after 48 h), D-1 (mixed
  currencies), D-2 (count approval erases later movements), D-4 (unbounded
  delivery money to 500), D-5 (UTC business date without rsv settings), D-6/M-5
  (supplier emailed twice).
- low: M-3/S-2/D-8, M-4, M-6/D-14, M-7, M-8, M-9/S-6, M-10 items, S-3, S-4,
  S-5/D-12, S-7, S-8, D-7, D-9, D-10, D-11, D-13, D-15 (S-9 informational).

## What I checked and found no problem with

- Token: audience, issuer, typ, region, strict claims, TTL, grants vs scope,
  duplicate grants, impersonation (three layers); App mint route grants and 403
  paths; `requireInventoryAccess` on all inventory loaders (guards test passes,
  49 tests).
- Every `operator-inventory-*` route has an `inventoryGuard` with scope, grant
  and (where applicable) child feature; `/orders/*` and `/levels/*` carry
  `feature: 'purchasing'`; recipes, prep, transfers, sold-out carry theirs;
  approve count additionally needs the cost grant.
- Cost omission: all response schemas' `*Minor` / `*Micro` fields (script) are
  in `MONEY_FIELDS` except the latent `amountMinor`; money-ranked sorts (Today
  attention, waste top items, supplier choice) do not rank by money for a
  cost-less token; idempotency scope carries `c0/c1` and `respond` strips on
  replay; error details carry only ids, reasons and `currentVersion`; compare,
  transfers, today, price alerts, levels suggestions, order text (no money),
  supplier minimums and unpaid totals all gated; audit and notify payloads are
  ids and counts only (the audit table is not exposed by any route).
- Location scope: list endpoints require `locationId` checked against the token;
  record-addressed routes call `assertLocationAllowed` on the record (details in
  the integrity report); compare drops locations outside the token silently;
  transfers are visible when either end is in scope and mutations check the
  acting end.
- Validation: request schemas are strict; path ids go through
  `inventoryIdSchema`; control characters rejected in names and notes; supplier
  email through `z.email`; order text HTML is escaped and the WhatsApp link
  keeps digits only; no CSV or HTML export exists; 1 MB body limit, per-minute
  rate limits on `/operator/*` and `/pos/*`.
- Invoice reader: base URL from env only, `fetchNoRedirect`, response parsed
  strictly and stripped of control characters, `itemId` matched by exact name
  only, nothing recorded or priced automatically, same-region rule enforced.
- Photo flow: key built server-side
  (`inventory-invoices/<orgId>/<deliveryId>/<uuid>.ext`), confirm validates
  prefix, uuid pattern, HEAD size and content type, signed content type and
  length on the PUT.
- PII: `person-erasure-pii-columns.test.ts` classifies the inventory text
  columns (supplier contacts, actor ids, notes); logs in inventory code carry
  ids, codes and error names only (no names, emails or money).
- Inbound App routes, tick route auth: see the station report (timing-safe,
  strict, dedupe, flag handling).
