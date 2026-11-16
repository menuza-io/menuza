# Gift cards

Restaurant gift cards: one regional ledger per organization, sold online and at
the Station till, spent online and at the till as a payment, and managed from
the App. A card works at every location of the organization, in its own currency
only. This document is the operator and engineering reference: architecture,
rules, flags, secrets, runbook and what is not built yet.

Status: built behind flags (default off) and not enabled for any organization.
Issues: #110 (core), #218 (purchase fraud), #217 (guest wallet), #215 (App
charges), #214 (designs and promotion), #213 (physical cards), #216 (location
reports and settlement), #212 (guided import).

## Status by surface

| Surface                                                               | State                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Regional ledger, sell, top up, redeem, refund to card, adjust, void   | Built                                                              |
| Online purchase (hosted checkout, `gc:<id>`), delivery email, receipt | Built                                                              |
| Add a gift card at the Sites checkout                                 | Built                                                              |
| Station: sell, top up, redeem as a tender; ZATCA payment means        | Built                                                              |
| App: list, detail, adjust, void, review, settings                     | Built                                                              |
| Purchase fraud: limits, timed hold, risk hold, freeze, burst alerts   | Built (#218)                                                       |
| Guest wallet on Sites (saved cards, QR show token)                    | Built (#217); customer app **not built**                           |
| Charge from the App (#215)                                            | Built: dialogs and history; attaching to an order or quote **not** |
| Designs and the buy form, delivery email (#214)                       | Built; website block and email designer block **not built**        |
| Reports: sales, redemptions, balances, settlement (#216)              | Built as report subjects; no dedicated screen                      |
| Physical cards and Print shop (#213)                                  | Not built                                                          |
| Guided import (#212)                                                  | Not built                                                          |

## Where the data lives

- **Region** (`packages/tenant-db`, migration `0047_gift_cards`): `gift_cards`,
  the append-only `gift_card_ledger`, `gift_card_attempts` (guess and purchase
  windows) and the purchase and review tables. Purchaser and recipient name and
  email, codes and balances stay here. Nothing about a card is written to the US
  control plane.
- **Control plane** (`0050_gift_cards`): the flags, the three permissions, the
  settings (presets, bounds, designs, limits) and the report access. The App
  sees `gc:<id>`, last four characters, amounts and statuses only.
- **Operator calls** use a short-lived `gft+jwt` the App mints
  (`GET /<orgSlug>/gift-cards-token`); the browser calls tenant-api
  `/operator/gift-cards/*` directly. Sites never proxies a card: a test fails if
  its server code imports the browser client.

## Rules

- The balance is the sum of the ledger, never a stored number. A trigger refuses
  an entry that would take a balance below zero or redeem a card that is not
  active, so two writers racing cannot overspend even without the lock.
- Every write goes through `withGiftCardWrite` (the organization lock shared
  with orders and loyalty, one transaction, durable idempotency). A replay with
  the same key is safe; the same key with different input is
  `idempotency_conflict`.
- A redemption is at most the balance and at most the order total
  (`gift_card_balance_low`). Refunding an order returns the card's part to the
  card first, never more than that redemption took
  (`gift_card_refund_exceeds_charge`).
- Selling a card is not a sale of food: no discounts, no loyalty points, no VAT
  line. Redeeming one is a tender, not a discount; the food still earns points
  and carries its VAT (KSA: VAT is charged on redemption, never on the sale).
- A processing or service fee on a purchase is its own line and never part of
  the card's balance.
- Codes are 16 characters from an unambiguous alphabet (80 bits), stored only as
  an HMAC with the last four characters kept readable. A purchased card's code
  is sealed in the region until the recipient email has gone out, then cleared.
- US cards never expire by default (`expiryMonths` is null).

## Purchase fraud (#218)

Operator limits (Settings, one table for every currency, whole currency units):
card 500, purchase 500, 3 purchases per payment card, buyer email and device in
24 hours, a 2-hour hold for a first-time buyer's immediate card of 100 or more,
and an alert at 5 purchases from one device in an hour. They are checked
**before** payment and a refusal never says which limit was hit.

- `held`: a first-time high-value card waits for the hold to end (the tick
  releases it), or a provider elevated-risk card waits for a manager: App, Gift
  cards, Needs review (Approve or Refund).
- `frozen`: a disputed purchase freezes the card at once; the remaining balance
  is removed if the dispute is lost and the detail shows what was spent first.
- A purchase refund is limited to the unspent balance.
- Till cash and present-card sales and top-ups are never delayed.
- Fingerprints (payment, email, device) are stored hashed, never raw.
- Wrong code guesses are limited per address, customer, terminal and
  organization. Windows are fixed (up to twice a budget across a boundary,
  harmless against 80-bit codes). Guests whose address cannot be resolved share
  one `unknown` bucket per organization; the balance check also needs Turnstile.
  One signed-in customer may start 10 purchases an hour.

## Flags, permissions, environment

- Flags (default off, only a literal `true`): `gift_cards.enabled` (master),
  `gift_cards.online`, `gift_cards.pos`. A child needs the master.
- Permissions: `read:gift_card:any`, `update:gift_card:any`,
  `update:gift_card_charge:any` (charge without free adjustment; never while
  impersonating).
- tenant-api: `GIFT_CARDS_ENABLED` (node kill switch: `false` answers 503
  `gift_cards_unavailable` on new sales, top-ups and redemptions; balance reads,
  refunds to a card, paid events and the tick keep working),
  `GIFT_CARDS_TICK_INTERVAL_SECONDS` (Node runtime only, default 120, minimum
  60, `0` off; Workers use Durable Object alarms), `GIFT_CARD_HMAC_SECRET`.

### Secrets

`GIFT_CARD_HMAC_SECRET` (32 or more characters) keys every gift card hash (code,
external number, fingerprints, QR token, limiter subjects) and the sealing of a
purchased code. Unset, `AUTH_HMAC_SECRET` is used, so a database built that way
keeps working.

**Choose it before the first card is sold and never change it.** Every code hash
depends on it, and there is no re-keying step: a changed key makes existing
cards unfindable. With the dedicated key set, rotating `AUTH_HMAC_SECRET` for an
OTP or session reason leaves cards alone. A sealed code carries a key id, so a
changed key is reported as a configuration error (the delivery pass stops, gives
the attempt back and logs the card id) and never mistaken for corrupt data.

## Deploy order

App (flags, permissions, settings, token mint, context route), then tenant-api,
then Sites, then Station. Set `GIFT_CARD_HMAC_SECRET` on every node of a region
before enabling `gift_cards.enabled` for any organization there.

## Runbook

- **Stop new sales now:** `GIFT_CARDS_ENABLED=false` on the node. Balances stay
  readable and refunds still work.
- **A card is held:** App, Gift cards, Needs review. Approve releases it; Refund
  returns the unspent balance (all of it, or an amount up to it), and a full
  refund voids the card.
- **A delivery email did not go out:** the tick retries up to a fixed number of
  attempts and then notifies the managers; a configuration problem does not burn
  attempts.
- **Cards unfindable after a secret change:** restore the previous
  `GIFT_CARD_HMAC_SECRET` (or `AUTH_HMAC_SECRET` if none was set).

## Known issues and not built

- No re-keying of code hashes (see Secrets).
- Customer app wallet, order and quote attach for App charges, the website
  block, the email designer block, physical cards and the guided import are
  tracked by the issues listed at the top and are not part of this build yet.
- Not verified here: a live hosted payment, a real Turnstile, a provider risk or
  dispute event (the region logic is tested with injected values), ZATCA against
  a live filing, and the accessibility of the Sites forms in a browser.
