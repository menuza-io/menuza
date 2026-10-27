# QR ordering

Guests scan a QR code on their table, order rounds from their phone, and pay
once when they leave, either at the counter or from the phone. Order-ahead
posters open the normal pickup menu for one location. This is the operator guide
and the runbook. The browser and region contract is in
[restaurant-ordering-contract.md](./restaurant-ordering-contract.md#qr-table-ordering).

## How it works

- **A tab per table.** The first round from a table opens a tab; every later
  round from any phone at that table joins it. A tab's rounds are ordinary
  restaurant orders (`fulfillment: 'dine_in'`, `paymentMethod: 'handoff'`), so
  the Orders inbox, reports, the customer's order history, the Staff demand
  source and the kitchen display all see them per round.
- **Data stays regional.** Tables (`qr_tables`), tabs (`qr_tabs`) and settings
  (`qr_settings`) live in the organization's regional tenant database, like
  every order. The guest's name and phone on a tab are covered by person
  erasure.
- **Capabilities, not logins.** A table code is an HMAC of the table id and its
  version under the region's `AUTH_HMAC_SECRET`; a tab code works the same way.
  Nothing is stored. Codes ride in the URL fragment (`/menu?location=…#table=…`,
  never sent to any server), are moved out of the address bar by an inline head
  script before any analytics tag loads (into this tab's `sessionStorage`, read
  once by the menu script), and reach tenant-api only in the `X-Table-Token` /
  `X-Tab-Token` headers. The tab code is kept in the guest's `localStorage`, so
  a re-scan or a closed browser resumes the tab.
- **Prices are the region's.** Every round is repriced from the live menu inside
  the placement transaction, exactly like a pickup order. Tips are only taken
  when the tab is paid online.

## Turning it on

Organization flags (Admin, Feature Flags), all default off; only a literal
`true` counts and children need the master:

| Flag                  | What it does                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `qr_ordering.enabled` | Settings, QR tables in the App; order-ahead poster tagging                                  |
| `qr_ordering.dine_in` | Guests can order at the table; open tabs in the Orders page                                 |
| `qr_ordering.online`  | Guests can pay the tab from the phone (also needs online payments set up in Settings, Shop) |

The location must offer dine-in (Locations, fulfillment options). Local demo
data: `npm run seed:qr -w tenant-api -- acme` (turns on the flags, creates
tables T1 to T8 and prints one table URL).

## Tables

**Settings, QR tables** (`/settings/qr-tables`; the old `/qr/tables` link
redirects). Add one label, a range (`T1-T12`) or a comma list. With reservations
on, **Import floor plan** creates a QR table per floor-plan table, links tables
that already have the same label, follows renames and archives tables removed
from the floor plan. Importing again is safe; codes never change on import.

- **New QR code** burns every printed card for that table (confirm dialog). Use
  it when a card was copied or stolen, then print the new card. It also burns
  the code of the tab open at that table (someone who scanned the old card may
  have joined it) and drops a pay request nobody has bound yet: guests at the
  table re-scan the new card to rejoin their tab.
- **Archive** is refused while a tab is open at the table.
- **Print table cards** opens the Print shop (see
  [print-shop.md](./print-shop.md)), which renders one card per table with its
  own code.

## Settings

**Settings, QR tables, Ordering options** (`/settings/qr-ordering`). Ask for the
guest's name and/or phone (asked once, on the first round of a tab), allow
paying from the phone, and the per-table limit of rounds per hour (default 12; a
durable count from the rounds themselves). Paying from the phone always asks for
a name and phone number.

## Running a service

- **Kitchen display:** each round is its own online dine-in ticket with the
  table label. Staging advances the round's status forward only; Done never
  marks anything paid.
- **Orders page:** open tabs sit above the order list with the table, tab
  number, age, guest name, running total and each round's status. Rounds keep
  their own status buttons below; a table round completes without per-round
  payment (paid at tab close). The list shows while `qr_ordering.enabled` is on,
  even with dine-in switched off, so tabs still open can be settled. Below it,
  **Online payments to check** lists closed or voided tabs that received online
  money in the last 14 days (`GET /operator/qr/tabs?status=review`).
- **Close at counter:** take the money (optionally record a tip), then close.
  Every round that still counts is marked paid and the totals are kept on the
  tab. Closing does not wait for the kitchen (your call). The App sends the
  total shown in the dialog (`expectedTotalCents`); a round that lands meanwhile
  answers 409 `stale_tab` and the dialog shows the new total.
- **Void:** nothing is charged; unfinished rounds are cancelled. A reason is
  required. Void checks the shown total the same way.
- **Lock:** stops every phone from adding to or paying the tab (a re-scan is
  refused too) while staff settle it. Close or void ends it.
- **A new party at the table:** close or void the previous tab first; the table
  code then opens a new tab.
- **Station till:** if you ring a QR tab on the till, the till sale is the money
  record; then close the QR tab at the counter so the table frees up.

## Paying from the phone

The guest taps **Pay now** in the tab drawer once every round has left the
kitchen queue (no round is Received or Preparing), picks a tip (on the
subtotal), enters name and phone and pays on the hosted page of the
organization's processor (Stripe Connect in the US, Checkout.com anywhere). The
tab rides the restaurant-order payment bridge as the order `tab:<id>`, with the
same metadata, idempotency, single bind and provider reconciliation as online
orders. While a payment is open the tab total is frozen: new rounds and counter
close or void are refused until the session ends, or for at most 45 minutes (a
Stripe page expires 40 minutes after the pay request, or 31 minutes after the
hold when that is later). After the hold, the next pay request or round forgets
the dead binding (Checkout.com never reports expiry). The freeze runs from the
first pay request: asking again, even with another tip, re-prices the payment
but never restarts it; a different tip while a page is live is refused. A Stripe
session's idempotency key carries its exact expiry, and a cached session that
has expired is replaced by a new one instead of failing.

- Only a verified provider event (or the App's provider lookup) closes a tab; a
  redirect never does.
- A failed or expired session unbinds; the guest can try again or pay at the
  counter.
- **Stop online payment:** when the guest gave up on the payment page, staff tap
  **Stop online payment** on the open tab
  (`POST /operator/qr/tabs/:id/release-payment`). The session is unbound and the
  tab can be closed at the counter; the response names the released session and
  the browser hands it to the App (`POST /<org>/qr/release-session`, ids only),
  which expires a Stripe page after checking it belongs to that tab.
  Checkout.com pages cannot be expired. Lock clears an unbound pay request.
- **Needs review:** money that does not match the tab (a different amount, a
  stopped or replaced session, a tab already settled) never closes it. Each such
  payment is one append-only `qr_tab_payments` row (tenant migration
  `0024_qr_tab_payments`), so a second payment never hides the first. Stripe
  rows are keyed by session; Checkout.com binds one reference per tab, so its
  rows are keyed by the payment id the bridge now forwards (`paymentId`). The
  tab shows **Paid online, needs review** with the count and sum; close and void
  then ask staff to confirm they checked the payments
  (`acknowledgeReview: true`), and the tab keeps `paymentStatus: 'review'`.
- **Late payment on a settled tab:** counter close and void drop the online
  binding and return it (`releasedSession`, like Stop online payment), so the
  App expires the guest's Stripe page; a tab paid online remembers the payment
  that settled it, so only an exact replay of that payment is treated as one.
  Any other money is a `qr_tab_payments` row; a tab already paid keeps its own
  settlement (status and time) and shows the extra money through its rows, while
  a voided tab becomes `review`. Either way it shows under **Online payments to
  check** for 14 days. Refund it from the processor dashboard or keep it as the
  payment, and note it on the bill.

## Kill switch

`QR_DINE_IN_ENABLED=false` on a tenant-api node (also `0`, `off`, `no`,
`disabled`) answers 503 on dine-in placement, the table and tab context
(`GET /orders/options` with a table code, `GET /orders/tab`), starting a tab
payment and the bridge's quote and bind for `tab:` ids. Pickup, delivery,
posters and every operator route keep working, so staff can still close tabs at
the counter. Payment events for tabs already paying are still applied.

## Known limits

- KSA: online orders, QR tabs included, are not ZATCA fiscal documents; only
  Station till sales are. Settle on the till when a fiscal invoice is needed.
- One kitchen ticket per round; grouping a table's rounds into one ticket, table
  transfers and split bills are not supported yet.
- Native iOS and Android apps do not offer table ordering yet; the contract
  changes are additive.
