# Marketing audiences, order triggers and ready-made programs

Issues #98, #99, #100, #150, #151 (AI drafts, #155, are in
`platform-marketing-email.md`). Everything here reuses the journey engine, the
broadcast sender, the consent rules and the email designer. There is no second
runtime.

Guest data stays regional (`docs/tenant-data-residency.md`): audiences, order
history, birthdays and carts live in the organization's tenant database. The App
sees definitions, ids, counts and templates, never a guest.

## Flags (all default off, only a literal `true` counts)

| Flag                          | Turns on                                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `marketing.audiences`         | Marketing, Audiences; "Send to" on broadcasts; the condition "Saved audience" in automations |
| `marketing.order_automations` | the order triggers, the goal, the Programs cards, Marketing settings |
| `marketing.birthdays`         | the Birthday trigger and the Birthday treat program        |
| `marketing.cart_reminders`    | the Cart trigger and program (needs order automations too) |
| `ai.marketing_drafts`         | Draft with AI (#155)                                       |

Helpers: `apps/app/app/utils/marketing/marketing-flags.server.ts`.

## Saved audiences (#98)

- Pure schema: `packages/common/src/marketing-audiences.ts` (rules, limits, the
  ready-made audiences, the sensitive-field check). SQL compiler:
  `apps/tenant-api/src/services/marketing-audience-rules.ts`. CRUD, counts and the
  send-time lookup: `marketing-audience-service.ts`. Routes:
  `/operator/marketing/audiences` (+ `POST /preview`), marketing-area token.
- Rules: orders count and net spend (with a window and locations), days since the
  last order, top N percent by spend, visits, days since the last visit, upcoming
  reservation, loyalty member, points, near a reward, verified phone, joined
  recently. "All of" or "any of". 50 audiences, 20 rules.
- An audience only ever **narrows** consent: `loadBroadcastAudience` judges
  consent first and ANDs the audience's condition (`audienceWhere`). Membership is
  worked out when the send starts, never stored; a broadcast keeps only
  `{ audienceId, audienceVersion }` in `segmentation_rules`. A deleted audience
  fails the send, it never widens it to everyone.
- Tags, allergy and dietary data cannot be rules (`sensitive_rule_not_allowed`).
  A location-scoped token stays inside its locations (`location_out_of_scope`).
  Deleting an audience that a broadcast (Draft, Scheduled, Processing) or an
  automation uses is refused (`audience_in_use`).
- Previews return counts only, and a count below 5 is `null` ("Fewer than 5").
  Nothing in a response, a definition or a log is a guest.
- What counts as an order (`services/marketing-orders.ts`, shared with order
  journeys): a website order that is accepted/preparing/ready/completed and
  payable (paid online, free, or pay at pickup), not refunded in full; a paid
  Station sale whose `customer_phone` is a customer's phone (so a Station sale
  linked to a guest counts, including as a first order). Spend is in minor
  units, refunds taken off.
- Evaluation is direct queries. `customer_order_stats` was not added: nothing
  measured needed it. Revisit with a measurement if an organization has very large
  order history.

## Order triggers, goal and frequency cap (#99)

- Triggers: `order_first_placed`, `order_completed` (optional "only the Nth"),
  `guest_lapsed` (30/60/90/120/180 days). Service: `services/order-journeys.ts`.
- Idempotency: `order_journey_emissions` `(customer, trigger, ref)` is **claimed**
  (`pending`) before the journey starts, promoted to `fired` after, dropped if the
  start failed, retried when a claim is stale. Two orders at once start one run.
  First order: ref `first`; completed: the order; lapsed: journey + last order
  time (once per quiet spell, re-armed by the next order).
- Not retroactive: an order older than the journey's publish time never starts
  it. Orders with no linked guest fire nothing. A fired trigger is never undone by
  a later refund or cancel; a cancelled, unpaid or fully refunded order never
  fires.
- Goal: `marketing_journeys.goal = 'order'` ("Stop when the guest places an
  order"). Checked before every step (a step runs after its delay), by
  `goalReachedForRun`; the run ends `cancelled` with the reason "Goal reached".
  The editor keeps the switch in the trigger's settings and the App sends it as
  `goal`.
- Frequency cap: `marketing_settings` row `frequency_cap` (`{limit, days: 7}`).
  Counts `marketing_messages` (broadcasts and automation steps; failed sends do
  not count; receipts and other order messages are not in that table). A step over
  the cap is skipped with `skipReason: frequency_capped`; a broadcast skips capped
  guests. **No row, no cap** (so organizations that do not use this feature behave
  as before); turning a program on writes the default of 3 per 7 days once, and
  "No limit" on the settings page is remembered.
- New condition fields: `orders_last_30_days`, `orders_last_90_days`,
  `days_since_last_order`, `lifetime_spend`, `has_upcoming_reservation`,
  `audience`.

## Ready-made programs (#100)

Templates are data in `packages/marketing-workflow/src/programs.ts` (versioned,
English and Arabic copy). "Turn on" (`apps/app/app/utils/marketing/programs.server.ts`)
builds the journey in the organization's branding and site language, renders the
emails, wires the optional coupon (`checkJourneyOffers`) and creates + publishes
it. The journey keeps `program_id` and `program_version`; later template changes
never rewrite it. One live journey per program (`program_already_active`, a
unique index). A card appears only when its trigger is available, and nothing is
on by default.

Results (30 days): runs, messages delivered, and orders by goal, from
`GET /operator/journeys/program-results` (counts only).

Known gap: the Google review page for "After your visit" is not stored anywhere,
so the owner pastes the link when turning the program on.

## Birthdays (#151)

`customers.birth_month_day` (`MM-DD`, year never kept) and
`birth_month_day_set_at`. Set on Sites `/profile`, after sign-in, the customer app
Profile, or by staff on the person page (`PATCH /operator/people/:key`,
`update:customer:any`). `invalid_birthday` never echoes the value. Cleared with
the customer on erasure; never in an export, a log or a cross-plane payload (the
journey context carries only the year).

Trigger `birthday_coming_up` (`services/birthday-journeys.ts`): N days before
(default 7), from 10:00 local time (the zone of the guest's latest order, else the
journey's `timeZone`, else a reservations location, else UTC). Once per guest per
year per journey (`<year>:<journey>`); editing the birthday after it fired never
fires it again that year. 29 February is celebrated on 28 February in a non-leap
year. A birthday is not consent.

## Cart left behind (#150)

`customer_carts` holds ids and quantities only (no contact, address or notes). It
is written on `POST /orders/quote` for a signed-in guest with a verified phone and
marketing consent, only while a cart journey is active. Cleared by an order,
`POST /orders/cart/clear`, the 7-day cleanup and person erasure. The tick starts
`cart_left_behind` after the delay (default 1 hour, editable in Marketing
settings), above the smallest cart (default 1 unit), at most once per guest per 24
hours. The "Back to your order" link is `<site>/menu#cart=<token>`: the token
(`lib/cart-link.ts`, HMAC over the organization, guest and expiry, 7 days) is in
the URL **fragment**, read from `X-Cart-Token` by `GET /orders/cart-link`; the site
server never sees it. Merge tag `{{cartLink}}` follows the URL-attribute rules of
`replaceMergeTokensInHtml`.

Limitation: the quote endpoint answers 404 `discounts_disabled` while discounts and
gift cards are both off, so a cart is only remembered for organizations where the
checkout quote succeeds.

## Deploy order

tenant-api (migration `0048`, audience compiler, triggers, ticks, cart snapshot),
then App (audiences, programs, settings), then Sites and the customer app
(birthday, cart restore).
