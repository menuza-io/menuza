# Discounts and coupons: plan

Status: planned, nothing built. Research current as of 30 October 2026 (`main`
at `ad2526f7d`). Modelled on Square discounts and Owner.com coupons.

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
   in `packages/loyalty/src/discount.ts` is removed. Points are earned on what
   the customer pays after all discounts.
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

| Column                                  | Notes                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `organizationId`                  | cuid; org-scoped                                                                                                                                          |
| `name`                                  | Customer-facing, 1–60 chars                                                                                                                               |
| `internalName`                          | Optional (Owner "use a different name internally")                                                                                                        |
| `description`                           | Optional, max 75 chars                                                                                                                                    |
| `status`                                | `active` \| `paused` \| `archived`. Never deleted: redemptions reference it                                                                               |
| `application`                           | `automatic` \| `code` \| `manual`                                                                                                                         |
| `valueType`                             | `percent` \| `fixed` \| `free_delivery` (`variable_*` arrive with manual, phase 3)                                                                        |
| `percentBp`                             | Basis points, 1–10000                                                                                                                                     |
| `amountMinor`, `currency`               | Fixed amount in minor units. Skipped at locations with another currency                                                                                   |
| `maxDiscountMinor`                      | Optional cap per order (Square "maximum discount value")                                                                                                  |
| `target`                                | JSON: `{scope: 'order' \| 'items' \| 'categories', itemIds, categoryIds, excludeItemIds, excludeCategoryIds}`                                             |
| `requirement`                           | JSON or null: `{quantity, itemIds, categoryIds}`. "When customer purchases any N from…" (Square purchase rule, Owner "require specific items")            |
| `quantityRule`                          | JSON: `{kind: 'none'}` \| `{kind: 'exact', quantity}` \| `{kind: 'minimum', quantity}` \| `{kind: 'bogo', buyQuantity, getQuantity}`                      |
| `maxDiscountedUnits`                    | Optional. Items discounted per use (Owner "discount items per redemption"). Only for item or category scope                                               |
| `minSubtotalMinor`                      | Optional minimum spend, checked against the subtotal before discounts                                                                                     |
| `locationIds`                           | JSON or null (all locations)                                                                                                                              |
| `channels`                              | JSON subset of `web`, `qr`, `pos`, `app`                                                                                                                  |
| `fulfillments`                          | JSON subset of `pickup`, `delivery`, `dine_in`                                                                                                            |
| `includeDrops`                          | Default false. Drop orders skip discounts unless set                                                                                                      |
| `schedule`                              | JSON or null: `[{day: 0–6, start: 'HH:MM', end: 'HH:MM'}]`; `end < start` runs past midnight                                                              |
| `startsAt`, `endsAt`                    | Local date-time strings (`YYYY-MM-DDTHH:MM`) in each location's time zone; `endsAt` optional                                                              |
| `eligibility`                           | `everyone` \| `signed_in` \| `new_customer` \| `loyalty_member`                                                                                           |
| `totalLimit`                            | Optional. Uses across all customers (Owner "maximum use")                                                                                                 |
| `perCustomerLimit`                      | JSON or null: `{count, period: 'lifetime' \| 'day' \| 'week'}`. Day and week are calendar periods in the location's time zone, with weeks starting Monday |
| `combinable`                            | Whether it stacks with other discounts                                                                                                                    |
| `priority`                              | Tie-break; lower first                                                                                                                                    |
| `promoteOnMenu`                         | Stored now, used in phase 2                                                                                                                               |
| `requireApproval`                       | Stored now, used in phase 3 (till)                                                                                                                        |
| `version`                               | Incremented on every save                                                                                                                                 |
| `createdById`, `createdAt`, `updatedAt` |                                                                                                                                                           |

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

1. Automatic plans. Each non-combinable discount on its own, and all combinable
   discounts stacked in priority order (each one on the value the previous left
   over). The plan with the largest total wins; ties go to the lower priority,
   then the older discount.
2. Code. A combinable code applies on top of the winning plan. A non-combinable
   code is compared on its own against the plan, and the larger total wins. If
   the plan wins, the code's status is `replaced_by_better_discount`.
3. Loyalty runs afterwards, outside the engine, on the remaining line values.

**Properties (tested):**

- Allocations sum to each discount.
- No line goes below 0.
- Discounts never exceed the subtotal (or the delivery fee, for delivery).
- The same input always gives the same output.

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
- Remove `stacking_not_allowed`, together with its UI strings and tests.
- `buildPurchaseSnapshot` takes the per-line discounts, so points are earned on
  net spend. `loyaltyCartForPricedOrder` (website), `tabCartLines` and the till
  cart pass it.
- Update the "Scope and rules" section of `docs/loyalty.md`.

### Order context

`GET /resources/order-context` (App) gains:

- `discounts`: active and unexpired definitions with their unarchived codes;
- the folded flags `discountFeatures: {automatic, coupons}`.

App computes these flags as each sub-flag AND `discounts.enabled`. The region
reads a missing field as off. Deploy App before tenant-api.

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
- **Tab rounds** (dine-in with a tab) refuse `discounts` with `discounts_on_tab`
  until phase 2.

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

### App (operator)

- **Routes** under `apps/app/app/routes/_app+/$orgSlug_+/menu+/`:
  - `discounts._index.tsx`: list with Automatic and Coupons filters, status, a
    schedule summary and uses.
  - `discounts.new.tsx` and `discounts.$discountId.tsx`.
  - Nav entry under Menu, behind `discounts.enabled`.
- **Access:** `requireDiscountsAccess` (permission plus flag) runs first in
  every loader and action, with `discounts-guards.test.ts` checking that.
- **Writes** go to D1 through App actions, because definitions live in the
  control plane. Every save bumps `version`, and a stale `expectedVersion`
  gets 409.
- **Uses** are read browser-direct from the region with a short-lived `dsc+jwt`
  (`GET /:orgSlug/discounts/token`), following loyalty. Region route:
  `GET /operator/discounts/usage?ids=`, with counts only.
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
  - **Codes:** one or more, each with an optional use limit.
  - **Options:** combinable, priority.
  - A live preview of the engine against a sample cart.
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
  - Rate-limited per IP, per organization and per signed-in customer.
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
- **Kill switch:** tenant-api `DISCOUNTS_ENABLED`. When false, the region
  ignores every discount and refuses requests with codes (`discounts_disabled`).

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

### Related fix (separate PR)

Online pricing ignores the item-level `applySalesTax` setting
(`restaurant-orders.ts` always taxes the base price). Fix it before or alongside
phase 1 so line-level discounts reduce the right taxable amount.

### Rollout

1. Control-plane migration `0031`, then App: editor behind the flag,
   order-context fields, checkout guard.
2. tenant-api migration `0026`, then tenant-api.
3. Sites.
4. Turn on `discounts.enabled` and its sub-flags per organization.
