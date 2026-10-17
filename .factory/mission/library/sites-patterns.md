# Sites patterns (public guest pages, `apps/sites`)

What belongs here: how the public Sites app works and the existing pieces that
the Reservations pages, the "Book a table" block and the payment hand-off must
reuse.

What does NOT belong here: the public tenant-api route contract and limits (see
`architecture.md` section 15), payment provider internals (see
`payments-reference.md`, `payment-mocks.md`), native clients (see
`native-reference.md`).

Paths are relative to `/Users/zama/menuza` and were verified. Decisions are
summarized in one line; the full text is in `architecture.md` section 11.

## Non-negotiable rules

- Sites SSR never fetches, renders or proxies guest data (names, phones, emails,
  notes, bookings). The guest's browser calls the regional tenant-api directly
  (`/reservations/*`). A Sites BFF would transit KSA PII through the US.
- Customer tokens stay in `localStorage` (`tenant_access_token`,
  `tenant_refresh_token`) via `apps/sites/src/lib/client-auth.ts` (`tenantFetch`
  with auto-refresh, `getOrgBinding`, `getBrowserTenantApiUrl`). Never Sites
  cookies.
- Manage, waitlist-status and notify-cancel tokens travel in the URL fragment
  (`#t=<token>`) and `sessionStorage`, never in a path or query, so they never
  reach a server log. They are sent to tenant-api in the `X-Reservation-Token`
  header.
- Sites only ever sees opaque ids for payments (reservation or fee id plus a
  payment token, and the `purpose`), never amounts tied to a person or card
  data.

## App shape

- Astro with the Cloudflare adapter, `output: 'server'`
  (`apps/sites/astro.config.mjs`). Dev on port 3008 (IPv6 loopback).
- Start: `cd apps/sites && PUBLIC_APP_URL=http://localhost:3001 npm run dev`.
  Test with `Host: acme.menuza.test:3008` or the browser resolver rule
  `MAP *.menuza.test [::1]`.
- Middleware `apps/sites/src/middleware.ts`:
  - resolves the org from the host (slug subdomain or custom domain);
  - fetches the published org from App `/resources/sites`;
  - resolves the locale (redirect, rewrite or 404 for disabled locales);
  - applies tenant redirects;
  - preloads the CMS page for non-app routes;
  - edge-caches published HTML (`max-age=60, swr=300`), and sets `no-store` for
    drops and careers.
- CSP `connect-src` already allows App and both tenant-api origins.
- App-route registry `apps/sites/src/lib/site-headers.ts`: `APP_ROUTE_SLUGS`,
  `isSitesCareersRoute`, `isSitesAppRoute`. Add `isSitesReservationsRoute`
  (covering `reserve` and `experiences`) to `isSitesAppRoute` so CMS preloading
  is skipped. `/reserve*` is `no-store`; experience pages are `max-age=60`.
- Reserved CMS slugs: `SITE_LINK_RESERVED_PATHS` in
  `packages/common/src/site-link.ts` gains `reserve` and `experiences`.
- Regional URL: `getTenantApiUrl(dataRegion)` in
  `apps/sites/src/lib/tenant-api.ts` (KSA uses `TENANT_API_URL_KSA`) is rendered
  as `data-tenant-api-url` on `<html>` in
  `apps/sites/src/layouts/SiteLayout.astro`. Client code reads it with
  `getBrowserTenantApiUrl()`.

## Pages to add

| Page                                                            | Milestone            | Notes                                                                        |
| --------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `src/pages/reserve/index.astro`                                 | online-booking       | full flow; query prefill `?location=&party=&date=&time=`; voice resume `#h=` |
| `src/pages/reserve/manage.astro`                                | online-booking       | manage view from `#t=`                                                       |
| `src/pages/reserve/waitlist.astro`                              | waitlist             | remote join and status (`#t=`)                                               |
| `src/pages/reserve/pay.astro`                                   | payments-experiences | payment hand-off for web and native, fragment `#r=&t=` or `#f=&t=`           |
| `src/pages/experiences/index.astro`, `experiences/[slug].astro` | payments-experiences | SSR may fetch the public, non-PII `GET {tenantApi}/reservations/experiences` |
| `src/pages/profile.astro` (existing)                            | online-booking       | "Upcoming reservations" panel fed in the browser by `GET /reservations/mine` |
| `src/pages/api/reservations/payment.ts`, `payment-status.ts`    | payments-experiences | opaque forwarders to App (ordering pattern)                                  |

- Locale prefixes (`/ar/reserve`) work through the existing middleware rewrite.
- Experience SSR follows the FormBlock precedent: 3 s timeout, short cache,
  public definition only.

## Flag gate (careers pattern)

- `apps/sites/src/pages/careers/index.astro` asks App `/resources/sites/careers`
  (`apps/app/app/routes/resources+/sites.careers.ts`, 404 unless the site is
  published and `staffing.hiring` is on). When absent it falls back to a CMS
  page named `careers` or 404.
- Reservations: SSR asks App `/resources/sites/reservations?slug|host`, which
  returns `{ online, waitlist, experiences, notifyMe }` or 404 when the master
  flag is off or the site is unpublished. On 404 it falls back to a CMS page
  named `reserve` or 404.
- Which locations and experiences are bookable comes from
  `GET /reservations/config` and `/reservations/experiences` in the browser.
- Public fetchers for App payloads live in `apps/sites/src/lib/org.ts`
  (`fetchPublishedCareers` is the model).

## Reusable client pieces

| Need                                                       | Reuse                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Hold countdown                                             | `apps/sites/src/lib/ordering/hold-timer.ts`, `countdown.ts` (offset by the server `now`)                                      |
| Add to calendar (`.ics` data URL)                          | `apps/sites/src/lib/ordering/calendar.ts` (`buildIcsDataUrl`); tenant-api also serves `GET /reservations/manage/calendar.ics` |
| Browser slot/date helpers                                  | `apps/sites/src/lib/ordering/schedule.ts` (two-pass zone math, Sites only); prefer `@repo/reservations` time helpers          |
| Error code -> label                                        | `apps/sites/src/lib/ordering/order-errors.ts` pattern                                                                         |
| Labels into scripts                                        | JSON label block as in `apps/sites/src/components/ordering/OrderingLabels.astro`                                              |
| Opening hours summary                                      | `apps/sites/src/lib/menu-hours.ts` (`summarizeHours`)                                                                         |
| Browser-direct form with Turnstile + honeypot              | `apps/sites/src/components/careers/ApplyPanel.astro`, `apps/sites/src/lib/careers/apply-form.ts`                              |
| Embeddable block that SSR-fetches only a public definition | `apps/sites/src/components/blocks/FormBlock.astro`                                                                            |
| Fragment payload read on load                              | `apps/sites/src/scripts/voice-order-handoff.ts` (ordering's voice hand-off, `GET /voice/handoffs/:token`)                     |

- New code goes in `src/lib/reservations/*` (client modules with Vitest tests)
  and `src/components/reservations/*`.

## Booking flow (guest)

The order of steps (architecture section 11):

1. Location.
2. Party size.
3. Date (calendar summary).
4. Time chips with seating-area labels.
5. When nothing fits: nearby alternatives, other dates, "Notify me", "Join
   waitlist" (same day only).
6. Hold with countdown.
7. Details: name, phone, email, occasion chips, requests, dietary chips and
   notes, seating preference, SMS opt-in (US only), marketing opt-in, policy
   text and consent with `termsVersion`.
8. Payment step when required.
9. Confirmation: code, add-to-calendar, manage link.

Rules:

- Large party above the online maximum: `contact` mode shows the location phone;
  `request` mode posts `POST /reservations/requests`.
- Signed-in customers get prefilled details and their `customer_id` binding. An
  invalid or cross-org customer token is rejected by tenant-api, not ignored.
- Times are shown in restaurant local time, with the zone shown when the
  visitor's zone differs.
- Creates send an `Idempotency-Key` (UUID per attempt). Mutations are POST only,
  never GET.
- The manage token is kept in `sessionStorage` and the URL fragment, never sent
  to the Sites server.
- Voice hand-off (`integrations` milestone): the phone agent's `book_table` tool
  texts `/reserve#h=<holdToken>`. The page resumes the hold through
  `GET /reservations/holds/current` and opens the details step.

## Turnstile and honeypot

- `PUBLIC_TURNSTILE_SITE_KEY` is Sites only; empty disables the widget locally.
- Widget `data-action` per form: `reservation-hold`, `reservation-request`,
  `reservation-notify`, `waitlist-join`. Existing actions: `website-form`,
  `careers-apply`, `place-order`.
- Server verification is in tenant-api (`verifyTurnstileToken` in
  `packages/common/src/turnstile.server.ts`, `TURNSTILE_SECRET_KEY`,
  `TURNSTILE_HOSTNAMES`). Locally Turnstile stays off; enforcement is covered by
  tenant-api tests.
- Honeypot field name `website`; a filled honeypot gets the same answer as a
  success.

## Payment hand-off (ordering pattern)

- Ordering today: browser -> Sites `POST /api/orders/payment`
  (`apps/sites/src/pages/api/orders/payment.ts`, opaque `orderId` +
  `paymentToken`) -> App `POST /resources/sites/order/checkout`
  (`apps/app/app/routes/resources+/sites.order.checkout.ts`) -> provider hosted
  page. Status: Sites `payment-status.ts` -> App
  `POST /resources/sites/order/status`.
- Reservations: the create response carries
  `payment: { paymentToken, purpose, amountMinor, currency, expiresAt, payUrl }`.
  Browser -> Sites `POST /api/reservations/payment` -> App
  `POST /resources/sites/reservation/checkout` with opaque
  `{ slug|host, reservationId | feeId, paymentToken, purpose, locale }` ->
  hosted page (mock pages locally).
- After return, poll Sites `/api/reservations/payment-status` -> App
  `/resources/sites/reservation/status`. See `payments-reference.md` for the
  quote, bind and status broker behind those routes.
- Provider metadata is ids only:
  `{ type: 'reservation_payment' | 'reservation_fee' | 'reservation_refund', orgId, reservationId, purpose, feeId? }`
  (architecture 12.1).
- `apps/sites/src/lib/ordering/order-client.ts:255-257` rejects any
  `checkoutUrl` whose protocol is not `https:`. The mock hosted pages are
  `http://localhost:3001/mock-payments/...`, so the `payment-mocks` milestone
  makes `order-client.ts` and the new reservation client accept `http:` only for
  loopback hosts (`localhost`, `127.0.0.1`, `*.localhost`) outside production.
  Production must still require `https:`.

## "Book a table" block

- App registry: `apps/app/app/utils/website/block-types.ts` (`BLOCK_TYPES`:
  label, icon, description, `defaultConfig`; `LOCALIZED_FIELDS`;
  `PAGE_TEMPLATES`). Tests in `block-types.test.ts`.
- Inspector and preview cases are in
  `apps/app/app/routes/_app+/$orgSlug_+/website+/pages.$pageId.tsx`.
- Hidden in the builder unless `reservations.online` is on.
- Publish path: `WebsitePage` / `WebsitePageSection`; the snapshot is served by
  `apps/app/app/utils/sites/public-org.server.ts`.
- Sites renderer: `apps/sites/src/components/blocks/ReservationBlock.astro`,
  registered in `apps/sites/src/components/blocks/RenderBlocks.astro`. It is a
  compact party / date / time bar that mounts the same client inline or links to
  `/reserve?location=&party=&date=&time=`.
- There is no "app route" link type in `SiteLink`; header CTAs to `/reserve` are
  plain URLs.

## i18n (six locales)

- Locales `en`, `ar`, `es`, `fr`, `de`, `zh`
  (`packages/common/src/site-locales.ts`). RTL for `ar`. Non-default locales are
  prefixed (`/ar/reserve`). Catalogs: `apps/sites/src/locales/*.po`.
- Use Lingui `msg`; extract with `npm run lingui:extract -w sites`.
- Every reservations string needs a non-empty translation in all six catalogs
  (the ordering rule in `docs/sites-ordering-ux.md`). A Sites Vitest
  label-completeness test enforces it. `node scripts/check-lingui.mjs` must
  pass.
- Locale links: `getLocaleHref`, `siteLocaleHref`, `browserLocaleHref`.
- Guest emails use EN or AR only (other locales fall back to EN). Manage links
  are `<siteOrigin>[/ar]/reserve/manage#t=<token>`.

## Tests and checks

- `npm run test -w sites` (Vitest) for client modules and label completeness.
- `npm run lint -w sites` is part of the milestone gate.
- User testing: agent-browser on 3008 with `acme` (English, US node 3007) and
  `riyadh-grill` (Arabic, RTL, KSA node 3009).

## Superseded research

- `ordering-locations-sites-payments.md` recommends leaving native apps out of
  the mission. Superseded: milestone 12 builds native booking.
- It suggests a control-plane `OrganizationReservationSettings` or floor-plan
  tables as an option. Superseded: all reservation settings, floor plans and
  policies are regional (`rsv_*`).
- It proposes adding scopes to `getOperatorTenantClient`
  (`reservations:read|write`). Superseded: reservations has its own `rsv+jwt`
  audience and token route.
- It names the payment metadata type `reservation_deposit`. Superseded: the
  architecture uses `reservation_payment`, `reservation_fee` or
  `reservation_refund` with a `purpose` field.
- Research voice hand-off ideas (`send_booking_link`, `/reserve/confirm`, link
  payloads) are superseded by `book_table` texting `/reserve#h=`.

## Scrutiny findings — guest-channels-and-crm (round 1)

- **SQL edits to `Organization.siteLocales` need a KV purge.** The App caches
  the published-org payload in KV for 24 hours
  (`apps/app/app/utils/sites/kv-cache.server.ts:75`); only publishing from the
  App UI invalidates it. Flipping locales by SQL (as validators do for
  `/ar/reserve`) keeps serving the stale payload until the key is purged.
- **The builder preview cannot render the reservations block locally.**
  Previewing a page with the "Book a table" block returns 404 "Organization not
  found" in this environment. Publish a page and load it on Sites instead
  (`/reserve` on the org host) — that is how VAL-ONLINE-053/054 should be
  checked.
- **Preferred-time context is dropped in the availability search.** `flow.ts`
  parses `?time=` but never passes `localMin` to `api.availability`
  (`apps/sites/src/lib/reservations/flow.ts:606`), so on an exhausted day the
  other-date suggestions show each date's earliest slot rather than a slot near
  the requested time. `alternatives.sameDay` is unreachable in the flow: it is
  only produced when slots exist, and the alternatives block renders only when
  they do not (`flow.ts:483-523`). The day's remaining times still appear as
  chips.
