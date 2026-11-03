# Loyalty growth plan

Status: proposal, nothing built. Follow-up to [loyalty.md](./loyalty.md), which
describes what exists. This plan comes from a comparison with Square Loyalty
(setup wizard walked through on 2026-11-02; tiers, promotions and marketing
taken from Square's public help pages, not tested hands-on, because they sit
behind a paid subscription).

## Where we stand

The engine is stronger than Square's on trust and correctness: append-only
ledger, refund reversal, redemption holds, a review queue, per-node kill
switches, regional data residency, and approval-based spending at the till. The
gaps are on the growth side:

| Area                         | Square                                            | Menuza today                                                                         |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Earning types                | Spend, visit, item, category                      | Same four                                                                            |
| Per-item point values        | Yes (one value per item or category)              | No: one `points` value for every selected item or category                           |
| Join at the register         | Phone number at checkout                          | Not possible: the till identifies by member code only (`POST /pos/loyalty/identify`) |
| Bonus-point promotions       | Yes (limited-time or recurring)                   | None                                                                                 |
| Tiers                        | Yes (threshold, name, benefit)                    | None                                                                                 |
| Expiry                       | Never, 3, 6, 12, 18, 24 months, SMS 14 days ahead | None                                                                                 |
| Marketing from loyalty state | Built in                                          | None (no loyalty trigger, no audience filter)                                        |
| Setup guidance               | 4-step wizard, suggested program and rewards      | Editor plus a setup preview                                                          |
| Unit naming                  | Points, Stars, or custom singular and plural      | `points` or `stars` only (`LOYALTY_UNIT_LABELS`)                                     |
| Reward display name          | Separate from the internal reward                 | One `name` plus an optional `description` on the reward                              |

## Priorities

1. [Join and earn at the till](#1-join-and-earn-at-the-till)
2. [Loyalty-driven marketing](#2-loyalty-driven-marketing)
3. [Promotions (bonus points)](#3-promotions-bonus-points)
4. Later: expiry, tiers, per-item points, guided setup, custom unit names
   ([notes](#later))

## 1. Join and earn at the till

**Problem.** Earning needs a verified customer account, and the only way to
identify someone at the till is their member code, shown in the wallet after
they have signed in on the website or the app. A walk-in guest who has never
signed in cannot earn. A POS-only phone contact is never auto-linked, by design
(see [Automatic enrollment](./loyalty.md#automatic-enrollment)).

**Proposal.** Let the cashier enter a phone number. Ownership is proven with the
regional OTP flow that approvals already use, which turns the POS contact into a
verified customer. From then on the person is a normal member.

- New till routes under `/pos/loyalty/*`: `POST /lookup-or-join` (phone in, OTP
  sent) and `POST /lookup-or-join/verify` (OTP in, binding out, the same binding
  `identify` returns). Reuse the OTP sender, per-device, per-approval and
  per-member rate limits, and the `AUTH_HMAC_SECRET` hashing of the approvals
  flow.
- Verification links the existing POS contact to the verified customer, or
  creates the customer. It never links on the phone number alone. It never sets
  marketing consent (unchanged rule).
- The earning path stays what it is: a sale uploaded with a binding earns after
  sync. Spending still needs the member's approval.
- Station screens: phone entry, OTP entry, "member found", and a skip. These are
  the Station screens that are not built yet, so this item and the existing gap
  are one piece of work.
- Receipt-time option: a QR code on the printed or screen receipt that opens the
  wallet sign-in for the sale just made, for guests who prefer their own phone.

**Decisions (settled).**

- Kill switch: reuse `LOYALTY_ENABLED` rather than a new one.
- Enrollment stays automatic: verifying the phone at the till joins the program,
  the same as signing in on Sites or the app. There is no opt-in step and no
  opt-out. The till shows a short line that says so (program name and "your
  phone number joins the rewards program") before the OTP is sent, so the guest
  is informed even though they are not asked to accept. Marketing consent stays
  a separate record and is never set here.
- A sale rung up before the guest joined can be attached afterwards, within the
  same business day, through the existing review queue decision "award
  purchase", so there is an audit trail. Later sales earn normally; sales older
  than the business day are not backfilled.

**Acceptance.** A guest with no account gives a phone number, enters the OTP,
and the sale earns points after sync. A wrong phone, an expired OTP, a replay
and a second terminal all fail closed. Tests join `loyalty-security.test.ts`
(every till route: forged device, missing staff session, cross-organization).

## 2. Loyalty-driven marketing

**Problem.** `docs/loyalty.md` says there is no loyalty campaign sender and no
audience filters. Points only matter if they bring people back.

**Proposal.** Follow the pattern reservations used: new journey triggers plus
merge tags, reusing the existing coupon offer and consent rules.

New trigger types in `JOURNEY_TRIGGER_TYPES`
(`packages/tenant-db/src/types/journey.ts`):

| Trigger                    | Fires when                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `loyalty_reward_available` | A member's available balance first reaches a reward threshold |
| `loyalty_near_reward`      | A member is within N points (or a % of cost) of a reward      |
| `loyalty_inactive`         | A member with a balance has not earned or redeemed for N days |
| `loyalty_points_expiring`  | Only once expiry exists; N days before points lapse           |

- Triggers are raised from the same loyalty outbox that already settles
  purchases, with ids only. No points or names cross planes (same rule as
  staffing events).
- Merge tags: `{{pointsBalance}}`, `{{pointsToNextReward}}`,
  `{{nextRewardName}}`. Add them to `packages/common/src/merge-tags.ts` with
  fallbacks.
- Consent is unchanged: sending still needs an active `customer_subscriptions`
  row for the channel and topic, rechecked at send time. A loyalty account is
  never consent.
- Audience filters on broadcasts ("members with at least N points", "members
  inactive for N days") narrow the existing audience in `marketing-audience.ts`.
  Add a `loyalty.marketing` flag with them, as the docs already anticipate.
- Birthday points are a later addition: they need a birthday field, which is
  more PII, so decide that separately.

**Acceptance.** A member who crosses a threshold gets one message, not one per
sale (journey de-duplication). A member without marketing consent gets nothing.
Turning the flag off stops new triggers and lets running journeys finish.

## 3. Promotions (bonus points)

**Problem.** Operators cannot steer behavior with points: slow-day boosts, happy
hour, launch a new item. Square sells this as a first-class feature.

**Proposal.** A promotion is a versioned, immutable rule, like program versions
and discount definitions, that adjusts what a purchase earns.

```ts
// Sketch, in packages/loyalty/src/promotions.ts
type LoyaltyPromotion = {
	id: string
	name: string // shown in the wallet and receipts
	kind: 'multiplier' | 'bonus' // 2x points, or +N points
	value: number // basis points for multiplier; points for bonus
	scope: 'order' | { itemIds: string[] } | { categoryIds: string[] }
	schedule: {
		startsAt: number
		endsAt: number | null
		recurring?: { weekdays: number[]; fromMinute: number; toMinute: number }
	} // evaluated in the program time zone
	locationIds: string[] | null // null means every location
	maxPointsPerPurchase: number | null
	stacking: 'best' | 'add' // default 'best': one promotion per purchase
}
```

- Evaluation lives in `@repo/loyalty/src/earning.ts` as a pure step after base
  earning, so the frozen acceptance examples stay valid. The applied promotion
  ids and versions are snapshotted on the purchase, like the program version, so
  later edits never change past awards.
- Refund reversal uses the snapshot, as today: bonus points reverse
  proportionally with the base points.
- Ledger entries carry a reason (`promotion`) so Activity and reports can show
  the cost of a promotion.
- Operator UI: a Promotions page under Loyalty, with a live example ("a $20
  order on Tuesday earns 40 instead of 20") built from the same engine as the
  setup preview. Requires a new permission (suggest
  `update:loyalty_promotion:any`) and a `loyalty.promotions` flag.
- Safeguards: the per-purchase cap above, the existing `LOYALTY_MAX_POINTS`, and
  a report line showing points granted by each promotion.

**Acceptance.** Add frozen examples next to the existing ones: multiplier
rounding (round down once per order, after the multiplier), a promotion outside
its window earns nothing extra, `best` versus `add` stacking, a partial refund
of a boosted purchase, and a location-scoped promotion at another location.

## Later

These are lower priority for restaurants, or depend on the items above.

- **Expiry.** Prefer inactivity expiry ("points lapse after N months with no
  earn or redeem") over per-point expiry: it works on the ledger without
  tracking buckets. Needs a lapse ledger entry type, a warning trigger (see item
  2), an operator setting that applies to future activity only, and an explicit
  decision for existing balances (recommended: not retroactive).
- **Tiers.** A rolling 12-month earned total sets a tier, and the tier sets an
  earning multiplier, which reuses the promotion multiplier path. Settle expiry
  and the meaning of `lifetimeEarned` first.
- **Per-item and per-category points.** Replace the single `points` on the
  `items` and `categories` rules with a list of `{ id, points }`. This is a
  contract change to `loyaltyEarningRuleSchema`; since there is no backward
  compatibility requirement, migrate in place.
- **Guided setup.** Suggest a starter program from the organization's average
  order value and show reward costs as "about N spent". Extends the Overview
  preview.
- **Custom unit names.** Allow a singular and plural pair instead of the
  `points` / `stars` enum. Needs translations for `ar`, so store one pair per
  language.
- **Separate reward display name.** Only if operators want internal reward names
  that differ from what customers see.
- **Explicit opt-in.** Decided against: enrollment stays automatic (see
  [Automatic enrollment](./loyalty.md#automatic-enrollment)). Revisit only if an
  organization whose rules require explicit consent needs to be supported.

## Version skew

App deploys before tenant-api. The report schema (`loyaltyReportSchema`)
defaults `promotions` to zero bonus points and no rows, so an Overview served by
a region that predates promotions still parses and shows zeros.

## Known limitation: promotion bonus on partial refunds

A refund is recorded as one cumulative amount with no line detail, so the bonus
a promotion gave is taken back in proportion to the share of all eligible
merchandise refunded, not to the items the promotion covered. Refunding an item
outside the promotion's scope therefore reverses part of the bonus. Fixing it
needs per-line refunds in the refund contract (operator request,
`restaurant_order_refunds` migration) and per-line bonus attribution in
`appliedPromotions`. Old rows would keep the proportional rule. Follow-up.

## Suggested order of work

1. Item 1 (till join), together with the Station loyalty screens already owed.
2. Item 3 (promotions). Small, contained in the pure engine, high operator
   value.
3. Item 2 (marketing triggers). Larger, because it touches journeys, merge tags
   and audience filters; start with `loyalty_near_reward` and
   `loyalty_inactive`.
4. Later items as demand shows.

Each item keeps the existing rules: regional data only, no PII across planes,
flags default off, a route-level security test, and a frozen acceptance example
for every earning or reversal change.
