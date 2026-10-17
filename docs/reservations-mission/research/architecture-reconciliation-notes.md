# Architecture reconciliation notes

These notes record each conflict found while merging the sources into
`{missionDir}/architecture.md`, and how it was settled. Priority order:
`mission.md`, then `research/architecture-draft.md`, then the codebase
deep-dives (`research/codebase/*`), then domain research. A fact checked in the
repository (`/home/factory-user/repos/menuza`, branch `pr/reservations`)
overrides any document.

Each bullet gives the topic, the sources that disagree, the resolution, and the
reason.

## Scope, milestones and references

- **Payment testing approach.** Sources: `payments-deep-dive.md` (real Stripe
  test mode works locally) and draft slice S10 ("Sites booking with Stripe test
  mode") versus `mission.md` (Stripe and Checkout.com emulated locally, with
  mock hosted pages and signed webhooks) and `payment-mocks-design.md`.
  Resolution: every local and CI payment flow uses the emulators in
  `packages/payments/src/mock/`, built in the `payment-mocks` milestone and
  validated first against existing online ordering. Real sandboxes are out of
  scope (architecture section 20). Reason: mission authority, and CI has no
  provider credentials.
- **Delivery slices.** Sources: draft slices S0 to S16 versus the mission's 12
  milestone ids. Resolution: the slices are folded into the 12 milestones
  (architecture section 19). Reason: the mission's milestone ids are
  authoritative.
- **Background re-optimizer.** Sources: `reservation-engineering.md` section 2.4
  and the draft's slice list versus the mission scope. Resolution: out of scope;
  there is no `reoptimize` tick task. Only bounded repair (`reflow`) during
  writes is built. Reason: the mission does not ask for it, and a background
  writer would compete with operators' edits.
- **Unfilled draft sections.** Sources: the draft's `TODO(payments)` and
  `TODO(native)` markers. Resolution: filled from `payments-deep-dive.md`,
  `payment-mocks-design.md` and `native-apps-deep-dive.md` (architecture
  sections 12, 13 and 15). Reason: the deep-dives were written to answer them.
- **Open questions.** Sources: draft section 17 lists 9 open questions with
  recommendations. Resolution: architecture section 22 resolves all 9 (keeping
  the draft's recommendations, with question 2 changed by the journeys bullet
  below) and adds 3 questions raised during reconciliation: Experiences
  placement, Guestbook placement and KSA card guarantees. Reason: the
  architecture must leave no open design question for workers.
- **Engineering research path.** Sources: the draft cites
  `/home/factory-user/reservations-planning/research/reservation-engineering.md`;
  the file is at `{missionDir}/research/reservation-engineering.md`. Resolution:
  the mission path is used, and sections 1.4, 2.2, 2.3, 3.4 and 7.1 are marked
  normative. Reason: the draft path is outside the mission directory.

## Data model and migrations

- **Guest table name.** Sources: `integrations-deep-dive.md` section 7
  (`guest_profiles`) versus the draft (`rsv_guests`). Resolution: `rsv_guests`,
  with the deep-dive's reasons kept (separate from the OTP `customers` login
  record, linked only through OTP or explicit consent). Reason: every module
  table uses the `rsv_` prefix, which keeps the module separable for upstream
  template syncs.
- **Seeding flags.** Sources: the draft seeds with `INSERT OR IGNORE` (copied
  from the staffing `0022` permission migration) versus the repository: the
  `ConfigFlag` unique index includes nullable columns, so SQLite treats two
  system rows with the same key as distinct and `INSERT OR IGNORE` would add
  duplicates. Resolution: `Permission` and role grant rows keep
  `INSERT OR IGNORE` (fixed primary keys); `ConfigFlag` rows use
  `INSERT ... SELECT ... WHERE NOT EXISTS`. Reason: repository fact.
- **Control-plane migration numbers.** Sources: the draft (no numbers) versus
  the repository (latest is `packages/database/drizzle/0024_dashboards.sql`;
  latest tenant migration is `0015_hiring_interested_scopes.sql`). Resolution:
  control `0025_reservations_foundation` (8 permissions, admin grants, system
  rows `false` for the six flags) and `0026_reservations_platform_fee` (system
  row `reservations.platform_fee_bp` = 0, in `payments-experiences`); tenant
  `0016_reservations_foundation` and `0017_voice_actions_and_demand_units` (in
  `integrations`). Reason: repository fact; the fee arrives with the payments
  milestone.
- **Journey dedupe.** Sources: `integrations-deep-dive.md` (journeys have no
  dedupe today) versus `mission.md` (deduplicated per booking and trigger).
  Resolution: new table `rsv_journey_emissions` with primary key
  `(reservation_id, trigger)`, inserted before emitting; a conflict means the
  trigger already fired. Reason: retries and outbox replays must not start a
  journey twice.
- **Capability token storage.** Sources: the draft stores `manage_token_hash`
  (sha256 of the derived token) plus `manage_token_version`. Resolution: manage,
  pay, waitlist-status and notify-cancel tokens are HMAC-derived from the row id
  and the version counter, so only the version is stored; bumping it revokes the
  token. Hold tokens stay random and are stored hashed. Reason: a derived token
  can be verified by recomputing it, so the hash column adds nothing.

## Routes and naming

- **Public route prefix.** Sources: `native-apps-deep-dive.md` (`/booking/*`,
  with `/booking/holds/:id/confirm`) versus the draft (`/reservations/*`, with a
  customer token replacing Turnstile for native clients). Resolution: the
  draft's `/reservations/*`, GET and POST only, with the customer-token
  substitute; added `/holds/current`, `/holds/release` and `/manage/payment`.
  Reason: one public surface for Sites and native apps.
- **Internal payment routes.** Sources: `payments-deep-dive.md`
  (`/api/reservations/payment-quote`, `payment-session`, `payment-status`,
  `fee-claim`, `fee-result`, `refund-claim`, `refund-result`, `dispute-status`)
  versus the draft (`/api/reservations/payments/quote`, `/bind`, `/status`,
  `/fee-quote`, `/refund-result`). Resolution: the draft's
  `/api/reservations/payments/*` prefix and its `quote`, `bind`, `status` names,
  plus the deep-dive's claim and result pairs: `fee-claim` (single shot,
  `pending -> charging` atomically, replacing the draft's `fee-quote`),
  `fee-result`, `refund-claim`, `refund-result`, `dispute`, and a new `pending`
  endpoint for the reconcile job. Reason: the draft's grouping keeps the payment
  broker in one router; the deep-dive's claim step prevents double charges and
  double refunds.
- **Operator fee route.** Sources: `payments-deep-dive.md`
  (`POST /operator/reservations/:id/fees`, then App
  `POST /:orgSlug/reservations/fees/charge`) versus the draft (payments router
  `/reservations/:id/fee`). Resolution: regional
  `POST /operator/reservations/payments/reservations/:id/fee` with a `payments`
  token, then App action `reservations+/payments.fee.ts`. Reason: payment
  actions share one router and the payment grant.
- **Token scopes.** Sources: `payments-deep-dive.md` (`reservations:write`) and
  `integrations-deep-dive.md` (`reservations:read`) versus `mission.md` (scopes
  `book`, `guests`, `setup`, `reports` and `payments`). Resolution: the
  mission's scopes. Reason: mission authority.
- **Blocks routes.** Sources: the draft puts `POST /blocks` and
  `DELETE /blocks/:id` in the book router and lists "blocks" under
  `UPDATE_RESERVATION`. Resolution: `GET/POST/DELETE /blocks` on the setup
  router under `UPDATE_RESERVATION_SETTINGS`; "blocks" was removed from the
  `UPDATE_RESERVATION` description. Reason: a block changes availability for
  every guest, which is a settings decision rather than an edit to one booking.
  (Internal consistency fix made during drafting.)
- **Dashboard block id.** Sources: the draft (`reservations-today`) versus
  `integrations-deep-dive.md` (`bookings-today`). Resolution: `bookings-today`,
  served by `GET /operator/reservations/book/today`. Reason: it matches the
  mission's report subject `bookings` and keeps generic words in shared
  dashboard code.

## Integrations

- **Voice action seam.** Sources: the draft (`callAction(name, input)` on
  `VerticalServices`) versus `integrations-deep-dive.md`
  (`services.action(...)`). Resolution: generic `services.action(name, input)`
  in `packages/phone-agent/src/vertical.ts`, served by tenant-api
  `/api/voice/actions/:name`. Reason: it matches how the existing services
  object is used by tools, and both sources agree on the endpoint.
- **Voice action set and default mode.** Sources: the draft
  (`reservations.availability`, `reservations.book`,
  `reservations.link-payload`) versus `integrations-deep-dive.md`
  (`booking_availability`, `booking_hold`, optional `booking_create`; default
  hold and confirm link, confirm-on-call only for organizations without
  deposits). Resolution: the draft's `reservations.*` naming with the
  deep-dive's behavior: `reservations.availability` (cap 10 per call),
  `reservations.hold` (cap 2) and `reservations.book` (cap 1, only when
  `voice_mode = 'confirm_on_call'` and no policy requires payment). The default
  `voice_mode` is `hold_link`: the tool texts `/reserve#h=<holdToken>`.
  `link-payload` is dropped because the hold token carries the prefill. Reason:
  a booking taken by voice cannot show the guest a payment policy, and the hold
  link reuses the public booking flow.
- **Staffing demand seam.** Sources: the draft
  (`registerDemandSignal({ key, unit: 'count' | 'people', ... })`, signal
  `booked_guests`) versus `mission.md` (a demand-source registry with a `visits`
  unit; `registerOrderSource` kept) and the repository (`registerOrderSource`
  and `hasOrderSource()` in `apps/tenant-api/src/services/order-source.ts`).
  Resolution: `registerDemandSource({ id, unit, loadBuckets, loadBooked })` with
  units `orders` and `visits`; `registerOrderSource` becomes a wrapper and
  `hasOrderSource()` keeps its behavior. Tenant `0017` adds
  `labor_scope_settings.demand_per_labor_hour` beside the existing
  `orders_per_labor_hour`. Reason: mission authority, and existing callers must
  not change behavior.
- **Journey eligibility.** Sources: the draft (fire only when the reservation
  has a verified `customer_id`) and `integrations-deep-dive.md` (journey steps
  do not check consent) versus `mission.md` (only verified or explicitly
  consenting guests; a consent check added to journey step execution).
  Resolution: journeys fire for verified or consenting guests. Consent creates
  an unverified `customers` row (`rsv_guests.marketing_customer_id`, used only
  for journeys) and a `reservations` topic subscription. The consent check in
  `executeJourneyStep` applies only to reservation triggers. Reason: mission
  authority; existing journeys keep their behavior.
- **Experiences placement.** Sources: `integrations-deep-dive.md` (definition in
  the control plane as `OrganizationExperience` and
  `OrganizationExperienceSession`, bookings regional) versus the draft (regional
  `rsv_experiences`). Resolution: regional `rsv_experiences`; Sites reads the
  public, non-PII definitions from tenant-api. Reason: the engine reads them
  inside the regional write transaction together with settings and capacity
  (architecture section 3.1), and the mission lists experiences among regional
  settings.
- **Guestbook placement.** Sources: `integrations-deep-dive.md` section 7 ("one
  customer UI, two lenses": extend the existing App `customers.tsx`) versus the
  draft (regional `/operator/reservations/guests/*` with its own screens).
  Resolution: the draft's module CRM; `customers.tsx` is unchanged. Reason:
  guest records carry reservation-only and sensitive fields (allergies, notes,
  tags, visit counters) under separate guest permissions, and `customers.tsx`
  requires only `READ_SETTINGS_ANY`.

## Payments

- **Platform fee.** Sources: `mission.md` (Admin-configured
  `reservations.platform_fee_bp`, system default 0 with per-organization
  overrides) versus the draft and deep-dives (no reservation fee; ordering uses
  `SHOP_PLATFORM_FEE_PERCENT = 20`). Resolution: basis points 0 to 10000,
  organization override then system value then 0; Admin route
  `apps/admin/app/routes/_admin+/reservations.platform-fee.tsx` with Zod
  validation; the App snapshots `platformFeeBp` and `platformFeeMinor` into the
  regional payment row through `/bind` and `/fee-result`; refunds return the fee
  proportionally (the deep-dive's `refund_application_fee: true`). Reason:
  mission requirement; the snapshot keeps past payments stable when the setting
  changes.
- **Payment hold versus the Stripe session minimum.** Sources: the draft
  (`payment_hold_minutes` default 20) versus `payments-deep-dive.md` (Stripe
  `expires_at` cannot be sooner than 30 minutes, so ordering omits it when the
  hold is shorter). Resolution: holds stay at 20 minutes. At expiry the App
  expires the session; a payment that still succeeds re-runs the plan in the
  write path and books if the slot fits, otherwise the App refunds in full at
  once. The payment goes to `review` only if that refund fails. Reason: short
  holds protect inventory, and the late case resolves without manual work.
- **Refund execution.** Sources: `payments-deep-dive.md` (a Sites browser nudge
  `POST /resources/sites/reservation/refund` plus a
  `/resources/jobs/reservation-refunds` cron sweep) versus the draft (a
  `refund_request` row in `rsv_outbox`). Resolution: the regional tick delivers
  `refund_request` outbox rows to App `POST /resources/reservations/payments`;
  the App claims them with `/refund-claim` and reports `/refund-result`. The
  hourly `jobs.reservation-payments-reconcile` job settles pending sessions and
  refunds. There is no browser nudge and no separate refunds cron. Reason: one
  retried, observable delivery path that does not depend on an open browser.
- **KSA card guarantees.** Sources: `payments-deep-dive.md` (guarantees are US
  Stripe only; mada has limited support for stored credentials and MIT) versus
  `mission.md` (card guarantee via Stripe setup mode or a Checkout.com stored
  instrument). Resolution: KSA guarantees use Checkout.com stored instruments
  where the processing channel supports stored credentials, and operators see a
  caveat that some mada cards cannot be charged later. Reason: mission
  authority, with the deep-dive's limit stated.
- **Stripe webhook secrets.** Sources: `payments-deep-dive.md` (today there is
  one `STRIPE_WEBHOOK_SECRET` and no Connect secret; open question 1 asks
  whether to support platform and Connect endpoints). Resolution:
  `getStripeWebhookSecrets()` returns
  `[STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET?]` and the webhook
  tries each; the new optional variable is listed in architecture section 17.
  Reason: Stripe signs the platform and Connect endpoints with different
  secrets.

## Platform guards, native and local development

- **Region-switch guard location.** Sources: the draft
  (`GET /resources/reservations/region-summary?orgId` described as an
  App-internal helper, and a "`website+/_index` guard") versus the repository:
  the dialog is in
  `apps/app/app/components/settings/cards/organization/site-card.tsx`, which
  calls the operator-session loader
  `GET /resources/staffing/region-summary?orgSlug=` (`update:settings:any`) and
  `requiresStaffConfirmation`; the server check is in the region-change action
  of `apps/app/app/routes/_app+/$orgSlug_+/website+/_index.tsx`, through
  `fetchStaffSummary` and `evaluateRegionGuard` from
  `utils/staffing/region-guard.server.ts`. Resolution: mirror the staffing
  pattern with `resources+/reservations.region-summary.ts` (keyed by `orgSlug`,
  counts only), `utils/reservations/region-guard.server.ts` and
  `region-confirmation.ts`; the counts appear in the same typed-confirmation
  dialog, and the same action refuses with 409 while payments are unsettled. The
  App guards test checks both. Reason: repository fact; one dialog and one typed
  slug cover all module data.
- **Native contract fixtures.** Sources: `native-apps-deep-dive.md` (capture
  fixtures from a local tenant-api, or embed them as string literals in each
  app's tests) versus `mission.md` (fixtures recorded from the local tenant-api,
  plus a tenant-api contract test). Resolution:
  `apps/tenant-api/scripts/record-reservations-fixtures.ts` records responses to
  `packages/reservations/contract-fixtures/*.json`; they are copied into the iOS
  and Android test resources, and a contract test checks the copies are
  byte-identical. Reason: one recorded source of truth prevents drift between
  the server and both apps.
- **Dev email capture.** Sources: `mission.md` (a new dev-only email capture,
  never active in production; App emails captured under Workers dev) versus the
  draft (none) and the repository (tenant-api email goes through
  `apps/tenant-api/src/lib/tenant-email.ts` to OCI; App email goes through
  Resend in `send-email.ts`; MSW captures email only in Node mode). Resolution:
  tenant-api `lib/dev-email-capture.ts` writes JSON files to
  `DEV_EMAIL_CAPTURE_DIR` (`.dev-mail/us` or `.dev-mail/ksa`, set by the dev
  scripts), ignored in production or when OCI is configured; the root
  `.gitignore` gains `apps/tenant-api/.dev-mail/`. The App's
  `workers/dev-email-capture.ts` stores Resend calls in a `__dev_email_capture`
  D1 table, with a `mock-email+/` viewer stripped by `build:cf`. Both use the
  record format
  `{ id, capturedAt, source, region, to, from, subject, html, text, meta }`.
  Reason: mission requirement; the production guard copies the `dev-s3-mock.ts`
  pattern.
