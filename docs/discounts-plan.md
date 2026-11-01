# Discounts and coupons: plan

Status: phases 1 to 3 are built on `pr/discounts` and not merged yet. Research
current as of 30 October 2026 (`main` at `ad2526f7d`). Modelled on Square
discounts and Owner.com coupons.

**Built:** the engine (`@repo/discounts`, including meal deals, modifier
discounts, sizes, spend and tier ladders, stacking by kind, free-delivery fee
limit); control-plane migration `0031_discounts` and regional migrations
`0026_discounts` and `0027_discount_marketing_codes`; the App editor
(`discounts+/` routes, usage token, item and variant exclusions, order detail
lines); the order context fields; `POST /orders/quote`, placement, free orders,
the redemption lifecycle and refunds; loyalty applying after discounts; QR tab
discounts (view, counter close, phone payment); Sites checkout, tab payment and
public menu promotions; customer app menu promotions (the app hands checkout to
the website); Station till rules in the catalog download, automatic and manual
discounts with approval, offline rules with an age limit, order contract 6; till
review flags; reports (a `discount` field and a "Discounts given" template, plus
discount lines in the till's shift summary); per-line tax shared by the till,
the web and the ZATCA invoice; the `DISCOUNTS_ENABLED` kill switch, which
reaches the till as well.

**Print shop:** **Print coupons** on a discount makes a shippable coupon card
with the code, the offer and its terms written from the discount, and a QR to
`/menu?coupon=` that Sites keeps like a typed code (see
[print-shop-restaurant.md](./print-shop-restaurant.md#coupons)).

**Marketing coupons:** broadcasts and automation email and text steps can carry
a coupon (`{{couponCode}}`), either one shared code or a single-use code minted
per recipient (see "Coupons in marketing messages" below).

**Not built:** a redemption report; customer segments and specific customers as
an audience; loyalty tiers as groups; an in-app customer cart with discounts; a
cap on how much free delivery waives, and an amount off delivery; the "2-topping
pizza for a set price" rule; a per-discount ZATCA allowance reason code (the
document's allowance reason is the discount name); location-scoped operators for
discounts (see "Caps and known limits").

## Goal

One discount model with three ways to apply it:

- **Automatic:** applies by itself when the cart qualifies (happy hour, buy one
  get one, 20% off a category).
- **Code (coupon):** applies when the customer enters a code (Owner.com coupons,
  Square coupons).
- **Manual:** staff pick it at the till, optionally with a variable amount
  (Square manual discounts). Phase 3.

The rules (targets, quantity rules, schedule, minimum spend, limits) are the
same whichever way a discount applies. How it applies is one field.

## Decisions

1. **Discounts combine with loyalty.** Discounts apply first. A loyalty reward
   then applies to what is left on each line. The `stacking_not_allowed` refusal
   in `packages/loyalty/src/discount.ts` is removed (done). Points are earned on
   what the customer pays after all discounts. A reward that covers the whole
   total is no longer refused on an order (`reward_covers_total` is removed
   there: the order is free). A QR tab still refuses it, because a tab cannot be
   paid online at 0 (`reward_covers_total`, and the same for a tab whose
   discounts cover the whole bill): the guest asks staff to close it.
2. **Tip is a percentage of the subtotal before discounts**, on every channel.
   Online already works this way. The till moves to it in phase 3.
3. **A 100% discount skips payment.** An online order whose total is 0 after
   discounts is accepted without a payment step.
4. **No "apply discount after taxes".** Discounts always reduce the taxable
   amount, line by line. This keeps ZATCA simple.
5. **Customer groups are loyalty members**, for now. Tiers and marketing
   segments come later.
6. **Definitions live in the control plane, usage in the region.** Rules
   reference menu ids and hold no PII, so they sit next to the menu in D1. They
   travel to the region in the order context App already sends at every
   placement, and to the till in its menu download. Redemptions carry customer
   ids, so they live in the regional tenant DB.
7. **Per-customer limits and first-order coupons require phone sign-in.** A
   guest phone number is unverified, so it can't enforce a limit.

## Phases

1. **Website (this spec):** engine, schema, App editor, automatic discounts and
   codes at Sites checkout, a public quote endpoint, free orders, order detail,
   refunds, loyalty combining.
2. QR tab payment, "Promote on menu" (banner and item badges on Sites), a
   discounts report, bulk single-use codes for marketing journeys
   (`{{couponCode}}`), loyalty tiers as groups.
3. Station till: rules in the catalog download, manual and variable discounts
   with manager approval, offline automatic discounts, online code checks, order
   contract 6, per-discount ZATCA allowance reason, tip before discounts.
4. Customer app, once it has a cart.

## Phase 1 spec

### Control-plane schema (migration `0031_discounts`)

`Discount`:

| Column                                  | Notes                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `organizationId`                  | cuid; org-scoped                                                                                                                                                                                                |
| `name`                                  | Customer-facing, 1–60 chars                                                                                                                                                                                     |
| `internalName`                          | Optional (Owner "use a different name internally")                                                                                                                                                              |
| `description`                           | Optional, max 75 chars                                                                                                                                                                                          |
| `status`                                | `active` \| `paused` \| `archived`. Never deleted: redemptions reference it                                                                                                                                     |
| `application`                           | `automatic` \| `code` \| `manual`                                                                                                                                                                               |
| `valueType`                             | `percent` \| `fixed` \| `fixed_price` \| `free_delivery` (`variable_*` arrive with manual, phase 3). `fixed_price` is in "Meal deals and set prices" below                                                      |
| `percentBp`                             | Basis points, 1–10000                                                                                                                                                                                           |
| `amountMinor`, `currency`               | Fixed amount in minor units. Skipped at locations with another currency                                                                                                                                         |
| `maxDiscountMinor`                      | Optional cap per order (Square "maximum discount value")                                                                                                                                                        |
| `target`                                | JSON: `{scope: 'order' \| 'items' \| 'categories', itemIds, categoryIds, excludeItemIds, excludeCategoryIds}`                                                                                                   |
| `requirement`                           | JSON or null: `{quantity, itemIds, categoryIds}`. "When customer purchases any N from…" (Square purchase rule, Owner "require specific items")                                                                  |
| `quantityRule`                          | JSON: `{kind: 'none'}` \| `{kind: 'exact', quantity}` \| `{kind: 'minimum', quantity}` \| `{kind: 'bogo', buyQuantity, getQuantity}` \| `buy_get` \| `bundle` (the last two are in "Meal deals and set prices") |
| `maxDiscountedUnits`                    | Optional. Items discounted per use (Owner "discount items per redemption"). Only for item or category scope                                                                                                     |
| `minSubtotalMinor`                      | Optional minimum spend, checked against the subtotal before discounts                                                                                                                                           |
| `locationIds`                           | JSON or null (all locations)                                                                                                                                                                                    |
| `channels`                              | JSON subset of `web`, `qr`, `pos`, `app`                                                                                                                                                                        |
| `fulfillments`                          | JSON subset of `pickup`, `delivery`, `dine_in`                                                                                                                                                                  |
| `includeDrops`                          | Default false. Drop orders skip discounts unless set                                                                                                                                                            |
| `schedule`                              | JSON or null: `[{day: 0–6, start: 'HH:MM', end: 'HH:MM'}]`; `end < start` runs past midnight                                                                                                                    |
| `startsAt`, `endsAt`                    | Local date-time strings (`YYYY-MM-DDTHH:MM`) in each location's time zone; `endsAt` optional and exclusive (a discount ending 17:00 is gone from 17:00, like a schedule window that ends 17:00)                 |
| `eligibility`                           | `everyone` \| `signed_in` \| `new_customer` \| `loyalty_member`                                                                                                                                                 |
| `totalLimit`                            | Optional. Uses across all customers (Owner "maximum use")                                                                                                                                                       |
| `perCustomerLimit`                      | JSON or null: `{count, period: 'lifetime' \| 'day' \| 'week'}`. Day and week are calendar periods in the location's time zone, with weeks starting Monday                                                       |
| `combinable`                            | Whether it stacks with other discounts                                                                                                                                                                          |
| `combinesWith`                          | JSON or null: the kinds it may stack with (`item`, `order`, `delivery`). Null: `combinable` decides. Added in `0032`                                                                                            |
| `tiers`                                 | JSON or null: a spend or quantity ladder. Added in `0032`                                                                                                                                                       |
| `maxDeliveryFeeMinor`                   | Free delivery only: the largest delivery fee it applies to. Added in `0032`                                                                                                                                     |
| `priority`                              | Tie-break; lower first                                                                                                                                                                                          |
| `promoteOnMenu`                         | Stored now, used in phase 2                                                                                                                                                                                     |
| `requireApproval`                       | Stored now, used in phase 3 (till)                                                                                                                                                                              |
| `version`                               | Incremented on every save                                                                                                                                                                                       |
| `createdById`, `createdAt`, `updatedAt` |                                                                                                                                                                                                                 |

`DiscountCode`: `id`, `discountId`, `organizationId`, `code` (as typed),
`normalizedCode` (upper case, no spaces or dashes), `maxUses` (optional, Square
"limit number of times coupon can be redeemed"), `archivedAt`. Codes are unique
per organization among unarchived codes. Format: 3–24 characters from `A–Z`,
`0–9`, `-`.

`OrganizationMenuItem.excludeFromDiscounts` (boolean, default false), plus an
`excludeFromDiscounts` flag on each variant in the `variations` JSON (Square
"discount eligibility").

The migration also seeds:

- the permissions `read:discount:any` and `update:discount:any` for the
  `org_role_admin` role;
- the `ConfigFlag` rows `discounts.enabled`, `discounts.automatic` and
  `discounts.coupons`, all false.

### Regional schema (tenant-db migration `0026_discounts`)

`discount_redemptions`:

- **Identity:**
  - `id`, `discount_id`, `discount_version`, `code_id`, `normalized_code`.
  - `source_type` (`order`; `tab` and `pos` arrive later), `source_id`.
  - `customer_id`, nullable.
- **State:** `state` is `reserved`, `consumed`, `released` or `refunded`.
- **Money:**
  - `amount_minor` and `delivery_amount_minor`.
  - `allocation`: JSON `[{lineId, amountMinor, units}]`.
  - `snapshot`: JSON, a frozen copy of the discount's rules.
- **Period keys:** `local_day` (`YYYY-MM-DD`) and `local_week` (`YYYY-Www`),
  used for per-customer limits.
- **Timestamps:** `created_at`, `updated_at`.
- **Indexes:**
  - unique on `(source_type, source_id, discount_id)`;
  - `(discount_id, state)`;
  - `(discount_id, customer_id, state)`;
  - `(code_id, state)`.
- **Triggers:** the snapshot, amounts and allocation can't change, and state can
  only move from `reserved` to one of the others or from `consumed` to
  `refunded`.

`discount_code_attempts`: durable rate counters keyed by an HMAC of the IP and
by the organization, following `loyalty_rate_counters`.

`restaurant_orders` gains:

- `discount_cents`, the sum of non-loyalty line discounts;
- `delivery_discount_cents`;
- `discounts`, a JSON array of applied discounts:
  `{discountId, version, name, code, amountMinor, deliveryAmountMinor, allocation}`.

A redemption counts toward limits while it is `reserved` or `consumed`. Erasing
a person clears `customer_id` on their redemptions and keeps the amounts.

### Engine: `packages/discounts` (`@repo/discounts`)

A pure package with no I/O. It runs in tenant-api, App previews, Sites
(display), and later the Station browser.

Before building it, move loyalty's `money.ts` (`mulDiv`,
`allocateProportionally`, `inclusiveTaxMinor`) into the new package so both
packages share it; loyalty re-exports it.

Exports:

- `discountDefinitionSchema` (Zod): the App form, the order context and
  snapshots all use it.
- `evaluateDiscounts(input): DiscountEvaluation`, where:
  - `input.cart` has `currency` and `lines` of
    `{lineId, itemId, variantId, categoryIds, quantity, unitMinor, unitBaseMinor, taxableMinor, excluded}`.
    These are built from `PricedOrderLine`, with `lineId = String(index)` as in
    loyalty.
  - `input.context` has `channel`, `fulfillment`, `locationId`, `isDrop`,
    `localNow` (date-time in the location's zone), `subtotalMinor`,
    `deliveryFeeMinor` and `customer`
    (`{signedIn, isNewCustomer, isLoyaltyMember}`).
  - `input.usage` has, per discount,
    `{total, customerLifetime, customerDay, customerWeek}` and, per code,
    `{total}`.
  - `input.discounts` are the candidate definitions; `input.code` is optional.
  - The result is
    `{applied: AppliedDiscount[], lineDiscounts: Map<lineId, minor>, deliveryDiscountMinor, totalDiscountMinor, code?: {status: 'applied' | 'refused' | 'replaced', reason?}}`.

**Eligibility.** Checks run in this order, and the first failure is the reason:

1. Status.
2. Currency.
3. Dates.
4. Weekly schedule.
5. Location.
6. Channel.
7. Fulfillment.
8. Drop.
9. Eligibility group.
10. Limits.
11. Minimum spend.
12. Requirement.
13. Quantity rule.

Codes report one of `not_found`, `not_started`, `expired`, `not_available_now`,
`wrong_location`, `wrong_channel`, `wrong_fulfillment`, `sign_in_required`,
`new_customers_only`, `members_only`, `limit_reached`, `minimum_not_met`,
`requirement_not_met`, `not_applicable` or `replaced_by_better_discount`.
Customers see `not_found` for an archived, paused or unknown code.

**Eligible units:**

- Lines matching the target (an item id, or a category id the item belongs to
  directly, as loyalty does), minus excluded items and categories, minus lines
  marked `excluded`.
- A unit's value is `unitMinor` (with modifiers) less any discount already on
  it.

**Quantity rules.** Units are expanded one by one and sorted by value, highest
first, then by line order:

- `none`: every eligible unit.
- `exact N`: the first `floor(units / N) × N` units.
- `minimum N`: every eligible unit once there are at least N.
- `bogo B/G`: walk the sorted units. Each group pays full price for B units and
  discounts the next G units, which are therefore of equal or lesser value. Any
  leftover units are not discounted.
- `maxDiscountedUnits` caps the discounted units, keeping the highest-value
  ones.

**Amounts:**

- `percent`: `mulDiv(Σ value of the discounted units, bp, 10000)`, rounded down.
- `fixed` with order scope: `min(amount, eligible value)`, taken once.
- `fixed` with item or category scope: `min(amount, unit value)` for each
  discounted unit.
- `free_delivery`: the delivery fee.
- `maxDiscountMinor` caps the total.
- The amount is split across lines with `allocateProportionally` (largest
  remainder). A line never goes below 0.

**Combining:**

1. Automatic plans. Each largest group of automatic discounts that all stack
   together (by kind, see "Sizes, spend deals, tiers, stacking and delivery
   limits"), applied in priority order, each on the value the previous left
   over. The plan with the largest total wins; ties go to the lower priority,
   then the older discount.
2. Code. A code competes against the groups it can join, and the larger total
   wins. If it works alone but loses, its status is
   `replaced_by_better_discount`.
3. Loyalty runs afterwards, outside the engine, on the remaining line values.

**Properties (tested):**

- Allocations sum to each discount.
- No line goes below 0.
- Discounts never exceed the subtotal (or the delivery fee, for delivery).
- The same input always gives the same output.

### Meal deals and set prices

Pizza Hut, Papa Johns, McDonald's and Starbucks run deals the first rules can't
say: "any 2 pizzas for
$20", "a burger and fries free", "pizza, side and drink
for $15". Three additions
cover them. None needs a migration: `valueType` and `quantityRule` are plain
text and JSON columns, and the `Discount` row is otherwise unchanged. Built in
`@repo/discounts`, tested in `set-rules.test.ts`.

**`valueType: 'fixed_price'`** sets the price instead of taking an amount off.
`amountMinor` is the price and `currency` is required.

- With `quantityRule: none` and an item or category target, every matching unit
  costs the price ("large pizza $10"). A unit already cheaper stays as it is.
- With a `bundle`, each bundle costs the price. Each bundle is priced on its
  own, so a cheap bundle is never topped up.
- Not allowed with `exact`, `minimum` or `bogo` (is the price per unit or per
  group?), and not allowed on an order-wide target without a bundle.

**`quantityRule: buy_get`**:
`{buy: {quantity, itemIds, categoryIds}, get: {...}}`. Two groups: buy from one,
get from the other. The pair uses its units up, so two burgers earn two free
fries, not one.

- The value applies to the get units: percent (100% is free), `fixed` as an
  amount off each, or `fixed_price`.
- If a unit is in both groups (buy a pizza, get a pizza), it serves one side.
  The dearest go to the buy side and the cheapest of what is left are
  discounted, so what is free is never worth more than what was bought.
- Among the get group, the cheapest units are discounted. This protects the
  merchant, the same choice `bogo` makes.
- `maxDiscountedUnits` caps the discounted units (so 2 means two pairs of 1).
- `bogo` stays for "buy 2 get 1 free" inside one group. It pairs neighbours in
  value order, which gives the guest slightly more than `buy_get` with the same
  group on both sides.

**`quantityRule: bundle`**: `{slots: [{quantity, itemIds, categoryIds}]}`, up to
8 slots and 20 items per bundle. The cart is filled with as many whole bundles
as it allows.

- The value applies to the bundle: percent of its value, an amount off each
  bundle, or a set price.
- **The guest gets the best price.** Slots take the dearest matching units, and
  the dearest units go in the first bundle. "Any 2 pizzas for
  $20" with pizzas
  at $15, $12 and $10 takes the $15 and $12. This is the
  opposite of `buy_get`, where the free item is the cheapest. A merchant who
  wants the cheapest pizzas in the deal should name those pizzas, or run a lower
  price. Decide before the editor ships whether this needs a switch.
- Slots are filled scarcest first, so a slot with few candidates isn't starved
  by one that overlaps it. Heavily overlapping slots can still give fewer
  bundles than the best possible split; keep slots to distinct categories.
- `maxDiscountedUnits` caps the items covered (4 with a bundle of 2 is two
  bundles).

For both new rules, `target.scope` must be `order`, because the rule names its
own items. `excludeItemIds`, `excludeCategoryIds` and `excludeFromDiscounts`
still apply. Neither is allowed for `manual` discounts, and `free_delivery`
can't use them.

### Modifier discounts ("2 toppings free")

`target.scope: 'modifiers'` discounts the choices on an item (toppings, sauces,
upgrades) instead of the item. No migration: `target` is JSON, and the two new
lists are optional so stored discounts still parse.

- **What is covered:** `target.modifierGroupIds` (every choice in a group) and
  `target.modifierOptionIds` (single options). At least one is required. The ids
  are the org-level `OrganizationMenuModifierGroup` and `OrganizationMenuOption`
  ids, which are the ids on priced order lines.
- **Which items:** `target.itemIds` and `target.categoryIds` narrow whose
  choices count. Both empty means any item. Exclusions and
  `excludeFromDiscounts` still apply to the item.
- **Quantity rule:** `none` discounts every matching choice. `per_item`
  (`{kind: 'per_item', quantity: N}`) discounts the first N matching choices on
  each unit of an item, dearest first. The counted rules (`exact`, `minimum`,
  `bogo`) and the deal rules are refused here.
- **Value:** percent (100% is free), `fixed` (an amount off each choice) or
  `fixed_price` (what each choice costs). Each applies to the price of the
  choice, never the item.
- **Units:** a choice is one unit. A quantity choice (extra cheese x3) counts as
  three. A choice is worth its price for one unit of its line, less the share of
  that unit an earlier discount already took, so stacking never takes more than
  the line is worth. `maxDiscountedUnits` caps choices across the order, dearest
  first, and `AppliedDiscountLine.units` counts choices.
- **Data:** `DiscountCartLine` gained `options` (`groupId`, `optionId`,
  `quantity`, `totalMinor` per unit of the line) and `baseUnitMinor`. The order
  route builds them from the priced line (`options`, `baseUnitCents`), the tab
  evaluator from stored rounds (older rounds carry neither field and get no
  modifier discount), and the Station till from its cart options.

**A set price covers the item, not its paid modifiers.** With `baseUnitMinor` on
the line, `fixed_price` (on items, in `buy_get` and in a bundle) replaces the
base price and leaves modifiers charged: "large pizza $10" with a $3 topping
costs $13, not $10. A line with no modifier detail uses the whole unit.

Not on the public menu yet: promotions skip `fixed_price` and modifier
discounts, as the menu cannot show them.

### Sizes, spend deals, tiers, stacking and delivery limits

Migration `0031_discounts` includes three nullable `Discount` columns
(`combinesWith`, `tiers`, `maxDeliveryFeeMinor`). Everything else here lives in
existing JSON columns. Every new field is optional, so stored discounts still
parse. Built in `@repo/discounts`, tested in `ladder-rules.test.ts`.

**Sizes** (`variantNames` on `target`, and on the groups of `buy_get` and
`bundle`). "Any large pizza $10", "2 large pizzas for $20".

- Matched by the name the menu shows ("Large", "Thin"), ignoring case and
  surrounding spaces, never by id: a size has a different id on every item but
  the same name across a menu. A variant with several values ("Large", "Thin")
  matches on any of them.
- Allowed on items, categories and modifier scopes, and on deal groups. Refused
  on the whole order, where it would be ignored.
- A line with no variant detail matches no size. Priced lines carry
  `variantNames` (new, optional on `PricedOrderLine`); older stored rounds
  don't, so they get no size discount. The till reads names from its own menu
  data.
- The editor offers every size name used across the menu, most used first.

**Spend on the buy side** (`buy_get` with `buy.spendMinor` in place of
`buy.quantity`). "Spend $30 on burgers, get a free dessert".

- Every `spendMinor` spent on the buy group earns the get quantity again, so $60
  earns two. Set "Items discounted per use" to make it once per order.
- A unit that is discounted does not also count towards the spend. Spend is the
  value the units have left after any earlier discount.
- Needs a currency, like a minimum spend.

**Tiers**
(`tiers: {basis: 'spend' | 'quantity', steps: [{at, percentBp, amountMinor}]}`).
"Spend $30 get 5%, spend $50 get 15%".

- The discount gets the highest step reached, as an ordinary discount with that
  step's value; the discount's own value is then null. Steps must go up.
- Spend counts what the matching lines cost before any discount (like a minimum
  spend); quantity counts their units. Only matching lines count, so a ladder on
  pizzas ignores the salads.
- For percent and fixed discounts on the whole order, items or categories, with
  no quantity rule. Not for deals, modifier discounts or till discounts.
- A coupon with a ladder that has not reached its first step is refused with
  `minimum_not_met` (or `quantity_not_met`).

**Free delivery fee limit** (`maxDeliveryFeeMinor`). Free delivery applies only
when the delivery fee is at most this, so a long-distance fee isn't waived. Over
the limit it is `not_applicable`. It is a limit on when it applies, not a cap on
what is waived.

**Stacking by kind** (`combinesWith`, replacing the `combinable` switch).

- Each discount has a kind: `delivery` for free delivery, `order` for a plain
  whole-order discount, `item` for everything else (items, categories, modifier
  choices, deals).
- `combinesWith` lists the kinds it may stack with. Two discounts stack only if
  each allows the other's kind, so one "no" keeps them apart. Missing,
  `combinable` decides: true means all kinds, false none. The editor writes
  both, with `combinable` true when anything is ticked.
- The engine finds every largest group of automatic discounts that all stack
  together, applies each group in priority order, and keeps the one that saves
  most. Ties go to the lower priority, then the older discount. Up to 12
  automatic discounts compete at once (`MAX_COMPETING_AUTOMATIC` in
  `evaluate.ts`). The cap is by priority order: the 12 first by priority (lowest
  priority number, then the older discount, then the id) compete, and the rest
  are ignored for that cart, even when one of them would save more. The planner
  is exponential in the number that compete, so the cap bounds what a crafted
  configuration can cost (about 250 ms measured at 24).
- A typed code is compared the same way against the groups it can join. A code
  that works on its own but loses is `replaced_by_better_discount`, never a
  refusal.
- This replaces "each non-combinable alone, all combinable together", which it
  matches exactly for the old switch.

**On the public menu.** Promotions now include set prices, deals, modifier
discounts, ladders and size-limited discounts, with `showName` set so the menu
shows the discount's name rather than a value badge. A deal badges the items its
groups name; a modifier discount badges the items it is limited to, or only the
banner when it covers every item. Only variable (till-keyed) discounts stay off
the menu. Sites matches items by their ids for every scope, so a deal's badge
doesn't land on every item.

**Not built:**

1. A "2-topping pizza for a set price" as one rule (the pizza at a price while
   its first two toppings are included). Today it takes two combinable
   discounts, a set price on the pizza and 2 toppings free; if either is not
   combinable, the better one applies alone.
2. Customer segments and specific customers as an audience (Shopify has both);
   today it is everyone, signed in, new, or loyalty members.
3. Bulk single-use codes for marketing journeys, and a redemption report.
4. A cap on how much free delivery waives (as opposed to a limit on when it
   applies), and an amount off delivery.
5. Discounts in an in-app customer cart (the app only shows menu promotions
   today and hands checkout to the website).

### Tax and totals

`priceRestaurantOrder` stays as it is. A new
`applyOrderDiscounts(priced, lineDiscounts, deliveryDiscount)` in
`@repo/common/restaurant-orders` generalizes `discountedTotals` from
`apps/tenant-api/src/restaurant/loyalty-checkout.ts`:

- each line's taxable amount is reduced by its own discount, floored at 0;
- tax is recomputed once on the sum (inclusive or exclusive);
- the tip stays on the pre-discount subtotal;
- `total = subtotal − discounts − loyalty + tax + tip + (delivery fee − delivery discount)`.

Loyalty's `applyLoyaltyDiscountToTotals` calls it with both sets of line
discounts.

### Loyalty changes

- `LoyaltyCart.otherDiscountMinor` becomes per-line `discountedMinor`.
  `rewardEligibleLines` and `computeRewardDiscount` use each line's remaining
  value.
- A free-item reward is worth `min(unitBaseMinor, remaining value per unit)`.
- Remove `stacking_not_allowed`, together with its UI strings and tests (done;
  `reward_covers_total` is removed for orders only, tabs still refuse it).
- `buildPurchaseSnapshot` takes the per-line discounts, so points are earned on
  net spend. `loyaltyCartForPricedOrder` (website), `tabCartLines` and the till
  cart pass it.
- Update the "Scope and rules" section of `docs/loyalty.md`.

### Order context

`GET /resources/order-context` (App) gains:

- `discounts`: active and unexpired definitions with their unarchived codes;
- the folded flags `discounts.features: {automatic, coupons}` (inside the same
  `discounts` object, with `discounts.discounts` and `discounts.codes`).

App computes these flags as each sub-flag AND `discounts.enabled`. The region
reads a missing field as off. Deploy App before tenant-api (see "Version skew").

The region reads the field one record at a time (`parseOrderContextDiscounts` in
`@repo/discounts`): a discount or code row that does not parse (including a code
row whose `normalizedCode` is a `parked:` placeholder or longer than 24
characters) is dropped, counted and logged by id only, and the valid rows stay.
Each record is as strict as before. Only an unusable `features` object, or a
field that is not an object with the two arrays, turns every discount off for
that request. App skips the same rows when it builds the field, so the region's
log line is a safety net, not the normal path.

### Public quote: `POST /orders/quote` (tenant-api)

- **Who can call it:** guests. The organization comes from `Origin` plus the
  slug, as in `POST /orders`. A customer token is optional.
- **Request:** the `POST /orders` body without `contact`, plus
  `coupon?: {code}`. No Turnstile.
- **Limits:** a durable per-IP limit, plus a per-IP and per-organization limit
  on attempts with a code.
- **What it does:** fetches the order context, prices, loads usage counts, runs
  the engine and loyalty, then applies totals.
- **Response:**
  `{subtotalMinor, discounts: [{discountId, version, name, amountMinor, deliveryAmountMinor, lineIds}], loyalty?, taxMinor, tipMinor, deliveryFeeMinor, totalMinor, paymentRequired, coupon?: {status, reason?}}`.
  Codes are echoed only as the customer typed them.
- `POST /loyalty/checkout/quote` keeps working, running discounts first. Merging
  the two endpoints is later work.

### Placement (`order-service.ts` `placeOrder`)

- **Request:** `restaurantOrderObjectSchema` gains
  `discounts?: {code?: string, expectedDiscountMinor: number}`.
  `canonicalOrderRequest` includes it only when present.
- **Inside the existing `runExclusive` and transaction, after the capacity
  checks:**
  1. Load usage counts.
  2. Evaluate.
  3. If the total discount differs from `expectedDiscountMinor`, refuse with 409
     `discount_changed` and return the fresh quote.
  4. If a code was sent and was refused or replaced, refuse with 409 and the
     reason (`discount_changed` for `replaced_by_better_discount`).
  5. Run the loyalty quote on the remaining values.
  6. Compute totals.
  7. Insert the order with the discount columns.
  8. Insert a `reserved` redemption for each applied discount.
- **Free orders:**
  - When `totalMinor === 0` and `paymentMethod === 'online'`, the order gets the
    new payment status `not_required` and goes straight to `accepted`, with no
    hold expiry.
  - The `reward_covers_total` refusal is removed.
  - App's `/resources/sites/order/checkout` refuses to start a session for a
    `not_required` order.
  - Add `not_required` to `RESTAURANT_PAYMENT_STATUS_VALUES`, the order status
    page and the order detail.
  - A free order is payable like a paid one everywhere the region decides what
    counts: the kitchen display, sales reports, customer history and staffing
    demand all use `isPayableOrder` / `payableOrderCondition()`
    (`apps/tenant-api/src/services/order-payable.ts`: handoff, or payment status
    `paid` or `not_required`). Do not re-spell that rule.
  - A free pickup or delivery order paid at handoff (total 0, not a table round)
    is stored `not_required` too, so staff never get a "mark paid" step for it.
    The operator "mark paid" on such an order is a harmless no-op. A table round
    keeps `unpaid`: its tab is settled once, at close.
- **Tab rounds** (dine-in with a tab) refuse `discounts` with `discounts_on_tab`
  until phase 2.

### Reports

- The order report subject has a `discount` currency field (sum label "Discounts
  given"): `discountCents + deliveryDiscountCents + loyaltyDiscountCents` of the
  order. Template: "Discounts given".
- `total` is net of discounts; `subtotal` and the item and option `sales` fields
  are gross line totals, before discounts (they do not change when a discount
  applies).
- A dine-in tab is discounted when it is closed; redemptions are on the tab, not
  on its rounds. Order reports add consumed tab discounts to the **latest
  round** of that tab in the report window so "Discounts given" includes table
  tabs.
- The POS Z report and day report add `discountCents` (sum of the closed sales'
  adjustments, loyalty rewards included), `grossBeforeDiscountsCents`
  (`grossSalesCents + discountCents`) and `subtotalCents` (items before
  discounts). `grossSalesCents` keeps its meaning: closed sales as charged, net
  of discounts. See `docs/pos.md`.

### Redemption lifecycle

State changes happen inline, in the same transaction as the order change:

| Order event                                                                      | Redemption                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Paid (`applyPaymentEvent`), or a `not_required` or pay-at-pickup order completed | `reserved` → `consumed`                                                                                                 |
| Cancelled, expired, hold expired (`expireHolds`), payment failed                 | `reserved` → `released`                                                                                                 |
| `payment_review`                                                                 | Stays `reserved` until resolved                                                                                         |
| Full refund (`order-refund-service.ts`)                                          | → `refunded`, so the use no longer counts                                                                               |
| Partial refund                                                                   | No change. Refunds stay amount-based, and the order's `discounts` allocation is what reports and loyalty pro-rating use |

A pay-at-pickup order holds its use from placement, so reserved uses count
toward limits.

**What counts, exactly** (`loadDiscountUsageCounts` in `discount-apply.ts`):

- **Consumed** uses always count. **Reserved** uses count too, with two
  exceptions that change only the count, never the order or the row:
  - **A lapsed online hold** (unpaid, `holdExpiresAt` passed) no longer counts,
    even before a sweep has run. Quotes do not sweep and placement does, so
    without this a quote and the placement that follows could disagree. The same
    rows are skipped when deciding whether a customer is new
    (`discountCustomerFacts`).
  - **An abandoned tab payment.** A tab's pay request reserves its uses before
    any provider session exists, and nothing sweeps them. A reserved tab use
    stops counting once the tab is still unpaid and its `paymentEventAt` is
    older than the session hold (`QR_TAB_SESSION_HOLD_MS`, 45 minutes), the same
    time `isTabPaymentOpen` uses. The row stays `reserved` until the tab's next
    pay request or close releases it.
  - **A pay-at-pickup no-show.** Nothing sweeps a pay-at-pickup order, so its
    reserved use would hold a total or per-customer limit until someone
    completed or cancelled the order. A reserved use of an order still
    `accepted`, `preparing` or `ready` stops counting 24 hours
    (`DISCOUNT_RESERVED_COUNT_MAX_MS`) after its scheduled time, or after its
    creation when it is ASAP. The order stays open and the row stays `reserved`;
    completing it still consumes the use, which then counts for good.
- **A sale paid after its hold lapsed.** The sweep released the use, but the
  customer paid the discounted price, and the payment lands in `payment_review`.
  The use is recorded again at that moment: a released row can never be
  reopened, so each released discount is copied to a new `reserved` row under
  the source id `<orderId>:late` (every fact and the rule snapshot are kept). It
  is never refused because a limit was reached in the meantime: it only makes
  the counts true. The operator accepting the order (to `preparing`, `ready` or
  `completed`) consumes it, cancelling releases it, and a full refund refunds
  it. Orders that reached review before this existed are fixed up when the
  operator decides. Honoring the sale can still go past a limit: a hosted page
  stays payable longer than the 10 minute hold, so another order may have taken
  a single-use code in between. When the re-recorded use would exceed the
  discount's total limit, the customer's limit or the code's `maxUses` (the
  code's `maxUses` is kept on the redemption's snapshot), the order's discount
  snapshot is marked `limitExceeded` and the operator order view carries
  `reviewReason: 'discount_limit_exceeded'`. Nothing is refused or refunded
  automatically; the operator decides.
- **Pickup time, not order time.** `schedule`, `startsAt` and `endsAt` (and the
  `local_day` and `local_week` of per-customer limits) are judged at the order's
  `scheduledFor`, or its pickup slot for a drop, in the location's time zone; an
  ASAP order uses now. A pre-order at 6pm for 4pm tomorrow gets tomorrow's 4pm
  rules, at the quote and at placement.

### QR tabs

A tab's rounds never carry a discount; the tab does, when it is settled.

- **The tab view is net.** `GET /orders/tab` and the operator tab routes show
  `totals.discountCents` and a tax and total net of the tab's automatic
  discounts (what a counter close or a phone payment would apply; a signed-in
  guest sees theirs). An open tab with a payment in progress shows the discounts
  that payment reserved. A settled tab shows what it was settled with, from its
  redemption rows. The drawer has a Discount row for it. The order context is
  fetched per location and reused for 10 seconds by views; if the App cannot be
  reached a tab shows and closes with no discount.
- **Counter close** prices the same automatic discounts (no coupon) with the
  same helper as a phone payment, records one `reserved` use per discount and
  consumes it, and stores the discounted tax and total. The dialog's
  `expectedTotalCents` is the total shown, now net; a mismatch answers 409
  `stale_tab` and writes nothing. Void accepts either total. A tab rung up on a
  Station till records no discount (the till sale does).
- **Phone payment** follows the order rules: `discounts` in the request asks for
  discounts (automatic ones apply, a missing `expectedDiscountMinor` reads as 0,
  and a different priced total answers 409 `discount_changed` with
  `details.discountMinor`); a request with no `discounts` field applies nothing.
  Sites always sends the field, with the total the tab showed, and asks again
  once with the region's total when it differs (the guest still sees the final
  amount before the hosted page opens).
- **A tab paid after its page lapsed** (the payment is kept for review) is
  counted when staff close it at the counter, like any counter close.

### App (operator)

- **Routes** under `apps/app/app/routes/_app+/$orgSlug_+/discounts+/`:
  - `_index.tsx`: list with Automatic and Coupons filters, status, a schedule
    summary and uses.
  - `new.tsx` and `$discountId.tsx`.
  - A top-level Discounts entry in the sidebar (`/:orgSlug/discounts`), shown
    when `discounts.enabled` is on and the member can read discounts.
- **Access:** `requireDiscountsAccess` (permission plus flag) runs first in
  every loader and action, with `discounts-guards.test.ts` checking that.
- **Writes** go to D1 through App actions, because definitions live in the
  control plane. Every save bumps `version`, and a stale `expectedVersion`
  gets 409.
- **Uses** are read browser-direct from the region with a short-lived `dsc+jwt`
  (`GET /:orgSlug/discounts-token`, `discounts-token.ts`), following loyalty.
  Region route: `GET /operator/discounts/usage?ids=`, with counts only.
- **Editor** (conform + `discountDefinitionSchema`), in these sections:
  - **Basics:** name, internal name, description (75), how it applies, the
    value, the maximum.
  - **Applies to:** order, items or categories, using `CatalogPicker` from
    loyalty; exclusions; required items.
  - **Quantity rule:** none, exact, minimum, buy X get Y; discounted items per
    use.
  - **When:** start, end, weekly hours.
  - **Where:** locations, channels, order types, drops.
  - **Who:** eligibility, total limit (Owner presets: unlimited, 1, 10, 25, 50,
    100, 250, 500, or a custom number), per-customer limit.
  - **Codes:** one or more, each with an optional use limit. At most 90 per
    discount (`DISCOUNT_MAX_CODES`): the region's code lookup binds one
    parameter per code and D1 and Durable Object SQLite allow 100 per statement.
    A longer list is refused with `too_many_codes` in the editor.
  - **Options:** combinable, priority.
  - A live **Summary** card beside the form, in plain words: the name, what it
    takes off, what it covers, when, where and who. It reads the form as it
    stands, so it describes a half-filled discount. It replaced a one-item
    sample cart that could not show a meal deal and showed nothing on an empty
    menu. The engine is covered by tests, not by a simulator in the editor.
- **Item editor:** an "Exclude from discounts" switch per item and per variant.
- **Order detail** (`components/orders/order-detail.tsx`): discount lines with
  the code, and a "Free order" badge.

### Sites

- `checkout.astro`:
  - totals come from `POST /orders/quote`, debounced on cart changes, replacing
    the client estimate in `computeTotals`, which stays only as a fallback while
    loading;
  - discount lines;
  - an "Add a coupon code" field with a message for each reason;
  - "Place order" without the payment hand-off when `paymentRequired` is false.
- `pricingPayload` and `checkoutOrderPayload` send `discounts`. The order-error
  mapping handles `discount_changed` by re-quoting and showing the new total.
- The order status page shows discounts and the free-order state.
- Translate every new string in `en`, `ar`, `es`, `fr`, `de` and `zh`, then run
  `node scripts/check-lingui.mjs`.

### Security

- **Codes:**
  - Rate-limited by three durable fixed-window counters in the organization's
    regional database (`DISCOUNT_RATE_LIMITS` in
    `apps/tenant-api/src/lib/discount-rate-limit.ts`; subjects are stored only
    as keyed hashes). There is no per-customer code limit.
    - `quoteIp`: 60 quotes per minute from one address, with or without a code.
    - `codeIp`: 20 wrong guesses per 10 minutes from one address.
    - `codeOrg`: 10,000 wrong guesses per 10 minutes for the whole organization,
      high enough that a busy venue cannot turn coupons off.
  - The guess budget (`codeIp`, `codeOrg`) is counted before the code is
    checked, in one upsert, and given back when the code applies, so parallel
    requests cannot all pass a read-then-charge check. An address already over
    `codeIp` is refused without touching `codeOrg`, so spoofed or burst
    addresses cannot spend the shared budget. A refusal the customer can fix
    (`minimum_not_met`, `quantity_not_met`) is given back too, and a valid code
    beaten by a better automatic discount (`replaced`) still counts. The same
    cart and code asked again (the Sites page re-quotes on every change, and
    again at placement) counts once per window, and is still refused while the
    budget is spent.
  - Every refusal for an unknown or inactive code is the same `not_found`.
  - Codes never appear in logs, and are checked server-side only.
- **Prices:** the browser never sends prices or discount amounts it could make
  stick, because `expectedDiscountMinor` is only compared, never trusted.
- **Region:**
  - Cross-organization codes can't resolve, because definitions come from that
    organization's context.
  - A security test, `discounts-security.test.ts`, covers forged tokens,
    cross-organization codes, limit races under `runExclusive`, and replayed
    idempotency keys with a different code.
- **Kill switch:** tenant-api `DISCOUNTS_ENABLED` (unset means on; `false`, `0`,
  `off`, `no`, `disabled` turn it off). When off, the region ignores every
  discount and refuses requests with codes (`discounts_disabled`, 503). It
  reaches the till too: `GET /pos/discount-rules` answers an empty list (a real
  answer, so tills keep selling and drop their stored rules), and an uploaded
  sale is kept with its adjustments (the money was taken) but gets no
  discount-rule review flag and records no use. A void or full refund still
  releases a use reserved before the switch went off. The large-discount review
  flag (`large_discount`) is not a discount-module check and still runs. **Menu
  promotions** come from App (`buildPublicMenuDiscounts` behind
  `discounts.enabled`); changing an org-level discount flag in App or Admin
  purges that org's public site KV cache (Admin calls App
  `POST /resources/sites/cache-purge` with `INTERNAL_COMMAND_TOKEN`), so
  promotions drop from KV even when tenant-api is still evaluating discounts for
  in-flight carts.
- **Till rule age:** Station applies its stored rules only while they are at
  most 24 hours old (`TILL_RULES_MAX_AGE_MS`), automatic and manual alike; older
  rules are shown as expired and nothing applies. Automatic rules with a use
  limit never apply at the till by themselves. There is no `discounts.pos` flag:
  the till gets a rule when its channels include `pos` and either it is
  automatic with `discounts.automatic` on, or it is manual (`manual` needs only
  `discounts.enabled`); a code discount is never a till rule.

### Tests

- **Engine:** table-driven cases for every rule (Owner and Square examples, BOGO
  with mixed prices, exact and minimum quantities, caps, combining, schedule
  across midnight and DST via `@repo/zoned-time`), plus property tests for the
  invariants above.
- **`@repo/common`:** `applyOrderDiscounts` for exclusive and inclusive tax,
  untaxed lines, delivery discounts and a zero total.
- **Loyalty:** a reward on top of a discount, a free item on a discounted line,
  earning on net spend, and refund reversal with discounts.
- **tenant-api:**
  - quote and placement, `discount_changed`;
  - each limit type, including the last-use race;
  - the lifecycle for each order event;
  - free orders through payment, refund and status;
  - drops excluded by default, tab rounds refused.
- **App:** guards, editor validation, order-context payload and flag folding,
  and checkout refusing `not_required`.
- **Sites:** quote client, coupon field states, free-order path.

### Coupons in marketing messages

A broadcast (email or text) or an automation email or text step can carry a
coupon. The `{{couponCode}}` merge tag shows it; a message with the tag needs a
coupon and a coupon needs the tag (App and tenant-api both refuse otherwise).

- **Offer** (`marketingOfferSchema` in `@repo/discounts`, stored as
  `marketing_campaigns.discount_offer` or the node's `data.discountOffer`):
  `{mode: 'shared', discountId, code}` sends everyone one of the discount's own
  codes; `{mode: 'unique', discountId, prefix, validDays}` mints a code per
  recipient (`PREFIX-XXXXXXXX`, 8 characters from an alphabet without 0, O, 1, I
  and L; valid 1 to 365 days, default 30).
- **Who can attach one:** `discounts.enabled` and `discounts.coupons` on, plus
  `read:discount:any` on top of the marketing permission. Only active discounts
  applied with a code qualify. The App checks the offer on save
  (`apps/app/app/utils/discounts/marketing-offers.server.ts`); an automation
  step whose saved coupon is unchanged is not re-checked against the editor's
  permission, so a member without discount access can still edit other steps.
- **Code-only discounts:** a code discount may have no public code. It then
  applies only through the codes marketing sends.
- **Minting (region):** `discount_issued_codes` (tenant-db
  `0027_discount_marketing_codes`; could be folded into `0026`) holds one row
  per message and recipient (`source_type` `campaign` or `journey`, `source_id`
  the broadcast id or `<runId>:<nodeId>`), so a retried send reuses its code.
  Codes are minted just before the send; a failed mint fails that recipient or
  step instead of sending a raw tag. Rows never change except that person
  erasure clears `customer_id` (trigger `discount_issued_codes_fixed`).
- **At checkout:** when a typed code is none of the context's codes, the region
  looks it up in `discount_issued_codes` (`codesWithIssuedCode`) and, while it
  has not expired, evaluates it as a code with `maxUses: 1` whose id is the
  issued row's id. A use counts while its redemption is reserved or consumed, so
  a released order gives the code back. A paused or archived discount is not in
  the order context, so its codes read as `not_found`. Anyone holding the code
  can use it once; it is not tied to the recipient's sign-in.

### Caps and known limits

- **Per organization.** At most 500 discounts that are not archived
  (`MAX_DISCOUNTS_PER_ORG`) and 2000 unarchived codes (`MAX_CODES_PER_ORG`),
  matching what the order context can carry. Creating, duplicating or restoring
  past 500 answers `too_many_discounts`; saving codes past 2000 answers
  `too_many_codes`. Both reach the editor as action data
  `limit: 'discounts' | 'codes'` with a generic field error until the editor
  maps them. The order context reads only the codes of active discounts and, if
  a cap is still hit (rows from before the cap), keeps the oldest and logs the
  count, never a name or a code.
- **Channel `qr` is client-asserted.** The region takes it from
  `request.source === 'qr_poster'` (and from dine-in), which the browser sends.
  A QR-only discount is therefore targeting, not security: anyone who can call
  the public order API can claim the channel.
- **`cf-connecting-ip` is trusted for rate limits.** The per-address limits
  (`quoteIp`, `codeIp`) key on that header. They hold only behind Cloudflare,
  which sets it. A node reached directly (the OCI KSA node) needs a reverse
  proxy that sets or overwrites it; otherwise a caller can spoof a fresh address
  per request. The organization-wide budget (`codeOrg`) is not charged for an
  address that is already refused, so spoofed addresses cannot lock coupons for
  everyone, but they do get unlimited guesses per address.
- **Location-scoped operators** see and edit only discounts that apply to at
  least one of their locations; saves cannot pick "all locations" or locations
  outside their grant (`location-scope.server.ts`). Org-wide discounts (every
  location) remain visible but location picks on save are scoped.
- **A coupon guess is counted** unless the customer can fix the refusal
  (`minimum_not_met`, `quantity_not_met`); a valid code beaten by an automatic
  discount (`replaced`) counts, so a probe is never free.

### Related fix (separate PR)

Online pricing ignores the item-level `applySalesTax` setting
(`restaurant-orders.ts` always taxes the base price). Fix it before or alongside
phase 1 so line-level discounts reduce the right taxable amount.

### Rollout

1. Control-plane migration `0031`, then App: editor behind the flag,
   order-context fields, checkout guard, `/resources/discount-rules`.
2. tenant-api migration `0026`, then tenant-api.
3. Station and Sites.
4. Turn on `discounts.enabled` and its sub-flags per organization.

Before step 4, check the configuration:

- **Admin** needs `APP_URL` and `INTERNAL_COMMAND_TOKEN` (the same value App
  uses). Without either, Admin skips the Sites cache purge and logs a warning,
  so a flag change shows on public sites only after the KV entry expires.
- **App** must have the `SITES_DATA_KV` binding (it runs the purge).
- **tenant-api** (every node) has `DISCOUNTS_ENABLED` unset, which means on.
  Leave it unset; it is the rollback switch.

Rollback, fastest first: turn `discounts.enabled` off for the organization
(Admin purges the Sites cache); or set `DISCOUNTS_ENABLED=false` on a tenant-api
node, which stops new discounts at quote, placement, tab payment and the till.
Orders already placed keep their discounts and their redemptions still settle.
Migrations are additive, so no schema rollback is needed.

### Version skew

Deploy App, then tenant-api, then Station and Sites. Each skew below fails
closed: nobody is charged a wrong discount, and a sale is held back or loses
only the discount, never the order.

| Deployed ahead       | Others still old | What happens                                                                                                                                                                          |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App                  | tenant-api       | The old region ignores the new `discounts` field of the order context (it reads as off), so orders and quotes carry no discount. Nothing breaks.                                      |
| tenant-api           | App              | No `discounts` field: reads as off. `/resources/discount-rules` is missing, so `GET /pos/discount-rules` answers 503 and tills keep the rules they stored. Rule checks are skipped.   |
| Sites                | tenant-api       | Sites sends `discounts` on orders and tab payments, which the old region's strict request schema rejects (400). Checkout shows an error and the cart stays. Deploy tenant-api first.  |
| Sites                | App              | The menu shows no promotions (the old App sends none). Quotes and placement still come from the region. Nothing breaks.                                                               |
| Station (contract 6) | tenant-api       | The old region refuses the upload (`discountApplications` is unknown to it). The till keeps the sale in its outbox and retries until tenant-api is deployed. Deploy tenant-api first. |
| tenant-api           | Station          | An old till sends contract 5 with no applications and holds no rules, so it applies nothing and uploads as before.                                                                    |
