# Station: point of sale (`apps/station`)

An offline-first till for orders taken in the restaurant. It runs as a PWA on a
tablet or phone, keeps every order in IndexedDB first, and uploads each revision
of an order to the organization's **regional** tenant-api. Order contents never
pass through the US control plane (see `docs/tenant-data-residency.md`).

The app and npm workspace are named **Station**. POS remains the name of the
order contracts and regional API module. Existing POS URLs, environment
variables, and device storage keys are retained so the rename does not strand
paired devices or offline orders.

## Pieces

| Where                                            | What                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/station`                                   | The tablet app (Vite, React, Dexie). `src/lib/orders.ts` is the order lifecycle, `src/lib/outbox.ts` the upload queue, `src/lib/fiscal.ts` the fiscal chain. |
| `packages/common/src/pos-orders.ts`              | Wire contract (Zod), credentials, `POS_CONTRACT_VERSION`.                                                                                                    |
| `packages/common/src/pos-fiscal.ts`              | Fiscal document chain (SHA-256, synchronous) and the ZATCA Phase 1 QR payload.                                                                               |
| `packages/common/src/pos-reports.ts`             | The sales summary behind the till's Z report and the server's shift and day reports.                                                                         |
| `packages/zatca` (`@repo/zatca`)                 | ZATCA Phase 2: EGS keys and CSR, UBL simplified invoices and credit and debit notes, the XAdES signature, the Phase 2 QR code, and the Fatoora API client.   |
| `packages/tenant-db` (migrations 0020, 0021)     | `pos_*` tables, their append-only triggers, and phone pickup details.                                                                                        |
| `apps/tenant-api/src/routes/pos.ts`              | Terminal routes: `/pos/pair`, `/pos/me`, `/pos/sign-in`, `/pos/orders`, `/pos/shifts`, `/pos/tabs`, `/pos/tabs/:id/claim`, `/pos/zatca`.                     |
| `apps/tenant-api/src/routes/operator-pos.ts`     | Manager routes under `/operator/pos` (terminals, pairing codes, orders, revisions, held uploads, staff and managers, shifts, day reports, ZATCA).            |
| `apps/tenant-api/src/routes/pos-timeclock.ts`    | The time clock on a terminal: `/pos/timeclock/identify`, `/pos/timeclock/punch` (see [Station apps](#station-apps-time-clock-and-host-stand)).               |
| `apps/tenant-api/src/routes/pos-reservations.ts` | The host stand's token: `POST /pos/reservations/token`.                                                                                                      |
| `apps/app` → Settings → Terminals                | Pair and remove terminals, PIN sign-in, shifts, business day, till managers, held uploads, the day report, ZATCA settings and onboarding.                    |

## Trust model

A terminal is trusted to say what it sold, because it may have sold it offline.
The server checks the arithmetic, reprices the lines against the live menu only
to **flag** differences (`review_reason`), and never refuses a sale the till
already took money for.

- **Review reasons** stick: the first reason found stays on the order; every
  revision's own verdict is on `pos_order_revisions`. `stale_price`, `stale_tax`
  and `stale_catalog:*` mean the till's menu was over 10 minutes old at the
  sale, or the upload arrived over 10 minutes after it: probably a menu change,
  not a wrong charge. `price_mismatch`, `tax_mismatch` and `catalog:*` mean the
  till had a fresh menu. Other reasons: `unverified` (menu unreachable),
  `clock_skew`, `missing_staff`, `unknown_staff`, `inactive_staff`,
  `approver_not_manager`, `large_discount` (a discount over half the subtotal),
  `fiscal:*`. A later revision reuses the previous menu check only when its
  lines, adjustments and totals are all unchanged; otherwise it is checked
  again.
- **Held uploads.** An upload the server cannot apply is stored in
  `pos_held_uploads` and answered `202 { result: 'held' }`. This covers an
  unreadable contract (an out-of-date till or node), a change to a closed bill,
  a tab that moved, a wrong location, a removed terminal's tab continued by
  another terminal (`order_owned_by_removed_terminal`), and a different body
  sent again at the same revision (`revision_conflict`). The till stops
  resending it, and managers settle it on the Terminals page. Only
  `number_conflict` is answered 409, and the till renumbers.
  - **Limits.** 64 KB per entry (signed ZATCA XML is dropped first), 20
    unreadable bodies of at most 4 KB per terminal, 1000 unsettled per terminal
    and 5000 per organization; beyond that the terminal gets 429 `held_limit`
    and retries later.
  - **Personal data.** Guest and customer names, callback numbers and table
    labels are removed from held payloads, and staff are kept as ids only; the
    bill and money remain available for review. Settled held uploads are deleted
    after 30 days; unsettled ones are kept, because they hold a sale.

## Staff-entered phone orders

Choose **Phone order** in the current order, enter the customer name and
callback number, then choose **ASAP** or a scheduled pickup time. Scheduled
times use the restaurant's time zone, not the tablet's. Add items, options and
kitchen notes as usual. **Pay at pickup** saves an unpaid tab; **Pay now** uses
the same cash/card recording flow as counter orders. Card collection still
happens on the external card terminal, not over the phone in this app.

`orderSource` (`counter` or `phone`) is separate from `orderType`; phone orders
are always `takeaway` (pickup), never delivery. The Phone orders filter includes
prepaid orders from earlier days. Payment status is not preparation or
collection status. Details survive offline reloads, saved-tab edits and terminal
transfers. Printed receipts mask the callback number.

Contract version 3 defaults older uploads to counter orders. Migration 0020
creates the POS tables, including phone pickup details; deploy it with the
regional API before the new till. No customer account, OTP, SMS, address or
dispatch integration is created.

Names and callback numbers go browser-direct to regional tenant-api only.
Numbers are omitted from permanent revision history and held uploads. Regional
customer erasure scrubs matching phone contacts without deleting financial
records; later uploads cannot restore a scrubbed phone contact. Closed-order
contacts expire after 30 days (not before a scheduled pickup), using the same
terminal check-in housekeeping as guest names. The till keeps settled, synced
orders for 14 days, but never prunes an upcoming pickup or an open/unsent order.

## Money and history are append-only

- **`pos_payments`** holds payments and refunds (`kind`), and neither can be
  updated or deleted. The one exception: erasing a person may replace the staff
  names on a row.
- **`pos_order_revisions`** keeps every accepted revision. Staff appear as ids
  only; guest names and callback numbers are omitted.
- **`pos_fiscal_documents`** holds the invoices and credit notes.
- **`pos_orders`** rows cannot be deleted.

On an order, payments, refunds and `lineVoids` (items taken off a saved tab) can
only grow. Once a payment exists the bill is frozen. A closed sale can only gain
refunds.

## Voids, removed items and refunds

- **Taking items off a saved tab** needs a reason. When PIN sign-in is on and
  the person is not a till manager, it also needs a manager's PIN. Each removal
  is recorded as a line void with the item, quantity, unit price, who, why and
  who approved.
- **Cancelling an unpaid tab** works the same way (`voidReason`,
  `voidApprovedBy`, and `voidedAt` taken from the till).
- **Refunding a paid sale** gives money back in the tenders it was paid with,
  newest payment first, one refund row per payment touched. A sale refunded in
  full has status `refunded`. Card refunds are made on the card terminal and
  recorded here, with an optional reference.
- **Till managers** are set on the Terminals page (`pos_managers`).

## Cash drawer shifts and the Z report

A terminal can be set to sell only inside a **shift** (Terminals page, "Require
shifts"; off by default). A shift is opened with the float counted in the
drawer, records cash put in or taken out (a note is required, and a manager's
PIN for cash out when sign-in is on), and is closed with a **blind count**: the
person counting is shown the expected figure only after confirming.

- **Stamping.** Every order, payment and refund taken while a shift is open
  carries its id, so a tab rung up in one shift and paid in the next counts its
  cash in the shift where the money moved.
- **Expected cash** is the opening float, plus cash payments, minus cash
  refunds, plus cash in, minus cash out. The till computes it at the close; the
  server works it out again from the payments it holds whenever a report is
  asked for, so a payment that arrives after the close still counts.
- **The Z report** is the same calculation everywhere (`posSalesSummary` in
  `@repo/common/pos-reports`). The till prints it at the close. On the server it
  covers one shift (`GET /operator/pos/shifts/:id`) or one business day across
  terminals (`GET /operator/pos/reports/day`), and the day report is on the
  Terminals page.
- **Append-only.** Shifts can't be deleted and cash movements can't be changed
  (triggers). A closed shift never changes.

## Fiscal chain

Every closed sale gets an **invoice** and every refund a **credit note**,
numbered without gaps per till installation (`chainId`) and hash-linked to the
previous document. This is ZATCA's ICV/PIH shape. The till issues documents in
the same IndexedDB transaction that closes the sale. The hash is synchronous
because an IndexedDB transaction cannot await `crypto.subtle`.

- **Display number vs counter.** The order number a guest sees (`T1-0042`) can
  change after a collision; the fiscal counter never does.
- **Server checks.** The server recomputes each hash and checks its link to the
  previous document. It flags `fiscal:hash_mismatch`, `fiscal:chain_break`,
  `fiscal:counter_reused` and `fiscal:document_changed`, and still keeps the
  sale.
  - The first document must start from the genesis value.
  - A link is checked from whichever side arrives second, because offline tills
    upload out of order.
  - Counters missing for more than a day are listed at
    `GET /operator/pos/fiscal/gaps`.
  - A chain belongs to the terminal that stored its first document (or a removed
    terminal with the same code and location). A document another terminal files
    under that chain is kept with the problem `chain_owner_mismatch` and its
    order flagged `fiscal:chain_owner_mismatch`; it never moves the owner's
    head, gaps or review reasons.
- **Recovery.** `/pos/me` returns the chain heads the server holds, so a till
  whose storage was lost continues its chain instead of starting another.
- **Receipts.** When the location has a VAT number, the receipt is a simplified
  tax invoice: VAT number, invoice counter, and the ZATCA Phase 1 QR code
  (seller, VAT number, time, total, VAT). An onboarded ZATCA unit prints the
  Phase 2 QR code instead (below).

## ZATCA Phase 2 (integration)

For restaurants in Saudi Arabia, each terminal can be an **EGS unit**.

- **Onboarding (App, Terminals page).**
  1. A manager enters the seller details: legal name, VAT number, CR number,
     national address, business category, branch, and environment (sandbox,
     simulation or production).
  2. They generate a one-time password in the Fatoora portal and press "Connect"
     on a terminal.
  3. The regional server generates the unit's secp256k1 key and CSR, gets a
     compliance CSID, signs and submits the three compliance samples (invoice,
     credit note, debit note), and requests the production CSID.
  4. If a step fails, the unit records which step and why. A terminal that is
     already connected keeps its key and certificates until a reconnect has
     fully succeeded, so a mistyped password never breaks a working till.
- **Signing on the till.** The terminal fetches its key and production
  certificate (`GET /pos/zatca`; the CSID secret never leaves the server). It
  then signs every closed sale (388) and every refund (381, referring to the
  invoice) itself, offline if need be, in the same IndexedDB transaction that
  issues the fiscal document. ICV is the fiscal counter, and PIH is the previous
  document's invoice hash, starting from ZATCA's genesis value. The signed XML,
  its hash and the Phase 2 QR (nine tags) ride on the fiscal document.
- **Reporting.** The server queues each signed document
  (`pos_zatca_submissions`, append-only, one per terminal and counter) and
  reports it with the production CSID: right after the upload, and on every
  hourly tick. Before queueing, it reads the signed XML back (number, UUID,
  type, ICV, PIH, totals, VAT number) and recomputes the invoice hash; a
  document that disagrees with what the till claimed is kept as `rejected` with
  "Not reported: …" and never sent. Reporting runs claim their documents
  atomically, so the upload and the tick never report the same one twice.
  Outcomes:
  - `reported`: accepted.
  - `warning`: accepted with warnings.
  - `rejected`: refused (including a 2xx whose validation status is an error);
    ZATCA's reason is kept.
  - Network errors, 5xx, 408 and 425 are retried with backoff.
  - 401 (a revoked or expired CSID) is recorded on the unit (`authFailedAt`,
    last error); its documents are retried hourly until it is onboarded again.

  Documents pending for over 20 hours (ZATCA expects them within 24) are logged
  and counted as `overdue`. The Terminals page shows the counts and the
  rejections, and has a "Report now" button.

- **Amounts.** Lines are net (unit net × quantity). With VAT-inclusive prices
  the taxable amount comes from the whole discounted bill, so the document's VAT
  equals the bill's VAT (`totals.taxCents`, and `posRefundTaxCents` for a credit
  note) while BR-S-09 and BR-CO-17 still hold. Per-unit rounding is evened out
  by one document-level allowance or charge, and any halala between that and
  what the guest paid goes into `PayableRoundingAmount`. The receipt of a signed
  invoice prints that VAT, to match its QR code.
  - Tips and untaxed options are category O (`VATEX-SA-OOS`).
  - A discount is split between taxed and untaxed amounts in proportion.
  - A refund is split the same way as the sale it refunds, so no VAT is claimed
    back on a tip.
- **Numbers.** The invoice number (`cbc:ID`) is fixed when the invoice is signed
  and kept with it. Renumbering an order after a collision never changes it, and
  credit notes always refer to it.
- **Recovery.** `/pos/me` reports the hash of the last document the server holds
  from the terminal, so a till whose storage was lost continues the PIH chain as
  well as the counter.
- **Seller details** are fixed on each unit when it is onboarded. After the
  legal name or VAT number changes, onboard the units again (the overview marks
  them `sellerOutdated`). The legal name is limited to 255 UTF-8 bytes (the QR
  tag), and characters XML cannot carry are refused in the settings and stripped
  from item names before signing.
- **Secrets at rest.** Signing keys and CSID secrets are sealed with AES-256-GCM
  (16-byte tag), bound to the unit and column, with `ZATCA_SEAL_KEY`. It is
  required in production, so rotating `AUTH_HMAC_SECRET` can never destroy
  onboarded units: the Node entry refuses to start without it, and the Worker
  refuses to onboard (sealing) while still reporting what it already holds. Set
  it on every node before deploying. In development, without it, the key is
  derived from `AUTH_HMAC_SECRET`. One unit whose secret cannot be opened does
  not stop the others from reporting.
- **Rotating the seal key.** Move the current value to `ZATCA_SEAL_KEY_PREVIOUS`
  (comma separated for several) and set a new `ZATCA_SEAL_KEY`. Values open with
  either key, and the hourly regional tick re-seals every unit with the new one
  (`resealZatcaUnits`; values sealed with the derived key or the `v1` format
  move too). Remove the old key once the tick has run for every organization.
  Never change `ZATCA_SEAL_KEY` without keeping the old value in
  `ZATCA_SEAL_KEY_PREVIOUS`: its units would have to be onboarded again.
- **Removing a terminal** retires its unit: the till deletes its key and the
  server no longer hands it out or onboards it. Documents it uploaded before
  removal are still reported, because ZATCA requires every issued invoice. Also
  revoke the unit's CSID in the Fatoora portal.
- **Verification.**
  - The invoice hash is checked byte for byte against `xmllint --c14n11`.
  - `openssl` accepts the CSR and the signatures.
  - The certificate fields match `openssl x509`.
  - `npm run sandbox-check -w @repo/zatca -- <dir>` runs onboarding against
    ZATCA's developer-portal sandbox and writes the signed samples for
    `fatoora -validate`. Run it, and the SDK validator, before switching an
    organization to production. The signed-properties digest follows ZATCA's
    published layout and is not covered by the local checks.

## Tax

Locations can price **including** tax (`taxInclusive`, set on the location in
App). The till and the server engine then show the tax inside the price
(`round(taxable × rate / (100 + rate))`) instead of adding it. Each order
records the rate and the mode it was priced with.

## Business day

A terminal's business day turns over at `dayStartMinutes` after local midnight
(default 04:00, from 00:00 to 12:00, set per terminal on the Terminals page).
Orders after midnight belong to the previous day until then, so a late service
keeps one run of order numbers and one day's takings. The day is computed in the
location's time zone, not the tablet's.

## Tabs across terminals

A tab belongs to the terminal that holds it. Another terminal at the same
location can list open tabs (`GET /pos/tabs`, online only) and take one over
(`POST /pos/tabs/:id/claim` with the revision it saw, so a tab that changed is
not taken blind). The old terminal learns of the move from `/pos/me` and keeps
its copy as history. Anything it uploads for the tab afterwards is held.

A removed terminal's tab can be continued directly only by a terminal paired
again with the same terminal code and location; that writes a transfer row. Any
other terminal must claim it.

## Staff sign-in

PINs are the staff module's (`staff_scope_assignments.pin_lookup`, the
terminal's scope). The server rules match the kiosk: escalating backoff per
terminal, never a lockout. People who signed in online can sign in offline for
**72 hours**. A person who has since left can still do so in that window, and
their sales are flagged `inactive_staff`.

## Station apps: time clock and host stand

A paired terminal can also be the restaurant's time clock and its host stand,
with no second pairing and no App login. Each app is a per-terminal setting
(`pos_devices.timeclock_enabled`, `reservations_enabled`, tenant-db migration
`0022_station_apps`) that a manager switches in the App (Settings, Terminals,
Station apps, or when pairing), **and** the organization's flag
(`staffing.timeclock`, `reservations.enabled`). Switching an app on needs that
module's settings permission (time clock rules, or reservation settings), which
App signs into the operator token as `stationApps`; a member limited to some
locations may open the host stand only at those. Every switch, location binding
and host-roster change is in the staff audit log. `/pos/me` reports the result
as `apps: { timeclock, reservations }`, leaving out an app whose flag it cannot
read (the till keeps what it last knew); the till shows an app switch (Register,
Time clock, Reservations) when it offers more than the register.

A terminal paired without a location can be bound to one later (Station apps,
"Choose a location"); App must confirm the location exists (503 otherwise), and
orders the till started before the binding still upload
(`pos_devices.location_bound_at`, migration `0024_station_device_times`).

**Time clock.** `/pos/timeclock/identify` and `/pos/timeclock/punch` run the
kiosk's punch engine (`services/punch-service.ts`) and take the kiosk's request
shapes, on the terminal's own credential. Every punch names the person by PIN at
the terminal's workplace (scope), so nobody clocks in a colleague: on a till
where staff sign in, the clock opens over the lock screen ("Clock in or out"),
never inside someone's session. Wrong PINs share the terminal's sign-in backoff
(offline replays included: they cannot be a way around it). Punches are recorded
with `source: 'pos'` and the terminal as the audit actor.
`STAFFING_KIOSK_ENABLED` stops it like the wall kiosk.

When the server cannot judge a punch now (offline, a 5xx, a rate limit, the App
behind it unreachable so the staffing flag is unknown, or a pause), the till
saves it with the PIN encrypted at rest (the kiosk's queue,
`@repo/staffing/clock-queue`) at the server's time as best known, and sends it,
oldest first, with its other uploads; the server still checks the PIN and the
order. A saved punch is accepted if the clock was on at this terminal when it
was made (`pos_devices.timeclock_disabled_at`); one made after answers 409
`timeclock_was_off` and is listed on the till as refused. A flag known to be off
holds it on the till. Offline, a PIN the till has seen online is greeted by name
with its roles (a slow hash of the PIN, as for offline sign-in, with an attempt
guard of its own that never locks the till's sign-in); punches the server later
refuses are listed on the clock until someone clears them. A saved punch carries
the person's opaque staff id when the till knew it, and is refused (409
`pin_owner_changed`) if the PIN has since been given to someone else. A saved
punch is set aside only after 48 hours of server errors, never after a number of
tries. Where the rules have rest breaks, staff choose meal or rest, offline too.

**Host stand.** An online sign-in returns a staff session (`pos-staff+jwt`,
signed with a key derived from `AUTH_HMAC_SECRET`, bound to the organization and
the terminal, 12 hours, held in memory and dropped when the till locks). The
till sends it in `Pos-Staff-Session` to `POST /pos/reservations/token`, which
checks the person is still active there, on the host roster, and has not had
their PIN reset or cleared since, and mints the same `rsv+jwt` App mints for an
operator, for:

- the `book` scope only, at the terminal's own location only, and within it only
  what the till does (`STATION_ROUTES` in `lib/reservations-guard.ts`): the day,
  availability, the waitlist and its quote, a booking's detail and history, new
  bookings and walk-ins, status, table, undo and running late, and waitlist add,
  text, seat and leave. Everything else (the guestbook, resending messages,
  approving requests, service notes, sections) answers 403 `not_for_station`.
  Cancelling or marking a no-show on a booking with a payment on it moves money,
  so it answers 409 `manager_required` without the payment grant. Nobody who
  cannot read allergy notes can change them;
- host grants (`read`/`update:reservation`) for people on the **host roster**
  (`pos_hosts`, migration `0023_station_hosts`; Settings, Terminals, the staff
  list), plus guest details (`read:reservation_guest`: phones, emails,
  allergies) for hosts given them, which needs the guest permission in App;
- five minutes, `channel: 'station'` and the terminal's id. Without guest
  details every answer has phones masked to their last four digits and emails
  dropped (`lib/reservations-station.ts`: every field named like a phone or an
  email), allergy notes are hidden (in a booking's history too), and a booking's
  detail leaves out the guest's profile, their history and any card details. A
  known guest's profile (found by id, phone or email) is linked but never
  changed: only what it lacks is filled in;
- subject `staff:<staffId>`, so the reservation history shows the action as
  taken by staff at a terminal. Opening the stand is recorded in `rsv_audit_log`
  (`station.host_stand_opened`, once per sign-in and again if guest details
  change; best effort, so the audit never takes the stand down).

The till then calls `/operator/reservations/book/*` directly (CORS allows
`POS_ORIGINS` on those routes only), so every check there applies unchanged. The
host stand needs a location and the staff PIN on the terminal (the server
refuses the setting otherwise), works online only, and keeps nothing about
guests on the device. Its screen is floor first: the room as drawn, a dock of
arriving parties and the waitlist; picking a party lifts the tables it can
finish at before the next booking, and a clash can be overruled as an overbook
with a reason.

The till's host-stand payloads are recorded fixtures
(`apps/station/src/apps/reservations/fixtures`), kept in step by
`apps/tenant-api/src/routes/pos-station-contract.test.ts` (re-record with
`RECORD_STATION_FIXTURES=1`).

## Personal data

- **Guest names** (a first name or note typed by the cashier) and callback
  numbers are cleared 30 days after the order closes (`purgePosGuestNames`), on
  terminal check-in and on the hourly regional tick, so the purge runs even when
  POS is switched off. Open tabs untouched for 90 days lose them too, never
  before a scheduled pickup.
- **Staff names** recorded at the till are replaced when that person is erased
  (`erasePosStaffNames`, called from `eraseLinkedUser`).
- **Held uploads** are covered by the purge and by both erasure paths.

## Languages

The till runs in English or Arabic (right to left), chosen in its Settings. It
defaults to Arabic when the restaurant's default language is Arabic. Catalogs:
`apps/station/src/locales` (`npm run lingui:extract -w station`).

## Configuration

| Variable                   | Where                 | Meaning                                                                                                                                                            |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POS_URL`                  | App                   | Origin of the POS web app, for pairing links and QR codes. When empty in development, defaults to `https://pos.<brand-slug>.test:2999`; no fallback in production. |
| `POS_ORIGINS`              | every tenant-api node | Origins allowed to call `/pos/*` from a browser. Read live from the environment. Outside an explicit `NODE_ENV=development\|test`, only listed origins count.      |
| `POS_ENABLED`              | tenant-api            | Kill switch. `false` answers 503 on `/pos/*` and refuses new pairing codes; revoking a terminal always works. Revoke terminals first, then flip it.                |
| `ZATCA_SEAL_KEY`           | tenant-api            | Required in production, 64 hex characters (`openssl rand -hex 32`). Seals ZATCA keys and CSID secrets. Rotate only through `ZATCA_SEAL_KEY_PREVIOUS`.              |
| `ZATCA_SEAL_KEY_PREVIOUS`  | tenant-api            | Rotation only: previous seal keys, comma separated. Still opened, and re-sealed by the hourly tick. Remove once every organization's tick has run.                 |
| `VITE_POS_ALLOWED_ORIGINS` | Station build         | App and tenant-api origins the till may talk to. Required in production builds: when empty, the till refuses every server. Also sets the CSP `connect-src`.        |

On the US Workers node the router confirms the organization with App before each
`/pos/*` request. A positive answer is cached for 60 s and a "missing" answer
for 15 s. Each client address may cause 30 uncached lookups a minute (then 429),
and a `/pos/pair` body is capped at 2 KB. If App cannot be reached, the node
answers 503, which the till retries; it never answers "removed". Menu context
for repricing is cached for 60 s per location. A missing or short
`AUTH_HMAC_SECRET` answers 503. `/pos/*` responses expose the `Date` header,
from which the till measures its clock skew.

Pairing codes check their `scopeId` against the staff assignments and their
`locationId` against App's locations (skipped when App cannot be reached).

## The till

- **Pairing links** always show the servers they point at and wait for
  confirmation. Servers must be https, except local development hosts.
- **Hosting.** The build emits `dist/_headers` (Cloudflare Pages format) with
  the CSP, `frame-ancestors 'none'` and `X-Frame-Options: DENY`; the host must
  serve it. Only images served with CORS are cached for offline use.
- **Install it.** Station asks the browser for persistent storage and shows a
  banner when it is refused; installing the PWA (Add to Home Screen) avoids
  losing unsent orders to eviction.
- **Clock.** The till records its offset from the server's clock. Beyond 2
  minutes it shows a warning and refuses to sign ZATCA documents. The PIN
  lockout also runs on a monotonic clock.
- **Shifts** the server refuses for good are marked rejected, shown on the Shift
  sheet with "Send again", and counted in the attention badge.

## Local development

Root `npm run dev` includes the POS Vite server on **3010** alongside App
(3001), Sites (3008), and both tenant-api nodes (US 3007, KSA 3009). The HTTPS
proxy on **2999** serves it at `https://pos.<brand-slug>.test:2999`, derived
from `getLocalDomain()` in `packages/config/brand.ts`. HMR uses the same proxy
port. The PWA service worker is disabled in dev.

For Menuza:

1. On an existing hosts-file setup, run `npm run setup:hosts` once to add
   `pos.menuza.test` (unnecessary with wildcard local DNS). The existing
   wildcard development certificate covers this hostname.
2. Start root `npm run dev`. It frees its dev ports first, including 3010.
3. Open `https://app.menuza.test:2999/<org-slug>/menu/terminals` and create a
   pairing code for the desired location.
4. Open the pairing link or scan its QR code. It opens
   `https://pos.menuza.test:2999` and pairs directly with the organization's
   regional tenant-api.

An empty `POS_URL` automatically uses this HTTPS dev origin, without editing
App's `.env`. An explicit `POS_URL` still wins. The tenant-api already accepts
`.test` origins outside production, so local pairing needs no `POS_ORIGINS`
change. `pos` is reserved as an organization slug and a product subdomain.

To run only the tablet app server, use `npm run dev:station`; the proxy, App and
the appropriate tenant-api must be running separately for the full pairing flow.
For direct `http://localhost:3010` development without the proxy, use
`VITE_DIRECT_DEV=1 npm run dev -w station` so HMR connects directly.

Station targets Safari 15+ (including iOS/iPadOS 15+). Its development
dependency optimizer and production build use the same explicit browser targets;
Vite 6's Safari 14 default is incompatible with the pinned esbuild version.

## Tests

- **Contract:**
  `cd packages/common && npx vitest run src/pos-orders.test.ts src/pos-fiscal.test.ts`.
- **Server:**
  `cd apps/tenant-api && ../../node_modules/.bin/varlock run -- npx vitest run src/routes/pos.test.ts src/lib/pos-routing.test.ts`.
- **Tablet app:** `cd apps/station && npx vitest run`.
- **ZATCA:** `cd packages/zatca && npx vitest run` (uses `openssl` and `xmllint`
  when installed).
- **End to end:** `cd apps/station && npx playwright test`. It boots its own
  tenant-api (`apps/tenant-api/tests/pos-e2e-server.ts`, temp databases, ports
  4710 and 4711) and a POS preview on 3110. It does not touch the LibSQL or D1
  dev databases.
