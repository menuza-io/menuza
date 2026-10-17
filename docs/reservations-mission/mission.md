# Reservations module (OpenTable-class) for Menuza

# Reservations module for Menuza

## 1. Plan overview

Build an OpenTable-class reservation system for restaurant organizations as a
restaurant-specific **Reservations** module. It follows the Staff module's
patterns:

- organization-level feature flags that default to off
- role permissions
- all guest data stored in the regional per-organization SQLite database behind
  tenant-api
- the operator's browser calls tenant-api directly, using short-lived operator
  tokens minted by the App
- public guest routes are called from the visitor's browser, and the
  organization is resolved from `Origin`
- CI security tests that check every route

**Scope (the maximum scope the user chose)**

- **Front of house:** reservation book, timeline, live floor plan host stand,
  server sections, walk-ins, waitlist (in person and remote), notify-me,
  Guestbook CRM, and large-party requests with approval.
- **Business:** online booking on the restaurant website, guest messages (email
  and US SMS), reports and a dashboard block, deposits, prepayment, card
  guarantees, no-show and late-cancellation fees, refunds, Experiences, and
  marketing journey triggers.
- **Integrations:** phone-agent booking tools, bookings as a staffing forecast
  demand signal, and native iOS and Android booking.

**Decisions made with the user during planning**

1. This is a restaurant-specific `reservations` module, not a generic bookings
   module. It lives in clearly named reservations paths (plus `restaurant/`
   adapters) so it can be excluded from upstream template syncs as a unit.
2. US payments use Stripe Connect with destination charges. KSA payments use
   Checkout.com through its Hosted Payments Page. The US-only Checkout.com
   guards are removed.
3. The platform fee on reservation payments is configured in Admin. There is a
   platform default and an optional per-organization override; both start at 0%.
4. No real payment keys are used.
   - Stripe and Checkout.com are emulated locally the way GitHub login is
     mocked: the real SDKs talk to an in-process emulator with mock hosted pages
     and signed webhooks.
   - The mock can never be active in production.
5. Guest messages use dev mock transports: SMS log lines and a new dev-only
   email capture. No real email or SMS is sent.
6. The phone agent is validated with tool tests and API calls only. There are no
   live calls.
7. Native apps: JDK 17, the Android SDK and Swift are installed on this machine.
   - Builds and tests are validated here; the user checks the screens on
     devices.
   - The Android byte budget may be raised, with the reason recorded, if the
     feature needs it.
8. App Playwright e2e specs stub tenant-api, following the staffing pattern.
9. Research inputs:
   - OpenTable's 13-video playlist. Transcripts were not obtainable; the
     findings come from titles, chapters and support pages.
   - General reservation-platform research.
   - Both are distilled in the mission library. The raw notes are kept under the
     mission's `research/` folder.

**Out of scope**

- POS integration, Reserve with Google, two-way SMS, the Expo mobile app, a
  diner marketplace, loyalty points and gift cards.
- The background re-optimizer.
- Free-form editing of message templates. Instead, the EN/AR templates live in
  code, and operators can add a custom note per message kind.
- WebSocket live updates. ETag polling is used instead.

## 2. Expected functionality (4 consolidated milestones covering all 12 functional areas)

Each milestone ends with automatic validation (scrutiny review, then user
testing). Per user request mid-mission to reduce worker and validator session
spawns, functional areas 2–12 are grouped into 3 consolidated execution
milestones after `foundation`:

- **`foundation`** (Functional area 1: Foundation)
- **`foh-core`** (Functional areas 2–4: Setup, Reservation book, Host stand — 3
  consolidated features)
- **`guest-channels-and-crm`** (Functional areas 5–8: Online booking, Guest
  messages, Waitlist, Guestbook & reports — 3 consolidated features)
- **`payments-integrations-and-native`** (Functional areas 9–12: Payment mocks,
  Payments & experiences, Integrations, Native apps & final docs — 3
  consolidated features)

### Milestone 1: Foundation (`foundation`)

- **New `@repo/zoned-time` package:**
  - Staffing's `tz.ts` moves here unchanged, and `@repo/staffing` re-exports it.
  - Staffing tests stay green.
- **New `@repo/reservations` package**, containing pure domain logic with no
  I/O:
  - flags, permissions and token claims
  - DST-safe time helpers
  - config schemas and `validateConfig`
  - service resolution with special-day precedence
- **The engine:**
  - availability, pacing, alternatives and calendar summary
  - best-fit table assignment, bounded repair and reflow; locked assignments
    never move
- **Other domain logic:**
  - the booking state machine and its quick actions
  - policy math and message schedule math
  - API schemas and stable error codes
- **Tests for the domain package:** fast-check property tests against a
  brute-force oracle, plus DST tests (New York, Los Angeles, London and Riyadh).
- **Tenant DB migration `0016_reservations_foundation.sql`:**
  - all `rsv_*` tables
  - a table-overlap trigger, append-only triggers, and a trigger that allows a
    hold to convert to a booking only once
  - schema tests
- **Control-plane migration `0025_reservations_foundation.sql`:**
  - eight permissions, granted to the admin role
  - role presets: Host, Reservations manager, Guest relations, Owner
  - a role-editor group, hidden unless the flag is on
- **Six flags:** `reservations.enabled` (the master flag), `.online`,
  `.waitlist`, `.payments`, `.experiences` and `.voice`.
  - Only a literal `true` turns a flag on, and child flags count only while the
    master flag is on.
  - System-level `false` rows are created for each key.
- **Operator token minting** in the App: audience
  `tenant-api-reservations-operator`, type `rsv+jwt`, and a `locationIds` claim.
- **Token checks in tenant-api:**
  - token verification and `rsvGuard`
  - the audience added in `org-router`
- **Write path and context:**
  - the `withReservationWrite` gate
  - the reservations context cache
- **Test gates:**
  - the scaffold for a security test that covers every route
  - routing tests
  - the App guards test
- **App access layer:**
  - a Reservations sidebar group and `reservations+/` layout, shown only with
    the flag and a permission
  - every route returns 404 while the flag is off
- **Seed script and docs:**
  - the `seed:reservations` skeleton
  - a draft of ADR 048 and skeletons for the reservations docs

### Milestone 2: Setup (`setup`)

- **Location settings:**
  - booking grid, horizon and daily release time
  - minimum notice and same-day cutoff
  - party limits and large-party mode
  - hold minutes, freeze window, late grace and opt-in auto no-show
  - per-phone limits and the guest modify cutoff
  - toggles for contact and course statuses
- **Dining areas, tables and table combinations.**
- **Full-screen floor plan editor:**
  - edits a draft with an explicit Save; a stale version is reported as a
    conflict
  - grid snap, resize, rotate and arrow-key nudge
  - decor elements
  - in right-to-left layouts, the surrounding interface is mirrored but the room
    geometry is not
- **Services (dining periods),** with weekly templates.
- **Capacity rules:**
  - turn times by party size
  - pacing rules
  - per-service table availability (online, staff only, walk-in only,
    unavailable)
  - special days (closed, online closed, modified, replace)
  - table and area blocks
- **Checks and entry points:**
  - a validation and conflicts view
  - a time-zone mismatch banner with a re-derive action
  - a Reservations card on the location settings page
- A Playwright spec.

### Milestone 3: Reservation book (`reservation-book`)

- **Bookings:**
  - phone and host bookings with automatic table assignment; staff see pacing
    problems as warnings
  - walk-ins seated immediately
- **Screens:**
  - the Today host list: Upcoming, Seated and Finished tabs, counters, and quick
    actions
  - the Book list by date and service, with search and filters
  - a reservation detail sheet (`?r=`)
- **Status changes:**
  - the full status lifecycle, including partial arrival and partial seating
  - undo rules
- **Side fields:** contact statuses, course statuses, running late, occasion,
  and notes.
- **History and conflicts:**
  - change history
  - an unassigned and conflict panel
  - explicit, audited staff overbooking
- **Guest records:** create or look up a guest at booking time.
- **Data safety:**
  - optimistic-version conflicts handled in the UI
  - ETag day feed and a cheap `/changes` poll
  - guest export and erase endpoints (their UI comes in milestone 8)
- **Guards:**
  - the region-switch guard shows counts and requires typed confirmation
  - the location-delete guard
- **Seed data:** `seed:reservations` creates demo bookings.

### Milestone 4: Host stand (`host-stand`)

- **Timeline** (tables × time):
  - drag to move or reassign, with a choice to assign or lock the table
  - resize to change the duration; click an empty cell to book
  - an unassigned lane and a pacing strip
  - soft future bookings are rearranged automatically, and the moves are shown
    to hosts
- **Calendar and overview:**
  - calendar month view
  - service overview (pre-service brief) with service notes
- **Live floor plan:**
  - tables shown by status, with timers
  - drag a party onto a table to seat it, with swap, move or overbook choices
- **Server sections:**
  - section layouts, the tables in each section, and per-service assignment to a
    staff member or a label
- **Refresh and accessibility:**
  - ETag polling: every 5 s on the host stand and floor, every 10 s on the book
    and timeline
  - polling pauses during drags
  - keyboard-accessible drag and drop with spoken announcements
- A Playwright spec.

### Milestone 5: Online booking (`online-booking`)

- **Public `/reservations/*` API:**
  - config, availability with alternatives, and the calendar
  - holds with a countdown, and booking with idempotency keys
  - large-party requests
  - manage: view, modify, cancel, confirm, running late, and an `.ics` file
  - `/mine` for signed-in customers
- **Protection:**
  - the organization is resolved from `Origin`
  - Turnstile (when configured), a honeypot, and in-memory plus durable rate
    limits
  - capability tokens and uniform 404 responses
  - the `RESERVATIONS_PUBLIC_ENABLED` switch returns 503 on every public route
- **Sites pages:**
  - `/reserve` and `/reserve/manage`
  - an "Upcoming reservations" panel on the profile page
- **"Book a table" block:**
  - registered in the App website builder, and hidden unless the online flag is
    on
  - rendered by Sites
- **Languages:** six locales, with Arabic right-to-left.
- **Operator side:**
  - approve and decline large-party requests
  - signed-in customers get prefilled details and their customer link
- **Regions:** tested end to end on a US restaurant (`acme`) and a KSA
  restaurant (`riyadh-grill` on port 3009).
- **Native-ready API shape:** POST-only mutations, `expiresAt` plus the server's
  `now`, and the `X-Client` header recorded.

### Milestone 6: Guest messages (`guest-messages`)

- **Scheduler:**
  - a generic per-organization alarm; staffing becomes one of its modules, and
    staffing's alarm tests stay green
  - the reservations tick: expire holds, payments and requests; opt-in auto
    no-show; deliver messages with retries; deliver the outbox; purge old rows
  - runs from a Node interval, the Workers alarm, and an hourly jobs-cron call
- **Message kinds:** confirmation, modification, guest and restaurant
  cancellation, reminder, reconfirmation request, and request received, approved
  or declined.
- **Channels:**
  - email in English and Arabic (right-to-left), in the organization's branding,
    with manage and calendar links and the operator's custom note
  - SMS in the US only, when the guest opted in; KSA uses email only
  - quiet hours, and deduplication per schedule version
- **Controls:**
  - kill switches `RESERVATIONS_EMAIL_ENABLED` and `RESERVATIONS_SMS_ENABLED`
  - a message settings screen
- **Manager alerts:** from the outbox to App in-app notifications, with optional
  email and per-user preferences.
- **Dev-only email capture**, never active in production:
  - tenant-api writes each full email to a gitignored folder
  - App emails are captured under Workers dev

### Milestone 7: Waitlist (`waitlist`)

- **Operator waitlist:**
  - waitlist settings
  - add a walk-in party and quote a wait using queue simulation
  - notify the guest that the table is ready, by SMS or email
  - a response deadline, after which the entry becomes "no response"
  - "on the way", seat the party on a table, and reorder the queue
- **Guest side:**
  - remote join on Sites (`/reserve/waitlist`)
  - a status page: position, quoted wait, leave, and "on my way"
- **Notify-me:**
  - guests can ask to be notified when no time is available
  - the tick matches and notifies them
- **Also:**
  - waitlist and notify message kinds
  - drag a waitlist card onto the floor plan to seat the party
  - everything is gated by `reservations.waitlist`

### Milestone 8: Guestbook and reports (`guestbook-reports`)

- **Guestbook:**
  - search and list
  - profiles with visit history and stats
  - tags: VIP, dietary/allergy (sensitive), regular, custom, and system tags
    (first visit, frequent no-show)
  - pinned notes
  - merge duplicates
  - export to JSON (sensitive fields excluded unless allowed)
  - erase: anonymize the guest and cancel future bookings with a notification
- **Guest summary** shown in the book and on the host stand.
- **Reports page:**
  - covers and parties by service, source and party size
  - no-shows and cancellations
  - turn times, actual versus configured
  - waitlist, quoted versus actual
  - pacing
  - each report run is audited
- **Generic report subjects** `bookings` and `waitlist_entries` in
  `@repo/reports`, with no contact data.
- **`bookings-today` dashboard block:**
  - fetched in the browser
  - hidden without the flag and the permission
  - refreshes every 60 s

### Milestone 9: Payment mocks (`payment-mocks`)

- **Emulators:** Stripe and Checkout.com behind the real SDKs.
  - Stripe uses `createFetchHttpClient`; Checkout.com is pointed at host
    `https://checkout-com.mock.invalid`.
  - Activated with `MOCKS`/`PAYMENTS_MOCK`, and refuses to run with live keys.
- **Production exclusion in four layers:** a vite define, stripping the routes,
  a `build:cf` flag, and a CI bundle check.
- **State:** stored in `__mock_pay_*` control-plane tables.
- **Mock hosted pages at `/mock-payments/*`:**
  - Stripe Checkout with 3DS
  - Connect onboarding and the Express dashboard
  - the Checkout.com Hosted Payments Page with 3DS
  - the Checkout.com dashboard
  - an event log
- **Behavior:**
  - test-card behavior
  - signed webhooks dispatched in-process: inline, deferred or manual
  - a dev control API at `/mock-payments/dev/*`
  - an instant onboarding helper
- **Stripe coverage:**
  - Connect onboarding, including the `withConnect` error-flattening fix
  - Checkout in payment and setup modes
  - off-session PaymentIntents, refunds and disputes
- **Checkout.com coverage:**
  - sub-entities, with the KSA guard relaxed
  - the Hosted Payments Page: order checkout moves from Flow to HPP, plus a
    status lookup that needs no webhook
  - stored instruments and merchant-initiated charges
  - refunds and amount allocations
- **Also:**
  - Sites accepts `http:` localhost checkout URLs outside production
  - Vitest helpers and Playwright page objects
- **Validation:** checked against existing online ordering payments (a US Stripe
  order and a KSA Checkout.com order).

### Milestone 10: Payments and experiences (`payments-experiences`)

- **Platform fee:**
  - numeric config `reservations.platform_fee_bp` (basis points) in
    `ConfigFlag`: a system default seeded at 0, with optional per-organization
    overrides
  - edited in Admin through a validated Reservations platform fee control
  - applied as the Stripe application fee or the Checkout.com commission
    allocation
  - reversed proportionally on refunds
- **Payment policies:**
  - deposit, prepay and card guarantee
  - late-cancel and no-show fees
  - refund rules and terms versions
  - gated by `reservations.payments` and by what the payment processor supports
- **Deposit or prepay at booking:**
  - the booking waits in `pending_payment` with an extended hold
  - the guest goes from the Sites payment step to the App checkout and the
    hosted page
  - a status lookup or webhook then marks it booked
  - a rule for payments that arrive late, and expiry
- **Card guarantee:** Stripe setup mode, or a Checkout.com stored instrument.
- **No-show and late-cancel fees:**
  - charged by staff, never automatically
  - charged off-session
  - recovery through a pay link when the card needs authentication
  - declines handled
- **Refunds:** by the guest's terms, full when the restaurant cancels, partial
  by an operator, plus a reconcile job.
- **Also:**
  - disputes are reported
  - payment messages
  - payment badges and a payment panel on the host stand
  - the region-switch guard is extended for payments
- **Experiences:**
  - setup with schedules and caps, exclusive windows, ticketed or prix-fixe
    kinds, and publishing
  - public `/experiences` pages on Sites
  - experience availability and booking, with prepayment through the same
    checkout

### Milestone 11: Integrations (`integrations`)

- **Phone agent:**
  - a generic `services.action` in the core package, with no restaurant words
  - a tenant-api voice action registry at `/api/voice/actions/:name`, with
    per-call caps and dry runs for `web_test` calls
  - restaurant tools `check_table_availability` and `book_table`: the default
    holds a slot and texts a confirm link to `/reserve`; an optional
    confirm-on-call mode is for organizations without deposits
  - `record_request` stays as the fallback
  - a settings toggle in the App when `reservations.voice` is on
  - US only
- **Staffing forecast:**
  - a demand-source registry with a `visits` unit; `registerOrderSource` is kept
  - labor standards per unit
  - the forecast strip shows booked covers (counts only)
  - the staffing vocabulary test stays green
- **Journeys:**
  - triggers `reservation_booked`, `reservation_completed`,
    `reservation_no_show` and `reservation_cancelled`
  - offered in the editor only when the flag is on
  - fired after the change commits, only for verified or explicitly consenting
    guests
  - deduplicated per booking and trigger, with ids-only context
  - a consent check added to journey step execution

### Milestone 12: Native apps and final docs (`native-apps`)

- **Server readiness for native apps:**
  - a customer token replaces Turnstile for native clients
  - `X-Client` sets the channel to `native`
  - a payment-status poll
  - contract fixtures recorded from the local tenant-api, plus a tenant-api
    contract test
- **iOS:**
  - TenantKit `ReservationsClient`, models and a `BookingFlow` state machine
  - SwiftUI screens: reservations home, location picker, search with time chips
    and alternatives, details, review with a hold countdown, deposit in the
    system browser with a poll on return, confirmation, and a detail screen with
    modify, cancel and running late, plus waitlist
- **Android:** the same flow in the platform-neutral core and framework views,
  in six locales, with the byte budget measured.
- **Docs completed:**
  - `docs/reservations.md`, `docs/reservations-contract.md`,
    `docs/reservations-plan.md`
  - ADR `048-reservations-data-residency.md`
  - AGENTS.md: a Reservations section and the new env vars
  - the permissions, scheduled jobs, data residency, phone-agent vertical,
    tenant-api README and staffing docs

## 3. Architecture

### Shape of the system

```
 Operator browser (App UI) ----(1) GET token---->  App (US control plane, D1)
        |                                            flags, permissions, location facts,
        | (2) browser-direct, Bearer rsv+jwt         token mint, payment provider calls,
        v                                            manager notifications, Sites gate
 tenant-api (regional: US :3007 / KSA :3009) <---- internal token: context, notify, payments ----> App
   per-org SQLite: every rsv_* table (settings, floor plans,
   guests, bookings, holds, waitlist, messages, payment records)
   regional tick (holds, reminders, waitlist offers, outbox)
        ^                     ^                       ^                    ^
        | public /reservations/* (Origin-bound)        |                    |
 Guest browser on Sites pages / native apps      jobs-cron (hourly)   voice-agent (actions)
        |
        +--> provider hosted page (mock locally) via Sites -> App checkout (opaque ids only)
 Admin: platform fee default and per-org override (control plane)
 @repo/reservations (pure engine, rules, state machine, schemas) is shared by tenant-api, App, Sites
```

### Components and responsibilities

| Component             | Owns                                                                                                                                                                 | Never does                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@repo/zoned-time`    | time-zone math, moved from staffing                                                                                                                                  | anything else                                                                         |
| `@repo/reservations`  | rules, availability engine, assignment, state machine, policy and message math, Zod schemas, flag and permission strings, error codes                                | I/O, UI strings, provider calls                                                       |
| tenant-api (regional) | all reservation data and writes, availability, holds, guest messages, regional tick, voice actions, report records                                                   | read flags or roles for operator routes (it trusts the token), call payment providers |
| App (US)              | flags, permissions, token mint, location facts, Sites gate payload, payment provider calls (mocked locally), manager notifications, region-switch guard, operator UI | read, store or proxy guest data                                                       |
| Sites                 | public pages and blocks in six locales; injects the regional API URL                                                                                                 | fetch or render guest data server-side, proxy bookings                                |
| Admin                 | platform fee default and per-organization overrides                                                                                                                  | anything else for this module                                                         |
| jobs-cron             | hourly `/api/reservations/tick` on every node                                                                                                                        | anything else                                                                         |
| voice-agent           | calls generic voice actions                                                                                                                                          | read guest data back to callers                                                       |
| Native apps           | call the public and customer routes defined in the contract                                                                                                          | anything outside the contract                                                         |

### Data placement

- **Regional (tenant DB, migration `0016` and later additive migrations):**
  - settings, areas, tables, combinations, floor elements, services, turn times,
    pacing, service availability, special days, blocks, policies, sections,
    message texts, experiences
  - guests, tags, notes, merges
  - reservations, table occupancies, holds, events (append-only), service notes
  - waitlist entries and notify-me requests
  - message outbox, payment records (opaque provider references only, never card
    data), outbox to the App, idempotency keys, day versions, rate counters, and
    an append-only audit log
- **Control plane:**
  - permission rows and role grants (migration `0025`)
  - `ConfigFlag` rows for the six flags and `reservations.platform_fee_bp`
  - member location scope, which reuses `UserOrganization.locationScope`
  - website block config
  - manager notifications (ids, kind and counts only)
  - the payment mock state (`__mock_pay_*`, mock mode only)
- **Never in the control plane:** guest names, phones, emails, notes or
  allergies, and anything else tied to a person. Cross-plane payloads carry only
  ids, counts, amounts and non-personal configuration.
- **Region switch:** switching an organization's region wipes its regional data,
  as it does today. The guard shows counts first and refuses while payments are
  unsettled.

### Key mechanisms

- **Flags and permissions:**
  - flags are enforced when the token is minted and in every loader and action
  - the token's `features` claim lets tenant-api refuse child-flag routes
    without reading flags
  - the eight permissions are `read`/`update` on `reservation`,
    `reservation_guest` (sensitive), `reservation_settings` and
    `reservation_report`, plus `update:reservation_payment` (sensitive)
  - an update grant implies the matching read grant
  - impersonation is read-only and gets no sensitive grants
- **Operator token:**
  - scopes `book`, `guests`, `setup`, `reports` and `payments`
  - lifetime 15 minutes, or 5 minutes with sensitive grants
  - a `locationIds` claim limits which locations the operator can reach
- **Write path:** `withReservationWrite` takes a per-organization lock, retries
  when SQLite is busy, and runs one transaction that:
  - sweeps expired holds, payments and offers
  - checks the idempotency key
  - reloads the day state and re-validates with the engine
  - writes rows, events and messages
  - bumps the day version
  - Search is only a hint: the write path decides. The overlap trigger is a
    safety net.
- **Holds and tokens:**
  - holds last 7 minutes by default; a live hold consumes capacity, an expired
    one consumes none
  - manage, hold, payment, waitlist and notify links use HMAC capability tokens,
    stored as hashes
  - manage links travel in the URL fragment
- **Live updates:** ETag polling on the day feed, plus a cheap `/changes` probe.
- **Scheduling:**
  - a generic `lib/org-alarm.ts` (Durable Object alarm on Workers, interval on
    Node) runs the staff and reservations modules
  - expiry is also enforced lazily at read time, so the tick affects timeliness,
    never correctness
- **Messages:**
  - enqueued inside the write transaction
  - immediate kinds are sent after commit; scheduled kinds are sent by the tick
  - at most one message per dedupe key
  - SMS only in the US region
  - kill switches drop messages rather than holding them
- **Payments:**
  - regional tenant-api decides amounts, state and capacity; the App is the only
    component that talks to providers and sees only opaque ids and amounts
  - the flow is quote, then bind once, then status (the ordering pattern)
  - fees are never charged automatically
  - refunds are decided regionally and executed by the App through the outbox
- **Integrations:**
  - a generic voice action registry
  - a demand-source registry for staffing
  - journey triggers emitted after commit with ids-only context
  - report subjects with no contact data
- **Invariants (tested):**
  - no double booking (the engine plus a database trigger)
  - online booking never uses capacity created by a staff overbook
  - holds count while live
  - locked assignments never move automatically
  - a failed modification changes nothing
  - any slot a search returns can be held immediately
  - cancelling or finishing never removes availability
  - history is append-only
  - effects are idempotent
  - the business date plus the local start minute is the source of truth for a
    booking's time

The full architecture, covering data model columns, every route, the App route
map, Sites pages, payment flows and the security gates, will be in the mission's
`architecture.md`.

## 4. Environment setup

- **Branch:** create local branch `pr/reservations` from `main`. Workers commit
  there. Nothing is pushed or deployed.
- **Lockfile:** restore `package-lock.json` to the committed version first. A
  tooling run during planning (19:59 UTC) added an unused
  `@posthog/cli/node_modules/prettier` entry.
- **No new credentials:**
  - payments run in mock mode
  - SMS uses the existing `[SMS MOCK]` log lines, and email uses the dev capture
    added in milestone 6
  - Turnstile stays off locally (empty keys); enforcement is covered by tests
- **Installed toolchains** (each command must export these):
  - `JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64`
  - `ANDROID_SDK_ROOT=ANDROID_HOME=$HOME/android-sdk`
  - add `$HOME/swift/usr/bin` to `PATH`
  - `NODE_OPTIONS=--max-old-space-size=4096` for App typecheck and lint
- **Already prepared:**
  - `apps/admin/.env` (gitignored)
  - the KSA tenant DB directory `packages/database/db/ksa` (gitignored)
  - a script that restores the Linux ESLint native bindings; it must run after
    every `npm install`
- **One-time cold start:** the foundation milestone adds two workspace packages,
  which changes the lockfile, so the next App start takes about 14 minutes.
  After that, workers do not reinstall dependencies unless a feature needs a new
  one.
- **Seeded data:**
  - operator login `kody` / `KodyLovesYou!2026`
  - US organization `acme`
  - KSA organization `riyadh-grill` (published, present in D1 only)
  - each milestone extends `npm run seed:reservations -w tenant-api -- <slug>`
    (local only, idempotent)

## 5. Infrastructure

**Services and ports:**

| Service               | Port                 | Start (from repo)                                                      | Health check                  |
| --------------------- | -------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| App (Workers dev)     | 3001                 | `cd apps/app && VITE_DIRECT_DEV=1 npm run dev`                         | `/resources/healthcheck`      |
| Admin                 | 3005                 | `cd apps/admin && PORT=3005 npm run dev`                               | `/resources/healthcheck`      |
| tenant-api US         | 3007                 | `cd apps/tenant-api && npm run dev`                                    | `/health`                     |
| Sites                 | 3008 (IPv6 loopback) | `cd apps/sites && PUBLIC_APP_URL=http://localhost:3001 npm run dev`    | `Host: acme.menuza.test:3008` |
| tenant-api KSA        | 3009                 | `TENANT_DB_DIR=<repo>/packages/database/db/ksa npm run dev:ksa`        | `/health`                     |
| Playwright App server | 3101                 | `npm run build -w app`, then `PORT=3101 CI=true npx playwright test …` | spec run                      |

- Vite HMR also uses 24678 and 24679.
- Stop a service by killing its process group.

**Databases:**

- local D1 (read by the App)
- `packages/database/db/data.db` (Admin and tests)
- tenant SQLite files: the US directory, and a separate KSA directory

**Boundaries (off-limits):**

- no `git push`, no deploys, and no changes to git identity
- do not touch the `upstream` remote or the `feat/resy-reservation-integration`
  branch
- no real payment, email or SMS providers
- no ports outside the list above
- never run the App typecheck and the App lint at the same time
- never run the App build alongside 3 or more browser sessions

## 6. Testing strategy

- **Test types:**
  - unit and property tests (fast-check) plus DST tests in `@repo/reservations`
  - tenant-db schema and trigger tests
  - tenant-api route and service tests, including concurrency tests on real
    SQLite files (last-table races, idempotent replays, stale versions)
  - abuse tests
  - `reservations-security.test.ts`, which sweeps every operator and public
    route: missing, forged, wrong-audience, grantless, wrong-scope,
    cross-organization and cross-location tokens
  - App tests: guard tests (every reservations loader and action awaits
    `requireReservationsAccess` first), view, utility and component tests
  - Sites vitest tests for client modules and label completeness
  - App Playwright e2e specs per App-facing milestone, with tenant-api stubbed
  - payment emulator tests
  - native unit and contract tests
- **Workers follow TDD:** write a failing test first for new behavior.
- **Milestone gate** (run by scrutiny, about 15 to 17 minutes when warm, in this
  order):
  1. typecheck of all touched workspaces with `--concurrency=2` and a 4 GB heap
     (including the new packages)
  2. oxlint
  3. ESLint for Sites, Admin and marketing-workflow
  4. App ESLint, with no new errors beyond the 59 pre-existing errors in the
     menu files
  5. the small test suites
  6. tenant-api tests
  7. App tests, run alone
  8. Android tests, build and size check, then iOS `swift build` and
     `swift test`
  9. `lingui:check`
- **Worker scoping:**
  - typecheck and lint the packages you changed
  - run targeted Vitest files for the area you changed
  - run the App typecheck only when App files changed, and never together with
    the App lint
  - run the relevant Playwright spec for App UI features
  - run Android and iOS commands only for native changes
  - restore the regenerated `packages/reports/src/env.ts` and
    `packages/security/src/env.ts`, and never commit them

## 7. User testing strategy

- **Surfaces and tools:**
  - **App operator screens:** agent-browser on port 3001, as kody, on `acme`
    (US) and `riyadh-grill` (KSA).
  - **Guest website:** agent-browser on port 3008, with `acme` in English and
    `riyadh-grill` in Arabic (right-to-left, KSA node). Organizations without a
    hosts entry need the resolver rule `MAP *.menuza.test [::1]`.
  - **Admin:** agent-browser on port 3005, only for the platform fee. Admin
    writes `data.db` while the App reads D1, so validators save the fee in Admin
    and then copy the value into D1 before checking amounts. In production both
    read the same database.
  - **tenant-api:** curl on ports 3007 and 3009, for public rules, refused
    tokens, rate limits, manage links, the tick and phone-agent actions.
  - **Messages:** SMS from the `[SMS MOCK]` log lines; email from the dev
    capture folder.
  - **Payments:** the mock hosted pages, with test cards including 3DS.
  - **Native apps:** Gradle and Swift commands only. The user checks the screens
    on devices.
- **Org flags:** validators set them in local D1 with
  `wrangler d1 execute DB --local`.
- **Admin login:** needs the kody session row copied into `data.db`.
- **Concurrency limits (4 CPUs, 8 GB RAM):**
  - with all five services up, about 2.6 GB is free
  - at most 3 browser validators at once, or 2 while a build, typecheck, lint or
    Playwright run is in progress
  - up to 4 curl validators
  - native builds one at a time, with browser sessions closed
  - Admin is started only when its checks need it

## 8. Mission readiness (verified)

- **Builds and checks:**
  - `npm install` works, with the Linux ESLint bindings script
  - fast-check 4.9 is available
  - control-plane migrations are applied (`0024`) in `data.db` and local D1
  - typecheck passes on 12 workspaces with a 4 GB heap
  - oxlint and the small ESLint suites pass
  - App ESLint has a known baseline of 59 pre-existing errors
- **Unit tests pass**, with no pre-existing failures:
  - tenant-api: 1,526 tests
  - App: 2,499 tests (454 s)
  - plus the small suites
- **Native:**
  - Android: 77 tests pass; the APK is 88,676 of 160,000 bytes and the AAB is
    145,554 of 220,000 bytes
  - iOS: `swift build` and `swift test` pass, 72 tests
- **Services:**
  - all services start and pass health checks
  - agent-browser drove the operator login and Staff screens, guest OTP sign-in
    on `acme`, and a KSA organization end to end (provision, publish, site, OTP
    on 3009)
  - the Playwright staff-roster spec passes in CI mode on port 3101
  - `lingui:check` passes
- **Fixes applied during readiness:**
  - repaired stale staffing tables in acme's tenant DB (backup kept)
  - gave the KSA node its own tenant DB directory
  - set `VITE_DIRECT_DEV=1` for App HMR
- **Known gaps closed by features:** full email capture (milestone 6) and the
  payment emulators (milestone 9).

## 9. Non-functional requirements

- **Residency and privacy:**
  - guest PII stays in the regional database
  - no PII in logs, cross-plane payloads, Sites SSR, App loaders or dashboards'
    server loaders
  - validation errors never echo rejected values
  - capability tokens are stored only as hashes
- **Security:**
  - fail closed with uniform 404s
  - durable rate limits
  - optimistic version checks on every operator mutation
  - the security sweep test and the App guards test are required for every new
    route
- **Correctness under concurrency:**
  - one writer per organization
  - idempotent creates, and messages and payments sent at most once per key
  - no double booking, even when requests race
- **Performance:**
  - engine budgets: search 200 expansions per slot, book 2,000, reflow 5,000
  - property tests at 120 tables, 80 combinations and 900 bookings per day
  - polling uses ETags
- **Accessibility and i18n:**
  - keyboard drag and drop with announcements
  - Lingui everywhere, with Arabic translations in the App
  - six Sites locales with non-empty translations
  - right-to-left layouts mirror the interface, but not floor geometry or
    numbers
- **Design system:** `@repo/ui` primitives and theme tokens; no new App ESLint
  errors.
- **Operational:**
  - kill switches and the runbook documented
  - deploy tenant-api first
  - the Android byte budget is enforced, and any raise records its reason
