# Review 1b: inventory data integrity (area 6)

Branch pr/inventory @ 12b1ce67d. Read-only review. Every finding below was
verified by reading the code path; none needed a throwaway test (the arithmetic
ones are plain BigInt/Number.isSafeInteger behaviour).

Counts: blocker 0, high 0, medium 6, low 8.

Scope read: lib/inventory-write.ts, lib/chunked-in.ts,
services/inventory-{counts,receiving,orders,transfers,purchasing,waste,batch,prep,recipes,sales,tick,auto-sold-out,levels,items,settings,common}-service.ts,
routes/operator-inventory-{items,counts,purchasing,transfers,prep,orders,waste}.ts,
routes/pos-inventory.ts (delivery part), tenant-db drizzle 0033 to 0038
triggers, packages/inventory contract/cost/money.

---

## Medium

### D-1 (medium, confidence high) Mixed currencies are accepted and then mislabelled everywhere

- Where:
  `apps/tenant-api/src/services/inventory-purchasing-service.ts:1050-1056`
  (recordDelivery), `:1409-1412` (confirmDeliveryPrices),
  `inventory-items-service.ts:1109-1118` (bulk create `costMicro` + `currency`),
  vs. `inventory-recipe-store.ts:185-202` (`loadItemCosts` returns
  `currency: rows[0]?.currency`).
- What is wrong: the only currency guard is `cost.currency !== currency` over
  the costs of the items IN THE SAME DELIVERY. An item with no cost yet takes
  any 3-letter currency from the body (`currency` is `^[A-Z]{3}$`, nothing ties
  it to the org currency; confirm-prices does not even compare with the
  delivery's own `row.currency`). Bulk create takes `costMicro` + any `currency`
  per item with no check at all. The rest of the module assumes ONE currency per
  org: `loadItemCosts` returns the currency of the first row only, and `valueOf`
  (sales settle), `sendTransfer`, batch, `listItems.totalValueMinor`
  (`currency ??= first`), Today and food cost all label every value with that
  single currency.
- Scenario: org prices item A in SAR. A delivery of new item B is recorded with
  `currency: "USD"` (typo, a foreign supplier, a second client). B gets a USD
  cost row. From then on every sale/waste/transfer/batch movement of B is valued
  in B's USD micro-units but written with `currency: 'SAR'` (first row), and
  stock totals add SAR and USD minor units. Movements are append-only, so the
  wrong rows cannot be repaired.
- Fix: derive one org currency (first cost row, else `resolveInventoryCurrency`)
  and refuse any priced write (delivery, confirm-prices, bulk-create cost, typed
  cost) whose currency differs with 400 `currency_mismatch`; also compare
  confirm-prices `body.currency` with `row.currency`.
- Regression test: record a priced SAR delivery for item A, then a priced USD
  delivery for item B (no cost yet) -> expect 400 `currency_mismatch`; same via
  bulk create and via confirm-prices on a quantity-only delivery.

### D-2 (medium, confidence high; design level) Count approval adjusts against live on-hand, not the stock at counting time

- Where: `inventory-counts-service.ts:144-173` (`reviewData`:
  `expected = row.onHand` live), `:966-1010` (`approveCount`:
  `difference = target - line.expected`).
- What is wrong: entries are timestamped but never used. `expected` is the
  on-hand at the moment of review/approve. Anything that moved between counting
  an item and approving (sales settling, a delivery, waste, transfers) is
  re-adjusted away.
- Scenario: shelf count of 10 kg at 10:00, 20 kg delivery received 14:00,
  manager approves at 18:00. expected = 30, counted = 10, the approval posts a
  -20 kg adjustment and wipes the delivery. Same with sales after the count: 4
  sold after counting, approval posts +4, stock overstated by 4.
- Fix: snapshot expected per item when the count starts or at each item's first
  entry (store on the entry/count), or compute expected as "on hand at the
  entry's `createdAt`" and add movements since; at minimum take the review
  expected from `movements <= entry.createdAt` and show later movements
  separately.
- Regression test: start count, enter 10, record a delivery of 20, send for
  review and approve -> on hand must be 30, not 10.

### D-3 (medium, confidence high) Deliveries have no business-level idempotency; the 48h key TTL is a duplicate-stock hole (Station offline queue)

- Where: `lib/inventory-write.ts:44,175-186` (TTL 48h; an expired key is simply
  re-executed and overwritten), `inventory-purchasing-service.ts:1089-1109`
  (`inv_deliveries` has no client id column), `eventKey: delivery:${lineId}`
  with `lineId = newId()` (not deterministic),
  `routes/pos-inventory.ts:465-472`.
- Compare: batch has a deterministic event key and answers
  `idempotency_conflict` on reuse after expiry
  (`inventory-batch-service.ts:117-123`), waste/count entries/orders/transfers
  have unique client ids, items/areas/suppliers have unique names, counts have
  the one-open-count rule. Deliveries are the one money-and-stock create with
  nothing behind the 48h key.
- Scenario: Station posts a delivery, the server commits, the response is lost,
  the tablet goes offline. The queue retries more than 48h later (Station
  explicitly supports `lateSync` beyond 48h). The key row is expired, so a
  second delivery is created: stock and cost double.
- Fix: add `client_id` (unique) to `inv_deliveries` or use a deterministic line
  event key `delivery:<clientId>:<index>`, and on a hit with an expired key
  answer `idempotency_conflict` (as batch does) or replay.
- Regression test: record delivery with clientId X, advance the clock 49h,
  replay the same body -> expect no second delivery (409 or the first result).

### D-4 (medium, confidence high) Unbounded money inputs on deliveries turn into 500s and can poison the stock lists

- Where: `packages/inventory/src/contract/purchasing.ts:175-196`
  (`lineTotalMinor`, `packPriceMinor`, `vatMinor`, `totalMinor`:
  `z.number().int().min(0)` with no max; the module's own `inventoryMinorSchema`
  (max 1e12) is not used), `confirmDeliveryPricesSchema` same;
  `packages/inventory/src/cost.ts:51-60,86` (`toSafeNumber` throws a plain
  `RangeError`), `routes/...` `inventoryErrorResponse` rethrows non-Inventory
  errors.
- What is wrong: `costMicroFromPackPrice(lineTotal, quantity)` = lineTotal * 1e9
  / quantity. Any lineTotal above about 9e6 minor with quantity 1 (0.001 g)
  overflows 2^53 and throws RangeError -> HTTP 500 instead of 400. Worse, a
  value that fits (avg cost near 9e15 micro) is persisted in `inv_item_costs`;
  later `inventoryValueMinor(onHand, avgCost)` in
  `listItems`/`loadLocationStock`/Today throws RangeError for every read once
  onHand * cost exceeds 9e15 * 1e9, so `GET /items` for that location 500s. Sums
  of `value_minor` of 9e15-sized rows overflow SQLite int64 after about 1000
  rows ("integer overflow" in `sum()`).
- Scenario: a write-grant token (or a Station-confirmed price typo) records one
  absurd line; the whole location's stock list or Today then returns 500 until
  someone with DB access fixes it (movements/delivery lines are append-only).
- Fix: cap all money inputs with `inventoryMinorSchema`, cap `costMicro` in bulk
  create, map `RangeError` from cost math to 400 `invalid_request`, and make
  `stockValueMinor` clamp or catch instead of throwing on reads.
- Regression test: POST /deliveries with `lineTotalMinor: 9e15, quantity: 1` ->
  400 (not 500); bulk create with `costMicro: 9e15` -> 400.

### D-5 (medium, confidence medium) Without a reservations settings row every business date is UTC with a 04:00 day start

- Where: `inventory-common.ts:97-114` and `:131-155` (`locationBusinessDate`,
  `locationClock`), `rsvLocationSettings` rows are only created by reservations
  setup (`services/rsv-setup-service.ts`, `rsv-setup-crud.ts`).
- What is wrong: inventory has no time zone of its own. An org that uses
  Inventory but not Reservations gets business date = UTC minus 4h for counts
  (one-per-day `count_due`), waste, deliveries, food cost windows, prep
  generation ("from 07:00 local") and supplier cut-offs. For a US location the
  day rolls over at about 23:00 to 00:00 local; for Riyadh at 07:00 local.
- Fix: read a time zone from a source inventory controls (inventory setting, or
  the staffing time zone the control plane already keeps) and refuse or warn in
  `/status` when none is set.
- Regression test: location with no rsv settings, `now` = 23:30 America/New_York
  -> business date must be that day.

### D-6 (medium, confidence high) sendOrder emails the supplier outside the lock and the transaction: concurrent sends duplicate the email, and a failed commit leaves it sent

- Where: `inventory-orders-service.ts:1128-1200` (version/status check on a
  plain `db` read, email sent, only then `withInventoryWrite` re-checks).
- Scenario: double click or two tabs with the same `expectedVersion` both pass
  the pre-check, both email the supplier, the second then fails `stale_version`
  in the transaction. The supplier gets two orders; the user sees an error. Also
  a transaction failure after a successful email leaves a draft order that was
  already emailed. A resend of a `sent` order never changes the version, so
  there is nothing to stop repeated emails (no rate limit on this outbound email
  either, to an address an operator typed on the supplier).
- Fix: claim the send first (transaction that moves draft to sent and records an
  outbox/sending marker), then deliver the email after commit with its own
  idempotency, or take `runExclusive` around check+send; rate-limit resend per
  order.
- Regression test: two concurrent `sendOrder` with the same expectedVersion and
  channel email -> exactly one `sendTenantEmail` call.

---

## Low

### D-7 (low, confidence high) Bulk item create accepts starting costs without the cost grant and without currency consistency

`inventory-items-service.ts:1109-1118`; route `operator-inventory-items.ts:78`
only needs `update:inventory:any`. A token with no `read:inventory_cost:any` and
no purchasing grant can write an item cost (`costMicro`, any `currency`) that
then drives every valuation. Fix: require the cost grant (or purchasing) for
`costMicro`; see D-1 for currency.

### D-8 (low, confidence high) `inv_idempotency_keys` is never pruned and stores full response JSON forever

`lib/inventory-write.ts:203-211` writes `responseJson` (delivery details with
money for `c1` scopes, actor ids, names); only reads check `expiresAt`. No
delete anywhere (`grep invIdempotencyKeys`). Unbounded growth per org Durable
Object and long-lived copies of money/actor data (relevant to erasure). Fix:
prune expired rows in the hourly tick (like `pruneInventoryOutbox`) and exclude
the key rows from erasure gaps.

### D-9 (low, confidence high) Order is not reopened and not re-receivable after its delivery is cancelled

`inventory-purchasing-service.ts:1533-1620` (documented in the header):
cancelling the delivery that closed an order leaves the order `received`; its
lines now read as unreceived, but `order_closed` blocks receiving against it.
Also cancelling a delivery that was marked paid keeps `paid_at`, and does not
rewind `avg_cost_micro` (documented). Fix: allow `received -> partly_received`
on cancel via an explicit rule (the trigger `inv_orders_closed_final` forbids it
today, so it needs a trigger change) or document and refuse cancel when the
delivery closed an order.

### D-10 (low, confidence high) `restore` item bypasses the 5000 item limit

`setItemArchived` (`inventory-items-service.ts:860-897`) does not call
`assertItemLimit`. Archive 5000, create 5000, restore all -> 10000 active items;
`loadLocationStock` loads the whole catalogue per list/Today call. Fix: check
the limit on restore.

### D-11 (low, confidence medium) Count `liveKey` includes the entered unit, so a correction in another unit double counts

`inventory-counts-service.ts:68-76`. The wire contract
(`contract/counts.ts:101-103`) says the counter's latest entry per item and area
wins; the code keeps the latest per item, area, counter AND unit (multi-unit "2
boxes and 3 kg" is intended in the plan). Counter enters 5 kg then corrects to
5000 g: both stay live, counted = 10 kg. The clear (`amount: null`) also only
clears the same unit. Fix: clear/override entries across units for the same
item/area/counter, or make the client always send the clearing entry for the
other unit; align the doc.

### D-12 (low, confidence medium) Station `madeAt` has no lower bound

`contract/station.ts:276,644` (`z.number().int().positive()`);
`receivedAt = Math.min(madeAt, now)` (`purchasing:1081`), waste
(`inventory-waste-service.ts:155-158`), batch/prep use it for `business_date`. A
tablet with `madeAt: 1` writes 1970-01-01 business dates (flagged `lateSync`, so
visible, but it distorts food-cost and daily reports and cannot be undone:
append-only). Fix: refuse `madeAt` older than a cap (for example 30 days) with
`refused: stale`.

### D-13 (low, confidence medium) Auto sold out calls the App on the write and settle path with an 8 s timeout and no back-off

`lib/inventory-write.ts:238-241` runs `syncAutoSoldOut` after every inventory
write (and after every sale settle via `settleInventorySource`);
`lib/inventory-availability.ts:49` aborts after 8 s. While the App is
unreachable and something is waiting to be taken off the menu, every write and
every settled sale waits up to 8 s (rows are only recorded when the App
confirms). `onHandByItem` also sums the whole movement ledger per location per
call. Fix: short circuit-breaker (remember `retry` until a timestamp) and move
the call to `afterCommit`/waitUntil.

### D-14 (low, confidence medium) Org-wide settings (`anyStaffCanReceive`, target food cost, unit system) can be changed by a location-restricted write token

`operator-inventory.ts:62-87` guards with write+`update:inventory:any` only; no
`locationIds === null` requirement. A manager limited to one location flips a
setting that applies to all locations (and lets Station staff record
deliveries). Same for catalogue edits (items are org-wide by design). Fix:
require an unrestricted token for settings.

### D-15 (low, confidence medium) `createTransfer`/`createOrder` accept any location id string

Region has no location list. For tokens with `locationIds: null` an invented
`fromLocationId`/`toLocationId` creates stock movements at a location that does
not exist in the control plane. `createTransfer` also returns an existing
transfer for a reused `clientId` before checking hash/location
(`inventory-transfers-service.ts:337-343`); `viewOf` then applies the location
check, so no data leaks, but a different body silently returns the old record
instead of `idempotency_conflict`.

---

## Checked, no finding

- Durable Object 100-parameter limit: every `inArray(` over data-sized lists in
  the listed services goes through
  `queryInChunks`/`forEachInChunks`/`insertRowsInChunks` (90 ids, plus at most a
  few other binds); the status `inArray`s are fixed 2-3 values. No raw `IN (`
  over data lists (only `inJsonList`).
- Append-only triggers: `inv_movements`, `inv_count_entries`, `inv_waste`,
  `inv_delivery_lines`, `inv_audit_log` block UPDATE/DELETE except the
  documented note-erasure (movements, waste) and the one-time priced_at update;
  `inv_orders` (closed final, forward only, identity fixed, kept),
  `inv_order_lines` frozen outside draft, `inv_transfers` (forward only, closed
  final), `inv_transfer_lines` (frozen, no insert/delete once sent),
  `inv_recipes`/lines (append-only, superseded once) all hold. `inv_outbox.id`
  is a text UUID, so event keys `sale:<outboxId>:...` cannot collide after
  pruning.
- Double approval of a count: status checked inside the transaction under the
  org lock, `inv_counts_closed_final` trigger, and `count:<countId>:<itemId>`
  unique event key.
- Double receive / transfers: `receiveTransfer` requires status `sent`,
  closed-final trigger and `transfer:<id>:in:<item>` event keys; `over_received`
  refused; send/receive/cancel check the right end's location; duplicate items
  per transfer refused (schema and unique index).
- Waste undo: once only (`uniq_inv_waste_reverses` + `already_undone`), window,
  station own-entry rules, location check.
- Version checks run inside `withInventoryWrite` (per-org in-process lock plus
  one transaction), so no lost update; only the sendOrder pre-check is outside
  (D-6).
- Prep done/start/skip: idempotent, record batch joins the same transaction,
  replay after expiry returns `task_closed`; batch itself answers
  `idempotency_conflict` on an expired-key reuse.
- Sale settle: row claimed implicitly (unsettled row read inside the
  transaction), diffs applied against `inv_sale_usage`, deltas keyed by outbox
  id, failures back off, never refuse a sale.
- Record-addressed routes check the record's own location: counts
  (`loadAllowedCount`), deliveries (`loadAllowedDelivery`), orders
  (`loadOrderRow`), transfers (`loadTransfer`/ends), waste undo, prep tasks
  (`loadTask`), sold-out undo, places/areas/lists. List endpoints all require a
  checked `locationId`.
- Pagination: delivery/count/transfer/movement lists use a keyset cursor with
  limit; `listItems` and `loadLocationStock` load the whole catalogue (bounded
  by the 5000 item limit, see D-10).
- Cancel delivery reversal math: priced, unpriced and price-confirmed lines net
  to zero value and quantity; last cost is rewound to the latest remaining
  priced delivery.
