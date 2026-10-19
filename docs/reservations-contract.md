# Reservations API Contract

This document defines the HTTP and token contract between `apps/app`,
`apps/sites`, `apps/ios`, `apps/android`, `apps/voice-agent`, `apps/jobs-cron`,
and the regional `apps/tenant-api` for the Reservations module. Where an older
plan and the code disagree, this page follows the code.

Shared Zod schemas live in `@repo/reservations`: request and operator schemas in
`packages/reservations/src/schemas/`, the public response shapes in
`schemas/public-contract.ts`, error codes in `errors.ts`. The recorded wire
fixtures are in `packages/reservations/contract-fixtures/` (section 9).

## 1. Operator token (`rsv+jwt`)

Minted by `GET /<orgSlug>/reservations/token?scope=<scope>` in `apps/app` after
the same flag and permission checks as the pages.

- **Header:** `{ "alg": "HS256", "typ": "rsv+jwt" }`
- **Secret:** `TENANT_OPERATOR_TOKEN`
- **Audience (`aud`):** `'tenant-api-reservations-operator'`. Tokens for
  `tenant-api-staffing` and `tenant-api-operator` are refused.
- **Scopes (`scope`):** `'book' | 'guests' | 'setup' | 'reports' | 'payments'`
- **Claims:** `sub` (operator `User.id`), `role: 'operator'`, `orgId`, `region`
  (`'us' | 'ksa'`, must match the node's `DATA_REGION`), `scope`, `grants`
  (non-empty, valid for the scope: `SCOPE_GRANTS[scope]`), `locationIds` (`null`
  for every location, or a non-empty array of `OrganizationLocation.id`),
  `features` (`{ enabled, online, waitlist, payments, experiences, voice }`),
  `impersonated`, `iat`, `exp`.
- **Lifetime:** `exp - iat <= 900` seconds, and `<= 300` when `impersonated` is
  `true` or `grants` includes a **sensitive grant**:
  `read:reservation_guest:any`, `update:reservation_guest:any` or
  `update:reservation_payment:any` (`SENSITIVE_GRANTS` in
  `packages/reservations/src/permissions.ts`). Settings grants are not
  sensitive: a `setup` token lives 15 minutes.
- **Allergy visibility on the day feed:** every reservation row in
  `GET /operator/reservations/book/day` carries `allergyFlag` / `hasAllergy`
  (boolean) and `dietaryCodes` (coded values from `RSV_DIETARY_CODES` in
  `packages/reservations/src/dietary.ts`, never free text) for any
  `read:reservation:any` token, so a host can see an allergy and its coded
  allergen without the guest grant. `dietaryNotes`, guest allergy notes, pinned
  notes and sensitive tags stay `null` / filtered without
  `read:reservation_guest:any`.
- **Impersonation:** all `update:*` and sensitive grants are stripped at mint
  time and again by `rsvGuard`; impersonated writes answer 403.
- **Writes:** routes with `write: true` need the matching `update:*` grant (an
  `update` grant implies its `read` grant; `update:reservation_payment:any` has
  no read grant, so the `payments` scope also carries `read:reservation:any`).

`rsvGuard({ scope, grant, anyOf, feature, write })` verifies signature,
audience, `typ`, lifetime, region, scope, grants, feature and `locationIds`.
Every route also verifies the organization is active, in this node's region and
has `hasProvisionedDb`; otherwise it answers the uniform
`404 { "error": "not_found" }`. Cross-organization and out-of-scope `locationId`
requests fail closed with 403 or 404.

## 2. Internal and control-plane routes

All use `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>` unless stated.

| Method and path                                            | Host              | Purpose                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /resources/reservations/context?orgId=<id>`           | `apps/app`        | `ReservationsContext`: locations, flags, branding, payment capability, `platformFeeBp`. No guest data.                                                                                                               |
| `POST /resources/reservations/notify`                      | `apps/app`        | Manager alert from a node's outbox: `{ orgId, eventId, kind, locationId, count }`. Idempotent by `eventId`.                                                                                                          |
| `POST /resources/reservations/payments`                    | `apps/app`        | Payment commands from the regional outbox (`refund_request`, `checkout_expire`). Strict body of opaque ids.                                                                                                          |
| `POST /resources/reservations/payments/refund`             | `apps/app`        | Operator session (not the token): run a recorded refund now. `{ refundRequestId }`.                                                                                                                                  |
| `GET /resources/reservations/region-summary`               | `apps/app`        | Operator session: counts for the region-switch dialog.                                                                                                                                                               |
| `POST /resources/jobs/reservation-payments-reconcile`      | `apps/app`        | Hourly job: re-check lingering payment sessions and refunds.                                                                                                                                                         |
| `GET /resources/sites/reservations?slug=` (or `host=`)     | `apps/app`        | Public gate for Sites: `{ online, waitlist, experiences, notifyMe }`, 404 unless published and both flags on.                                                                                                        |
| `POST /resources/sites/reservation/checkout`, `/status`    | `apps/app`        | Sites server only, `SITES_RESERVATION_PAYMENT_TOKEN` (section 5).                                                                                                                                                    |
| `POST /internal/reservations/context-changed`              | `apps/tenant-api` | Evicts the cached context for `orgId` and syncs location time zones.                                                                                                                                                 |
| `POST /internal/reservations/erase-customer`               | `apps/tenant-api` | Scrubs a customer's guest PII, cancels active reservations, holds and waitlist rows, redacts event payloads.                                                                                                         |
| `POST /internal/reservations/summary`, `/location-summary` | `apps/tenant-api` | Counts only, for the region-switch and location-delete guards.                                                                                                                                                       |
| `POST /api/reservations/tick`                              | `apps/tenant-api` | Regional tick (body `{}` or `{ orgId }`). Tasks: `expire_holds`, `expire_requests`, `auto_no_show`, `waitlist_offers`, `notify_me_match`, `deliver_messages`, `deliver_outbox`, `reconcile_guest_counters`, `purge`. |
| `POST /api/reservations/payments/<endpoint>`               | `apps/tenant-api` | App to region payment calls: `quote`, `bind`, `status`, `fee-claim`, `fee-result`, `refund-claim`, `refund-result`, `dispute`, `pending`.                                                                            |

The App never receives guest data from these calls; payloads carry ids, amounts,
currencies, counts and kinds only.

## 3. Operator routes (`/operator/reservations/*` on `apps/tenant-api`)

| Scope      | Base path                                                          | Grants (read / write)                                               |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `setup`    | `/operator/reservations/setup/*`                                   | `read:reservation_settings:any` / `update:reservation_settings:any` |
| `setup`    | `/operator/reservations/setup/locations/:locationId/experiences/*` | same, plus the `experiences` feature                                |
| `setup`    | `GET /operator/reservations/experiences?locationId=`               | read, `experiences` feature                                         |
| `book`     | `/operator/reservations/book/*`                                    | `read:reservation:any` / `update:reservation:any`                   |
| `book`     | `/operator/reservations/book/waitlist/*`                           | same, plus the `waitlist` feature                                   |
| `guests`   | `/operator/reservations/guests/*`                                  | `read:reservation_guest:any` / `update:reservation_guest:any`       |
| `reports`  | `/operator/reservations/reports/<kind>`                            | `read:reservation_report:any`                                       |
| `payments` | `/operator/reservations/payments/*`                                | `read:reservation:any` / `update:reservation_payment:any`           |

Route families (aliases such as `/combos` and `/combinations` are not listed):

- **Setup:** `overview`; `locations/:locationId/settings` (GET, PUT, PATCH, POST
  with `expectedVersion`); `locations/:locationId/waitlist`; `message-texts` (+
  `/preview`); `locations/:locationId/floor-plan` (GET, PUT with
  `expectedVersion`); `areas`, `tables`, `combos`, `elements`, `services`,
  `turn-times`, `pacing`, `service-availability`, `special-days`, `blocks`,
  `sections` (+ `sections/layouts`), `policies`, each with list, create, update
  and delete under `locations/:locationId/...`; `validation`, `conflicts`,
  `rederive-times`.
- **Experiences:** `/:id`, `/:id/publish|unpublish|archive`, `/:id/schedules`.
- **Book:** `day`, `today`, `changes`, `conflicts`, `availability`, `calendar`,
  `overview`, `service-notes`, `section-assignments`, `guests/lookup`,
  `guests/:id/summary`; `POST reservations`, `POST walk-ins`; `reservations/:id`
  (GET, PATCH with `expectedVersion`), `/events`, `/assign`, `/status`,
  `/resend`, `/undo`, `/contact`, `/running-late`, `/course`, `/notes`;
  large-party requests: `POST /requests/:id/approve` and `/requests/:id/decline`
  (also `/reservations/:id/approve|decline`). Create and edit send
  `Idempotency-Key`; status transitions without `expectedVersion` (approve,
  decline) are guarded by a status precondition (409
  `invalid_status_transition`).
- **Waitlist:** `GET /`, `POST /`, `/quote`, `/reorder`, `/:id`, `/:id/notify`,
  `/:id/status`, `/:id/seat`.
- **Guests:** list, `lookup`, create, `tags` (+ `/:tagId`), `merge`, `/:id`,
  `/:id/tags`, `/:id/notes`, `/:id/summary`, `/:id/export`, `POST /:id/erase`.
- **Reports:** `summary`, `no-shows`, `cancellations`, `turn-times`, `waitlist`,
  `pacing` with `locationId`, `from`, `to` (at most 366 days), `serviceId`.
- **Payments:** `GET reservations/:id` (payment summary),
  `POST reservations/:id/fee`, `POST reservations/:id/refund`. They record the
  decision regionally; the App executes it at the provider.

Stable operator conflict and validation codes: `stale_version`,
`invalid_status_transition`, `closed_day`, `pacing_exceeded`,
`pacing_parties_exceeded`, `block_conflict`, `missing_idempotency_key`,
`idempotency_conflict`, `missing_overbook_reason`, `invalid_date`,
`invalid_party_size`, `invalid_range`, `range_too_long`. Validation errors carry
field paths only, never the rejected value.

### Operator booking details

- **Confirmation codes:** operator bookings get a 6-character code (alphabet
  `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`); guest bookings get **8** Crockford base32
  characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I, L, O, U).
- **`closed_day`:** booking a closed day answers `409 closed_day` (with
  `specialDay: { name, note }`) unless `overbook: true` (which then needs
  `overbookReason`); with the override the booking succeeds and the response
  carries `warnings: [{ code: 'closed_day', message }]`. `online_closed` days
  never block staff.
- **`warnings[]`:** `POST reservations` returns
  `{ reservation, moves, warnings }`. `warnings` lists the rules the operator
  overrode: `closed_day`, `pacing_exceeded`, `pacing_parties_exceeded`. Without
  `overbook` the same breaches are `409`s with that code.
- **`held` and `heldTableIds`:** each slot of `GET book/availability` carries
  `held: boolean` and `heldTableIds: string[]`: tables that fit the party but
  are inside an active guest hold, so the host can see why a slot looks full
  without double-booking it. `available`, `pacingWarning`, `overbookAvailable`
  and `suggestedTableIds` sit beside them.
- **`block_conflict`:** `POST blocks` answers `409 block_conflict` with
  `{ reservationIds }` when reflowing the affected future bookings finds a table
  the engine believed free already taken; the whole block rolls back.

## 4. Public guest routes (`/reservations/*` on `apps/tenant-api`)

Called browser-direct from `apps/sites` and from the native apps. No route is
proxied by Sites SSR.

**Organization routing.** The organization is resolved from the request `Origin`
header only (plus `slug` or `host` query parameters outside production, which
the native apps use for non-https site origins). It is never taken from a
customer token, a query or body `orgId`. The Worker router
(`workers/org-router.ts`) applies the same rule before any Durable Object is
touched. An unknown organization, the wrong region, an unprovisioned database or
`reservations.enabled` off all answer the uniform `404 { "error": "not_found" }`
with `Cache-Control: private, no-store`. `reservations.online` off answers 404
on booking routes only; manage routes (links already in guests' hands) keep
working.

**App gate semantics.** Sites first calls the App's
`GET /resources/sites/reservations`; it answers 404 until the website is
published and `reservations.enabled` and `reservations.online` are on, so a
module that is off looks absent and Sites falls back to its CMS page. Manage
links do not use the gate.

**Kill switch.** `RESERVATIONS_PUBLIC_ENABLED=false` answers
`503 { "error": "unavailable" }` on every public route.

**Headers.**

| Header                        | Use                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Origin`                      | Required: names the organization. Native apps send it for https site origins.                                                                                                  |
| `X-Reservation-Token`         | Capability token (manage, waitlist, hold, payment). Query `?t=` is accepted **only** for the `.ics` download. Never put a token in a URL otherwise.                            |
| `Authorization`               | Optional `Bearer <customer access token>` (audience `tenant-api`). A token for another organization answers 403 `forbidden`; an invalid one 401. It is never ignored.          |
| `Idempotency-Key`             | Required on `POST /reservations`, `/requests`, `/waitlist/join`. 8 to 128 characters of `A-Za-z0-9._:-`. A missing or malformed key answers 400 `invalid`.                     |
| `X-Client`                    | `ios` or `android` sets `client` and `channel = 'native'`. Anything else (absent, `web`, unknown) means `client = 'web'`, `channel = 'online'`. An unknown value never errors. |
| `X-Turnstile-Token`           | Alternative to the body `turnstileToken` for web callers.                                                                                                                      |
| `Accept-Language`, `?locale=` | Chooses localized names and texts.                                                                                                                                             |

**Bot protection.** With `TURNSTILE_SECRET_KEY` set, `POST /holds`, `/requests`,
`/waitlist/join` and `/notify-me` need either a valid customer access token for
this organization (a verified customer **substitutes** for Turnstile, which is
what the native apps use) or a Turnstile token; otherwise
`403 { "error": "verification_failed" }`. The `website` honeypot field answers
with a fake success. Without the secret (local development) the challenge is
off.

**Routes.**

| Method and path                                                                          | Purpose                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /config`                                                                            | Bookable locations (party range, horizon, interval, hold minutes, large-party block, waitlist and notify-me switches, areas), occasions, dietary chips, `now`.                                                                        |
| `GET /availability?locationId&date&partySize[&localMin&experienceId]`                    | Day grid with `dayVersion`, `settingsVersion`, `status`, `slots`, `alternatives`, `closed`/`onlineClosed`, `largeParty`. `ETag` and `If-None-Match` (304); `Cache-Control: private, max-age=0`.                                       |
| `GET /calendar?locationId&partySize&from&to`                                             | Up to 62 days of `{ date, hasAvailability, status, closed, slotCount, firstLocalMin, lastLocalMin }`.                                                                                                                                 |
| `POST /holds`                                                                            | Exclusive hold on a slot. Body `{ locationId, slot: { date, localMin, partySize, serviceId? }, experienceId?, areaPref?, replaceHoldToken? }`. 201 `{ holdToken, expiresAt, now, locationId, slot, requiresPayment?, policy? }`.      |
| `GET /holds/current`                                                                     | The active hold for `X-Reservation-Token`.                                                                                                                                                                                            |
| `POST /holds/release`                                                                    | Releases a hold (`holdToken` in the body or the header).                                                                                                                                                                              |
| `POST /`                                                                                 | Books from a hold. Body `{ holdToken, guest: { firstName, lastName?, phone, email? }, occasionTagId?, requests?, dietary?, areaPref?, smsOptIn, marketing?, policyAccepted?, locale }`. 201 `{ reservation, manageToken, payment? }`. |
| `POST /requests`                                                                         | Large-party request (no hold). Same details plus `locationId`, `slot`. 201 with `reservation.status = 'requested'`.                                                                                                                   |
| `GET /manage`                                                                            | Manage view for the token.                                                                                                                                                                                                            |
| `GET /manage/payment`                                                                    | Payment status poll, exactly `{ paymentStatus, reservationStatus, now }`. Accepts the manage token or the payment token. GET only.                                                                                                    |
| `GET /manage/availability`                                                               | Alternative slots for modifying (the booking itself is excluded).                                                                                                                                                                     |
| `POST /manage/modify`, `/manage/cancel`, `/manage/confirm`                               | Guest actions; each answers the fresh manage view. Modify body `{ date?, localMin, partySize? }`.                                                                                                                                     |
| `POST /manage/late` and `/manage/running-late`                                           | Running late (`{ minutes }`, 1 to 180). The two paths are aliases.                                                                                                                                                                    |
| `GET /manage/calendar.ics` and `/manage/ics`                                             | Calendar download (`text/calendar`). The only route where `?t=<token>` is accepted. Aliases.                                                                                                                                          |
| `GET /mine`                                                                              | Signed-in customer only (Bearer): `{ now, upcoming[], past[] }`, each with a freshly derived `manageToken`.                                                                                                                           |
| `POST /waitlist/join`                                                                    | Join. Body `{ locationId, name, partySize, phone?/email?, smsOptIn?, areaId?, notes?, locale? }`. 201 `{ entry, statusToken, now }`. Recorded with channel `remote` for every client.                                                 |
| `GET /waitlist/status`, `POST /waitlist/status/leave`, `POST /waitlist/status/on-my-way` | Status for `X-Reservation-Token` (the waitlist token); links stop answering 2 days after joining.                                                                                                                                     |
| `POST /notify-me`, `POST /notify-me/cancel`                                              | Notify-me when a table opens; `cancelToken` is shown once.                                                                                                                                                                            |
| `GET /experiences`, `GET /experiences/:slug`                                             | Published experiences (needs `reservations.experiences`).                                                                                                                                                                             |

Every mutation is `POST`; the router answers every other method on a mutation
path with a non-2xx and never runs it. Android cannot send `PATCH`.

**Status vocabulary.** The wire `status` is the state-machine status except that
the database value `pending_approval` is exposed as **`requested`**:
`requested`, `pending_payment`, `booked`, `confirmed`, `partially_arrived`,
`arrived`, `partially_seated`, `seated`, `finished`, `cancelled`, `no_show`,
`declined`, `expired`. `paymentStatus` is one of `none`, `pending`,
`guaranteed`, `paid`, `refund_pending`, `refunded`, `partially_refunded`,
`fee_pending`, `fee_charged`, `fee_failed`, `review`, `disputed`.

**Capability tokens.** Manage (`rsv_m_`), waitlist (`rsv_w_`), notify (`rsv_n_`)
and payment (`rsv_p_`) tokens are not stored: they are HMAC-SHA256 values
derived from the organization id, the record id and a version counter, keyed by
`AUTH_HMAC_SECRET` (`manage_token_version` on the reservation; bumping it
revokes the link). Hold tokens are random and stored as a SHA-256 hash. A manage
token stops answering 7 days after the booking ends. Links in messages carry the
token in the URL fragment (`/reserve/manage#t=...`), never the query.

**Idempotency.** `POST /` and `POST /requests` replay the original reservation
(and a re-derived manage token) for the same `Idempotency-Key` and the same body
(the Turnstile token and honeypot are not part of the comparison); a different
body answers `409 idempotency_conflict`. Keys are kept 48 hours.

**Errors.** Body `{ "error": "<code>", ... }`; validation answers
`400 { error: "invalid", issues: [{ path, code }] }` and never echoes a value.

| Status | Code                                                                                                                                                                                                                               | Meaning                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 400    | `invalid`, `party_size_invalid`                                                                                                                                                                                                    | Bad input (`issues` give paths), party outside bounds                |
| 400    | `policy_required`                                                                                                                                                                                                                  | The booking needs the policy accepted (**400**, not 422)             |
| 401    | `unauthorized`                                                                                                                                                                                                                     | `/mine` without a valid customer token                               |
| 403    | `verification_failed`, `forbidden`                                                                                                                                                                                                 | No Turnstile or customer token; token for another organization       |
| 404    | `not_found`                                                                                                                                                                                                                        | Uniform: unknown, switched off, bad or expired token, wrong method   |
| 409    | `slot_unavailable`                                                                                                                                                                                                                 | Slot taken; body includes `alternatives { sameDay[], otherDates[] }` |
| 409    | `phone_overlap`, `large_party`, `requests_closed`, `cancel_closed`, `modify_closed`, `policy_unavailable`, `already_on_waitlist`, `waitlist_full`, `too_many_active_requests`, `idempotency_conflict`, `invalid_status_transition` | Rule refusals                                                        |
| 410    | `hold_expired`                                                                                                                                                                                                                     | The hold lapsed                                                      |
| 429    | `rate_limited` (`reason` may be `phone_active_limit`)                                                                                                                                                                              | Per-IP or per-phone limits; retry later                              |
| 503    | `unavailable`                                                                                                                                                                                                                      | Kill switch, or the context could not be loaded                      |

Rate limits (per IP, in memory per minute unless noted): `config` 120,
`availability` 60, `calendar` 30, `holds` 10 (and 10 per 10 minutes durable),
book 10 (and 20 per day durable), `requests` 5 per 10 minutes, `manage` reads
60, manage writes 30 (and 30 per hour per reservation), `manage/payment` 120,
waitlist join 5 per 10 minutes, `mine` 60.

## 5. Payments

The regional node decides amounts, currency, policy and state; the App is the
only component that talks to Stripe (US) or Checkout.com (KSA, SAR) and sees ids
and amounts only.

1. `POST /holds` returns `requiresPayment: true` and a `policy` view when the
   location's policy needs money (deposit, card guarantee, prepay or an
   experience).
2. `POST /` books and parks the reservation in `pending_payment`, keeping its
   capacity until `payment.expiresAt` (20 minutes). The response carries
   `payment: { paymentToken, purpose, amountMinor, currency, expiresAt, payUrl }`
   with `payUrl = <siteOrigin>/reserve/pay#r=<reservationId>&t=<paymentToken>`.
3. The client opens `payUrl` in a browser (Sites `/reserve/pay`). The Sites
   **server** calls the App with the opaque reservation id and the single-use
   payment token (`POST /resources/sites/reservation/checkout`, authenticated
   with `SITES_RESERVATION_PAYMENT_TOKEN`; amount and currency come from the
   regional quote, never the caller) and the guest is redirected to the hosted
   page. A return from the provider never means paid.
4. **Provider webhooks terminate at the US App.** The App verifies the signature
   (`/api/stripe/webhook`, `/api/shop/webhook` for Checkout.com), maps the event
   to an ids-and-amounts DTO and forwards only that to the region
   (`/api/reservations/payments/status`, `/dispute`, `/refund-result`). No guest
   data is in the DTO and the raw event is never stored or logged. This is an
   accepted deviation from the earlier plan (webhooks at the regional node); see
   ADR 048 section 8.
5. A **Checkout.com card guarantee** stores the card with a 100-minor-unit
   verification charge (`RESERVATION_CHECKOUT_VERIFICATION_MINOR`) and refunds
   it best-effort; a refund failure is logged by code and never blocks the
   guarantee.
6. **Status poll.** Clients poll `GET /manage/payment` with the manage or
   payment token. Interpretation (same as Sites `interpretPay`): `paymentStatus`
   in `paid`, `guaranteed`, `fee_charged` is paid; `review` or `disputed` is
   under review; `refund_pending`, `refunded`, `partially_refunded` is refunded;
   `reservationStatus` in `cancelled`, `expired`, `declined`, `no_show`,
   `finished` is expired; anything else keeps polling. Back off from 1.5 s to 10
   s and stop after 3 minutes or on 404.
7. Operator refunds and fees record a decision regionally; an outbox delivers
   `refund_request` and `checkout_expire` commands to
   `POST /resources/reservations/payments`. The platform fee is
   `floor(amount * bp / 10000)` using `reservations.platform_fee_bp`.

## 6. Voice (`/api/voice/actions/:name`)

`POST /api/voice/actions/:name` on `apps/tenant-api`, authenticated with
`VOICE_AGENT_TOKEN`, body `{ orgId, callId, scopeId?, channel?, input }`. The
organization comes from the call, never from anything the model says; US
organizations only (others answer as unknown); finished calls answer 409; test
calls (`web_test`) run dry. Actions are registered with `registerVoiceAction`
(`apps/tenant-api/src/restaurant/reservations-voice-actions.ts`):

| Action                      | Per-call cap | Purpose                                                        |
| --------------------------- | ------------ | -------------------------------------------------------------- |
| `reservations.availability` | 10           | Up to 3 offered slots for a date, time and party               |
| `reservations.hold`         | 2            | Holds a slot and texts the caller a link with a fragment token |
| `reservations.book`         | 1            | Books directly (US, `reservations.voice` and policy rules)     |

Results are `{ ok: true, data }` or `{ ok: false, reason, explanation }` with
`reason` one of `unavailable`, `rate_limited`, `not_enabled`, `invalid`,
`conflict`. Callers are never identified by phone number (caller ID is
spoofable) and no guest data is returned.

## 7. Messages

Kinds: `confirmation`, `modification`, `cancellation_guest`,
`cancellation_restaurant`, `reminder`, `reconfirm_request`, `request_received`,
`request_approved`, `request_declined`, `waitlist_joined`, `waitlist_ready`,
`notify_available`, plus payment messages. Channels are email and SMS (US only,
with opt-in). Each row is deduplicated by `dedupe_key`; reminders and
reconfirmations are re-planned whenever a write touches a booking (and when
message settings change).

## 8. Internal tokens

| Token                             | Authenticates                                                        |
| --------------------------------- | -------------------------------------------------------------------- |
| `TENANT_OPERATOR_TOKEN`           | Signs and verifies the operator `rsv+jwt`                            |
| `INTERNAL_COMMAND_TOKEN`          | App, Admin, node and cron internal calls, payments internal routes   |
| `VOICE_AGENT_TOKEN`               | `/api/voice/actions/:name`, `/resources/phone-agent-config`          |
| `SITES_RESERVATION_PAYMENT_TOKEN` | Sites server to App checkout and status only (App and Sites hold it) |
| `JWT_SECRET` (tenant-api)         | Customer access tokens (audience `tenant-api`)                       |
| `AUTH_HMAC_SECRET`                | Derived capability tokens and hold-token hashing                     |

## 9. Native clients and contract fixtures

The iOS and Android apps call the public routes above directly and follow these
rules:

- Send `Origin` (https site origin) and, for non-https local origins, the `slug`
  or `host` query parameter, on **every** reservations call; send
  `X-Client: ios` or `X-Client: android`.
- Booking, requests, waitlist and notify-me require the phone-OTP sign-in. The
  customer Bearer token replaces Turnstile and the apps never send a Turnstile
  token. The guest phone is the signed-in customer's (`GET /auth/me`).
- Every mutation is `POST`. Generate an `Idempotency-Key` per booking attempt
  and **reuse the same key on a retry** after a network error, so a lost
  response replays instead of double-booking.
- Manage tokens live in the Keychain (iOS) and the Keystore-backed storage
  (Android), never in preferences, logs or URLs (the `.ics` download is the only
  exception, and the apps open it without logging).
- The hold countdown uses `expiresAt` and the server `now` offset, never the
  device clock alone. Handle `409 slot_unavailable` by showing `alternatives`,
  `410 hold_expired` by returning to the slot choice, `400 policy_required` by
  asking for consent, `429 rate_limited` by backing off.
- Payments: open `payment.payUrl` in the system browser (no deep links), poll
  `GET /manage/payment` when the app returns to the foreground, and treat
  `pending_payment`, review states and expiry as in section 5.
- Code: `apps/ios/Sources/TenantKit/Reservations/` (`ReservationsClient.swift`,
  `ReservationModels.swift`, `BookingFlow.swift`) with SwiftUI screens in
  `apps/ios/Sources/TenantApp/Reservations/`; `core/reservations/` and
  `ui/reservations/` under
  `apps/android/app/src/main/kotlin/com/epicstartup/tenant/`.

**Fixtures.** `packages/reservations/contract-fixtures/*.json` are recorded from
the real public routes with seeded demo data (volatile ids, tokens and times are
normalized). `apps/ios/Tests/TenantKitTests/Fixtures/Reservations/` and
`apps/android/app/src/test/resources/reservations/` hold byte-identical copies.
Re-record with `npm run fixtures:reservations -w tenant-api`. Fixtures:
`config`, `availability`, `availability-preferred-taken`, `calendar`, `hold`,
`hold-requires-payment`, `booking`, `booking-pending-payment`, `request`,
`manage`, `mine`, `payment-status-none`, `payment-status-pending`,
`waitlist-join`, `waitlist-status`, and the errors `error-hold-expired`,
`error-invalid`, `error-policy-required`, `error-rate-limited`,
`error-slot-unavailable`.

Tests: `packages/reservations/src/reservations-contract.test.ts` (schemas and
byte identity, no database) and
`apps/tenant-api/src/routes/reservations-contract.test.ts` (live responses must
match the fixtures key for key; a verified customer token passes with the
Turnstile secret set, the same call without it answers 403).
