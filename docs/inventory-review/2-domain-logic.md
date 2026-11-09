# Review 2: domain correctness of the inventory module (pr/inventory @ 12b1ce67d)

Reviewer: read-only. Nothing in the repo was edited, staged or committed. One
throwaway vitest file was created inside `apps/tenant-api/src/services/`, run,
then deleted (`git status` afterwards shows only the other session's three
modified files: `apps/tenant-api/workers/tenant-org.ts`,
`packages/database/src/env.ts`, `packages/tenant-db/src/migrations.ts`). A copy
of the proof tests is at
`/private/tmp/claude-501/-Users-zama-menuza/e3a77db0-8812-4ce7-bae0-1ccf5cd0b702/scratchpad/zz-review-domain.test.ts.txt`
(rename to `.test.ts` and drop it in `apps/tenant-api/src/services/` to re-run:
`cd apps/tenant-api && npx vitest run src/services/zz-review-domain.test.ts`).

Result of the proof run: PROOF-A, B, C, D, E, F, H, I all behave as described
below (they assert the buggy behaviour and passed).

## Coverage honesty

Read in full: `units.ts`, `cost.ts`, `money.ts`, `contract/rules.ts`,
`contract/orders-rules.ts`, `prep.ts`,
`engine/{usage,expand,sale-lines,plate-cost}.ts`, `inventory-sales-service.ts`,
`item-sales.ts`, `inventory-food-cost.ts`, `inventory-counts-service.ts`,
`inventory-receiving-service.ts`, `inventory-batch-service.ts`,
`inventory-recipe-store.ts`, `inventory-auto-sold-out.ts`,
`inventory-today-service.ts`, `inventory-dish-waste-service.ts`,
`inventory-common.ts`. Read in part: `inventory-purchasing-service.ts`
(deliveries, confirm, cancel, currency), `inventory-orders-service.ts`
(suggestions, on-order, numbering, supplier choice),
`inventory-items-service.ts` (stock rows, adjust, flags),
`inventory-transfers-service.ts` (send, receive, cancel),
`inventory-prep-service.ts` (plan, generate), `inventory-levels-service.ts`
(suggest), `inventory-waste-service.ts` (summary, undo),
`inventory-recipes-service.ts` (costs). NOT reviewed (time):
`inventory-tick-service.ts`, `routes/inventory-tick.ts`,
`pos-inventory-service.ts`, `inventory-compare-service.ts`,
`inventory-sold-out-service.ts`, `inventory-places/settings`,
`inventory-invoice-read-service.ts`, `inventory-recipes-service.ts` write paths,
the App-side forms except where cited. Node 22.18 verified: `Intl`
`en-u-ca-islamic-umalqura` month 9 detection works (2026-02-18..2026-03-19 are
month 9; 2027-02-08..2027-03-08 likewise). Workers not verifiable here;
`hijriMonth` degrades to `null` (not Ramadan), safely.

---

## HIGH

### H1. Recording a batch (or finishing a prep task) for a made item that is NOT "counted in batches" takes its ingredients out twice

- Confidence: high (PROOF-A).
- Where: `apps/tenant-api/src/services/inventory-batch-service.ts:60-197` (no
  `batchCounted` check), `inventory-prep-service.ts:341-413` (`generatePrep`
  plans every non-archived made item with a level, regardless of
  `batchCounted`), `packages/inventory/src/engine/expand.ts:157` (a not-counted
  made item is expanded into its ingredients at sale time).
- What is wrong: with the switch OFF the plan says sales use the item's
  ingredients directly. But Prep (and "Record a batch") for that same item still
  posts `batch_used` (ingredients out) and `batch_made` (item in). The dough
  that was made is never consumed (sales go to flour), so the ingredients leave
  stock once at batch time and again at sale time, and the made item's on-hand
  grows forever (it then never looks low, so Prep stops suggesting it).
- Repro (numbers from the run): flour 50,000 kg-thousandths; dough (made, switch
  off) recipe = 1000 g flour makes 2000 g; pizza = 300 g dough. Sell 4 pizzas:
  flour 50,000,000 -> 49,400,000 (600 g, correct). Record 1 batch: flour ->
  48,400,000 (another 1000 g), dough on hand +2,000,000 with nothing ever taking
  it out. Same dough is paid for twice.
- Fix: either refuse `recordBatch` / skip the item in `generatePrep` /
  `donePrepTask` unless `item.batchCounted` (409 `not_counted_in_batches`), or
  make a recorded batch for a not-counted item a no-stock "made" event. Prep UI
  should offer the switch when you add a level for a made item.
- Regression test: service test "recordBatch on a not-batch-counted made item is
  refused", and a property test: for any sequence of {sale, batch}, ingredient
  usage equals sales usage when switch off, batch usage when on, never the sum.

### H2. Batch-counted made items drop out of food cost: the value created by `batch_made` never leaves the ledger

- Confidence: high (PROOF-B, real services, real `computeFoodCost`).
- Where: `inventory-batch-service.ts:187-197` (made item gets
  `valueMinor = sum of ingredient values` but its own average cost is "not
  updated here"), `inventory-sales-service.ts:468-479` (`valueOf` returns null
  when the item has no average cost, so sales/waste/count adjustments of the
  made item carry no value), `inventory-food-cost.ts:85-113` (food cost is
  derived from summing `value_minor` of the ledger).
- What is wrong: food cost = opening + purchases - closing, and every term is a
  sum of `value_minor`. Algebraically that equals minus the value of all
  non-purchase movements in the period. A batch posts ingredient value -V and
  made-item value +V (net 0). When the made item is then sold, wasted or counted
  away, those movements are value-less, so the +V is never offset. Net effect:
  the cost of every batch that is sold is excluded from food cost.
- Repro (run): flour delivery 50 kg for 1000.00; two approved full counts; one
  batch (1000 g flour -> 2000 g dough, ledger -2000/+2000); sell 4 pizzas (1200
  g dough, value null). `computeFoodCost` returned
  `{ openingMinor: 100000, purchasesMinor: 0, closingMinor: 100000, salesMinor: 40000, bp: 0 }`:
  food cost 0% although 600 g flour (1200 minor) was sold. For a pizzeria whose
  dough is batch-counted, the biggest ingredient cost vanishes from the headline
  number and from Today/compare.
- Fix: give made items a cost. Simplest: in `recordBatch`, update
  `inv_item_costs` for the made item with a weighted average over its on-hand
  (value of batch / madeQuantity), so later sales/waste/counts are valued. Also
  value the made item's movements from the batch's own cost when no average
  exists. Alternative: compute food cost from usage valued at read time rather
  than from the sum of stored ledger values.
- Regression test: the PROOF-B scenario asserting `used > 0` and equals 1200
  minor; plus a property: for any mix of batch/sale/waste/count, food cost used
  equals the sum of leaf-ingredient value consumed.

### H3. A fresh organization's first quantity-only delivery is stamped USD, and confirming prices then records all money in USD with no way out

- Confidence: medium-high (stamp proven by PROOF-H; the lock-in follows from the
  code below).
- Where: `inventory-purchasing-service.ts:882-904` (`resolveInventoryCurrency`:
  existing cost currency, order, supplier, then
  `rsv_location_settings.currency`, then literal `'USD'`; the reservations
  column defaults to `'USD'` at `packages/tenant-db/src/schema.ts:4061`),
  `inventory-purchasing-service.ts:1045-1056,1410-1411` (`currency_mismatch` is
  then enforced against the first cost), App
  `purchasing.deliveries.$deliveryId.tsx:176,476` and
  `confirm-prices-dialog.tsx` (the dialog has no currency field; it labels and
  submits `delivery.currency ?? ctx.currency`, and `delivery.currency` is the
  non-null USD stamp, so the App's own fallback never runs).
- Failure scenario: a SAR restaurant (no supplier chosen or supplier without
  currency, no order, no reservations row for the location, no priced delivery
  yet) receives goods on Station. Delivery gets `currency: 'USD'`. The manager
  confirms prices; the dialog shows "(USD)" labels and submits
  `currency: 'USD'`. Every item cost, movement, count adjustment and food cost
  is now USD and every later SAR delivery is refused `currency_mismatch`. There
  is no currency change path.
- Fix: do not invent USD. Leave `currency` null on an unpriced delivery, and
  have the confirm dialog require/choose a currency (default to the
  organization's money currency from the control plane, which the App knows).
  Also reject a priced delivery whose currency differs from the organization's
  established currency (see M7).
- Regression test: quantity-only delivery with no sources leaves `currency`
  null; confirm with no currency is 400; confirm in SAR on a fresh org works.

### H4. Cancelling a delivery does not rewind the weighted average (the report's "known gap" is serious)

- Confidence: high (PROOF-C).
- Where: `inventory-purchasing-service.ts:1626-1717` (`cancelDelivery`: only
  `lastCostMicro` is restored; `avgCostMicro` is left).
- What is wrong: the main reason to cancel a delivery is a price typo, and the
  typo stays in the average.
- Repro (run): 10 L at 1.0/ml on hand, then a typo delivery of 10 L at 10.0/ml:
  average 5,500,000 micro (5.5/ml). Cancel it: stock back to 10 L, last cost
  1,000,000, but the average stays 5,500,000, 5.5x too high. Until the stock
  turns over, every sale, waste, count adjustment and transfer for that item is
  valued at the typo price (so food cost, waste value and stock value are
  inflated), and nothing lets the owner fix it. If the delivery was the item's
  first, the average resets only because on hand is 0 at the next delivery.
- Fix: on cancel, recompute the average deterministically from the remaining
  priced delivery lines in order (replay `weightedAverageCostMicro` over
  non-cancelled priced delivery lines and the on-hand at each point), or reverse
  the step: avg' = (avg*(onHand) - cost*q)/(onHand - q) when onHand - q > 0,
  else the previous known average (store a per-delivery "average before" on the
  line at record time; that is exact and cheap).
- Regression test: record 10 @ 1, record 10 @ 10, cancel the second: average
  equals 1 exactly; same through quantity-only then confirm then cancel.

---

## MEDIUM

### M1. Count approval compares the physical count with the CURRENT ledger, not the ledger at counting time

- Confidence: high on the code, medium on real-world frequency (PROOF-E).
- Where: `inventory-counts-service.ts:144-174,975-1019` (`expected = row.onHand`
  read at review/approve time).
- Failure: 10 kg rice counted at 22:00; 5 kg arrives at 06:00 (recorded);
  manager approves at 09:00. Expected 15 kg, counted 10 kg, adjustment -5 kg:
  stock reads 10 kg while 15 kg sits on the shelf (the run shows on hand
  10,000,000 and `adjustedItems: 1`). The reverse: sales between counting and
  approval are "put back" (stock goes up by what was sold since). Entries are
  timestamped (`inv_count_entries.created_at`), so the information to do it
  right exists. Station counts that sync late make it worse.
- Fix: snapshot expected per item at the first entry (or at count start) and
  post `counted - expected_at_entry_time + movements since` (i.e. adjust by
  `counted - (onHandNow - movementsAfterEntryTime)`), or freeze movements
  between "send for review" and approval.
- Regression test: counted at t0, delivery at t1, approve at t2: on hand after
  approval = counted + delivery.

### M2. Auto sold out gives dishes back when the count merely ages past 7 days while stock is still zero

- Confidence: high (PROOF-D).
- Where: `inventory-auto-sold-out.ts:257-267` (the "counted within 7 days" gate
  is part of the ongoing condition), restore at `273-276`.
- Failure: chicken counted at 0, dishes taken off. Seven days pass with no
  delivery and no new count; the hourly sync sees `countedAt < now - 7d`, the
  item is no longer "out", and the dishes are given back to the menu with zero
  stock. The 7-day gate is meant only to stop estimates from taking dishes OFF.
- Fix: apply the count-age gate only when adding; keep an `out` row until the
  item's on-hand is above zero (or its switch/flags go off).
- Regression test: add after the existing "drifting estimate" test: sold out,
  advance 8 days, stock still 0 -> nothing restored.
- Related (design caveat, low): the gate is "was in an approved count in the
  last 7 days" and entries cleared with `amount: null` also count
  (`lastCountedMap` / `lastCountedAt` join `inv_count_entries` regardless of
  `entered_amount = ''`), and a count 6 days old plus six days of recipe-based
  depletion is still an estimate.

### M3. Food-cost period boundaries are not aligned with the ledger window

- Confidence: medium.
- Where: `inventory-food-cost.ts:97-118`: the ledger window is
  `(opening.approvedAt, closing.approvedAt]` but sales are read for business
  dates `opening.businessDate + 1 .. closing.businessDate`, and a count's
  `business_date` is the date it was STARTED
  (`inventory-counts-service.ts:428`).
- Failure: counts done before opening (morning): consumption covers days D0 ..
  D1-1 but sales cover D0+1 .. D1 (off by a day: same-weekday counts mostly
  cancel, irregular intervals do not). Count started 23:30, approved 00:40 next
  business day: `business_date` is the start day while the ledger window runs
  into the next day. Sales settled late (outbox retry) land in the next period
  because `created_at` is settle time, while their business date is the sale's.
- Fix: window sales by the same instants as the ledger (sale time between
  `opening.approvedAt` and `closing.approvedAt`) or define both by business
  date, and store `business_date` of the approval, not of the start.
- Regression test: counts at 08:00 on D0 and D7 with identical daily sales: food
  cost equals consumption/sales of D0..D6 exactly.

### M4. Dish food-cost % and "price for target" ignore VAT-inclusive menu prices

- Confidence: high on missing handling, medium on prevalence (locations have a
  "prices include tax" setting, `apps/app/app/utils/location/tax-settings.ts`).
- Where: `inventory-recipes-service.ts:723-735`
  (`dishFoodCostBp(ref.priceMinor, cost)`),
  `packages/inventory/src/engine/plate-cost.ts:191-212`, App
  `recipe-panel.tsx:217`. No tax appears anywhere in the recipe path, while the
  period food cost (`item-sales.ts:213-247`) does strip tax from tax-inclusive
  sales. The two definitions disagree.
- Failure: SAR 40.00 dish, tax-inclusive 15%, plate cost 10.00: shown as 25.0%
  but real food cost vs net price is 28.75%; "price for 30%" suggests 33.33 net,
  while the menu price must be 38.33.
- Fix: pass the location's tax rate and `pricesIncludeTax` to `recipeCosts` and
  compute against the net price; `priceForTargetMinor` should add tax back.
- Regression test: tax-inclusive 15% price 4000, cost 1000 -> 2875 bp.

### M5. Level suggestions ignore ingredients used by batches and transfers, and divide by the location's age instead of the item's

- Confidence: high (PROOF-I).
- Where: `inventory-levels-service.ts:254-268` counts only
  `kind in ('sale','waste')` and negative `count`; `daysObserved` (line 272) is
  `min(days, today - min(business_date of ANY movement at the location))`.
- Failure: with a batch-counted dough, all flour consumption is `batch_used`:
  the run recorded 3 batches and `suggestions: []` for flour. An item added
  yesterday at a location running 28 days has its 1-day use divided by 28 days
  (28x too low). `adjustment` shortfalls and `transfer_out` are never "use".
- Fix: include `batch_used` (and optionally `transfer_out`); per-item
  observation start (first movement of that item).
- Regression test: item with only `batch_used` movements gets a suggestion; new
  item gets use / its own days.

### M6. "On order" can stay phantom forever: unlinked deliveries and stale sent orders suppress suggestions

- Confidence: medium (code reading, not run).
- Where: `inventory-orders-service.ts:483-510` (`onOrderByItem`) sums
  outstanding of every `sent`/`partly_received` order with no age limit; an
  order only closes when a delivery is linked (`orderStatusAfterReceipt`) or
  someone closes/cancels it. Station receipts that are not linked
  (`lenientOrder`, `orderLinkIgnored`) add to `on hand` but leave the order's
  quantity outstanding. `buildSuggestedOrders` (line 556-563) then counts the
  same goods twice (`have = onHand + onOrder`) and under-orders.
- Fix: when a delivery arrives unlinked from the same supplier, offer/auto link
  to the one open order; age out `onOrder` past `expectedDate + N days` (show as
  "overdue" instead of counting it).
- Regression test: sent order of 10 kg, unlinked delivery of 10 kg, suggestion
  must reflect on hand 10 and on order 0 (or the order closed).

### M7. One currency per organization is assumed everywhere but enforced nowhere

- Confidence: medium-high.
- Where: `inventory-purchasing-service.ts:1052-1056` rejects a mismatch only
  against the costs of the items in THIS delivery; a new item can be priced in
  another currency. `resolveInventoryCurrency` (line 890) picks "first" cost row
  with `limit(1)` and no order by; `inventory-recipe-store.ts:201`
  (`currency: rows[0]?.currency`) and `inventory-food-cost.ts:11-43` take the
  first currency and `ledgerSum` adds `value_minor` of every currency.
- Failure: one delivery of a new item in USD in a SAR org: stock value, plate
  cost (typed costs "in another currency are not used"), waste and food cost
  silently mix halalas and cents.
- Fix: record the organization's inventory currency once (first priced delivery)
  and refuse any other (400 `currency_mismatch`), or key every sum by currency.
- Regression test: item A priced SAR, item B delivery priced USD -> 400.

### M8. `confirmDeliveryPrices` derives "stock before this delivery" from today's on-hand

- Confidence: medium (code reading).
- Where: `inventory-purchasing-service.ts:1430-1448`:
  `max(0, onHandNow - deliveredQuantity)`. Quantity-only goods are usually used
  before the invoice is priced, so on-hand-now minus the delivery floors at 0
  and the average becomes the new price only, discarding the cost of older
  stock. Meanwhile every sale between delivery and confirmation was valued at
  the old (or no) average.
- Example: 10 kg at 5 on hand, 20 kg arrives quantity-only, 25 kg sold, 5 kg
  left, price confirmed at 8: stock-before = max(0, 5-20) = 0 -> average 8
  (should weigh 10 kg at 5 first).
- Fix: compute the average at confirmation from the quantity on hand at the
  delivery time (sum of movements up to the delivery's `created_at`), the same
  as `recordDelivery` would have.

---

## LOW

- L1. Transfers: "missing in transit" disappears. `transfer_out` is valued at
  the sent quantity, `transfer_in` at the received quantity
  (`inventory-transfers-service.ts:526-536, 616-619`); the difference is neither
  waste nor a purchase at either place, so shrink in transit is in no food cost
  or waste figure. Suggest a `waste`-like movement at the sender (or an explicit
  "lost in transit" value on the compare screen).
- L2. Net sales (food-cost denominator) do not subtract refunded money: a
  refunded Station sale stays in `readItemSales` at full subtotal
  (`item-sales.ts:439-481`, `posOrderNetMinor` ignores `refundedCents`) and web
  refunds are not read either. Food is made, so cost stays, but revenue was
  returned: % understated by refund share.
- L3. Count counters add up: two people counting the same item in the same area
  are summed (`liveKey` includes counter; `countedTotals`). The plan says that
  is intended for different shelves, but a double count of one shelf doubles the
  quantity and the review flags it only as a big difference. A different unit
  typed for the same area adds rather than replaces (`liveKey` includes
  `enteredUnit`): correcting "5 kg" by typing "4500 g" gives 9.5 kg.
- L4. `batchCounted` is read at settle time, not at sale time. After flipping
  the switch, a revised (not cancelled) old sale moves usage between made item
  and ingredients wrongly (`expand.ts:157`, `buildRecipeStore` facts are
  current). Cancels are safe (desired is zero). Suggest snapshotting the
  expanded leaf usage on the sale (`inv_sale_usage` already stores per-item
  quantities) and diffing against that on revision only for changed lines.
- L5. Reversals are valued at today's average, not the original value
  (`inventory-sales-service.ts:563-575`): cancelling a sale after the average
  moved leaves a residual in the ledger that food cost reads as consumption.
  Store `valueMinor` per sale usage row and reverse at that value.
- L6. `costMicroFromPackPrice(1_000_000_000_000, 1)` throws `RangeError`
  (PROOF-F; `lineTotalMinor` is `int().min(0)` with no max in
  `contract/purchasing.ts:187`) which is not an `InventoryError`, so the route
  answers 500 for an oversized line. Add `.max(INVENTORY_MAX_MINOR)` and map
  RangeError to 400 `amount_out_of_range`.
- L7. Prep demand history for tomorrow's plan includes today's partial day
  (`inventory-prep-service.ts:100-104`, `toDate = date - 1`): today's incomplete
  sales pull the all-days mean down (bias is small).
- L8. `REVIEW_DIFFERENCE_MIN_MINOR = 2500` is "25 major units" only for
  two-decimal currencies (KWD/BHD 3 decimals: 2.5; JPY: 2500 yen).
- L9. Supplier product price defaults to `'USD'` when the supplier has no
  currency (`inventory-purchasing-service.ts:494,556`) and the App shows
  `product.currency ?? currency` (`supplier-products.tsx:160`), so the App's own
  org-currency fallback never fires. Suppliers require a currency on create, so
  only imported/legacy suppliers hit it.
- L10. "Piece with an average weight" (plan, Units) is not built: no column or
  conversion exists, recipes in grams for a piece item are `unit_mismatch`.
- L11. A QR tab rung up on Station is excluded from the web reader and is
  counted only through the Station sale (`inventory-sales-service.ts:336-337`,
  `item-sales.ts:373`): if that till sale is later voided/open, the tab's food
  counts nowhere while it was made. Edge case.
- L12. Kitchen "Log it as waste?" and a `quality` line-void on the same dish are
  two independent waste writes with different keys (`void:<id>:<item>` vs
  `<clientId>:<n>`): possible double waste if both fire.

## Checked and found sound (so you can stop worrying)

- Thousandths and micro-minor arithmetic: BigInt everywhere in `cost.ts`,
  half-up rounding symmetric for negatives, `toSafeNumber` guards. Standard unit
  factors are exact (oz, lb, fl oz, qt, gal) and round trips stay within half a
  thousandth. Named units can never change size (no update path exists).
  `Math.round(amount * factor)` has float edge cases only below a thousandth.
- Weighted average: floors negative stock, delivery with no stock takes the
  price, `average` never leaves [min, max] of the two inputs. Same-delivery
  duplicate items average sequentially (the movement insert order is right).
- `diffUsage`/`applyUsageDeltas` convergence, replays, revisions, cancels, voids
  and refunds (refund keeps stock out, `quality` void becomes one waste once per
  void id). The settle feeds raw JSON through `parseSaleLines` (option quantity
  per dish), not `parseSoldLines`: the known trap is avoided. Eventkeys use a
  UUID outbox row id, so pruning cannot collide.
- `needsOrder` / `suggestOrderQuantity` rounding up (float `ceilDiv` is exact
  for the ranges allowed), half-pack steps for weight packs, order numbering
  inside the write lock, cut-off arithmetic is calendar-date only (no DST bug;
  `cutoffPassed` compares local "HH:MM" strings with a 59-second grace).
- Priced-by-weight 95% rule is consistent between `orderLineComplete`,
  `creditLines` and `orderStatusAfterReceipt`; credit text carries no money.
- Prep math: factor clamp 0.5x-2x, 7 days / 2 same-weekday minimum, Ramadan
  windows compare like with like, rounding up to batches, refresh only touches
  `todo` tasks.
- Hooks at sale call sites queue in the sale's transaction and settle after
  commit; a paid sale is never refused (queue/settle never throw).

## Test gaps (suggested additions, beyond those named per finding)

1. `cost.test.ts`: add `costMicroFromPackPrice` at the extremes (price 1 /
   quantity 9e9 -> 0 micro; price 1e12 / quantity 1 -> RangeError mapped), and a
   "cancel replay" property for the average (H4).
2. `engine/properties.test.ts` tests the pure engine only. Add a service-level
   property test over {delivery, cancel delivery, sale, batch, waste, count,
   transfer} sequences asserting: on-hand equals the sum of movements, ledger
   value equals on-hand x average within rounding (this would have caught H2 and
   H4), and food cost equals valued consumption.
3. `inventory-auto-sold-out.test.ts`: age-out while still zero (M2); two items
   flapping across the 7-day edge.
4. Counts: movements between entry and approval (M1); two counters on one shelf;
   mixed unit re-entry.
5. Food cost: morning counts vs evening counts, late settle, refund,
   tax-inclusive sales, made-item batches (H2), and `truncated` sales (the flag
   is ignored by `computeFoodCost`).
6. Orders: unlinked delivery against a sent order (M6); overdue order aging.
7. Prep: prep done on a not-batch-counted made item (H1); tomorrow's plan with
   partial today.
8. DST: `locationClock` around the two transitions for a supplier with a 00:30
   cut-off (pure rules are date-only, so this belongs in the service test).
9. Levels: item with only `batch_used`, item newer than the window (M5).
