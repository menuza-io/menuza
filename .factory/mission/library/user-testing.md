# User testing

How validators exercise the Reservations module through its real surfaces:
tools, bootstrap steps, prerequisites, isolation and concurrency limits.

**What belongs here:** testing surfaces and tools, login/bootstrap recipes, how
to read mock messages, data isolation advice, validation prerequisites,
concurrency limits, runtime findings from validators (append them under "Runtime
findings"). **What does NOT belong here:** service commands and ports (use
`services.yaml`), environment facts (use `environment.md`), design (use
`architecture.md`).

---

## Validation Surface

All five web services must be up for most flows: `tenant-api-us` (3007),
`tenant-api-ksa` (3009), `app` (3001), `sites` (3008). Start `admin` (3005) only
for the platform-fee checks. Use the `services.yaml` start/healthcheck/stop
commands; service logs are appended to `/tmp/menuza-logs/<service>.log`.

### 1. Operator App (agent-browser, http://localhost:3001)

- Tool: `agent-browser` (mandatory for web UI). Give every validator its own
  `--session <name>`.
- Login: open `http://localhost:3001/login`, fill "Email or Username" with
  `kody`, click **Continue**, fill "Password" with `KodyLovesYou!2026`, click
  **Sign In**. You land on `/acme`. A first-visit cookie banner (Accept/Reject)
  does not block the form.
- Organizations: `acme` (US, tenant-api 3007) and `riyadh-grill` (KSA,
  tenant-api 3009). kody is admin in both. Switch with the org switcher or by
  URL (`/riyadh-grill/...`).
- Reservations screens live under `/<org>/reservations/...` (route map in
  `architecture.md`). Everything returns 404 and the sidebar group is hidden
  until `reservations.enabled` is on for the org and the user has a reservations
  permission.
- Arabic and right-to-left: append `?lng=ar` (App). Check that the interface
  mirrors while floor-plan geometry, times and numbers do not.
- The operator UI calls tenant-api directly from the browser with a short-lived
  `rsv+jwt` Bearer token. To inspect those calls, use agent-browser's network
  capture; requests go to `http://localhost:3007/operator/reservations/...`
  (acme) or `http://localhost:3009/...` (riyadh-grill). CORS preflights
  return 204.
- Switching users: logout lands on `/_.data` (known repo issue). Use a new
  agent-browser session and open `/login` directly.
- Restricted operator accounts (Host preset, read-only viewer, single-location
  member): create a custom role (or use the Host preset) under
  `/acme/settings/roles`, invite a new member email under
  `/acme/settings/members`, and read the invite link or verification code from
  local D1
  (`npx wrangler d1 execute DB --local --command "SELECT target, code FROM Verification ORDER BY createdAt DESC LIMIT 5"`
  from `apps/app`), then complete signup in a fresh
  `agent-browser --session <role>` session.
- Dev-server quirks: the first load of a route can take 30-66 s (on-demand
  compile). A page that shows "Invalid hook call" or has no interactive elements
  was loaded during dependency re-optimization: reload it.

### 2. Guest website, Sites (agent-browser, port 3008)

- acme: `http://acme.menuza.test:3008/` (in `/etc/hosts`). Other orgs, including
  `riyadh-grill`, need the resolver rule, given when the session's browser
  launches:
  `agent-browser --session <name> --args "--host-resolver-rules=MAP *.menuza.test [::1]" open http://riyadh-grill.menuza.test:3008/`
  The rule must map to `[::1]`; `127.0.0.1` is refused. `--args` only applies at
  launch, so close a running session first. `*.localhost` hosts return 404.
- curl: `curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/<path>`.
- The page exposes the regional API as
  `document.documentElement.dataset.tenantApiUrl` (`http://localhost:3007` for
  acme, `http://localhost:3009` for riyadh-grill). Guest browsers call
  tenant-api `/reservations/*` directly; Sites SSR never renders guest data.
- Guest sign-in (phone OTP): click "Sign in", enter a phone (acme:
  `+15555550123`; riyadh-grill: `+966500000123`, or a fresh test number), click
  **Send Code**, read the code from the tenant-api log (below), enter it under
  "Verification Code", click **Verify**. Tokens live in `localStorage`.
- Locales: Sites supports en, ar, es, fr, de and zh (see `sites-patterns.md` for
  how a locale is selected). Validate acme in English and riyadh-grill in Arabic
  (right-to-left).
- Turnstile is disabled locally (empty keys); do not expect a widget. The
  honeypot is still active.

### 3. Admin (agent-browser, http://localhost:3005) — platform fee only

- Start Admin only for these checks, and stop it afterwards (it costs 0.6-1.4
  GB).
- Login: log in to the App as kody in the same agent-browser session, run
  `commands.copy_admin_session`, then open `http://localhost:3005/`. Admin has
  no `/login` route.
- Admin reads and writes flags in `data.db`, while App dev reads local D1. After
  saving the platform fee in Admin, read the saved value from `data.db`
  (`sqlite3 /home/factory-user/repos/menuza/packages/database/db/data.db "select key, level, organizationId, value from ConfigFlag where key='reservations.platform_fee_bp'"`)
  and mirror it into D1 before checking amounts in the App:
  `commands.set_org_flag acme reservations.platform_fee_bp <value>` for an org
  override; for the system default, update the `level='system'` row in D1 with
  `npx wrangler d1 execute DB --local --command "<sql>"` from `apps/app`. In
  production both apps use the same D1, so this copy step is a local artifact,
  not a product defect.
- `riyadh-grill` exists only in D1, so Admin does not list it. Platform-fee
  checks for KSA use the D1 override directly.

### 4. tenant-api (curl, ports 3007 and 3009)

- Health: `curl -sf http://localhost:3007/health` returns
  `{"status":"ok","region":"us"}`; 3009 returns region `ksa`.
- Public routes `/reservations/*` resolve the org from the `Origin` header. Send
  the Sites origin, for example `-H 'Origin: http://acme.menuza.test:3008'`
  (riyadh-grill: `http://riyadh-grill.menuza.test:3008`, on port 3009). A
  request with no or an unknown Origin must get the uniform 404.
- Mutations are POST-only. Send `Content-Type: application/json` and, where
  required, an `Idempotency-Key` header (see `architecture.md` for each route).
- Operator routes `/operator/reservations/*` need a Bearer `rsv+jwt` token
  minted by the App. Get a real one by logging in with agent-browser, opening a
  reservations page, and reading the `Authorization` header of a captured
  request to tenant-api (or calling the App token route from inside the page
  with `agent-browser eval`). Tokens last 15 minutes (5 with sensitive grants).
  Never paste tokens into handoffs or reports.
- Refused-token checks: no header; a garbage token; a real token with one
  signature character changed; a staffing operator token (wrong audience); a
  riyadh-grill token sent to acme's node or org (cross-organization); a token
  whose `locationIds` exclude the target location (cross-location). Each must be
  refused without leaking data. The exhaustive matrix is covered by
  `apps/tenant-api/src/routes/reservations-security.test.ts`; curl checks
  confirm it on the running server.
- Rate limits: loop requests and confirm 429s at the configured limits
  (`architecture.md`). Durable limits survive a tenant-api restart.
- Kill switch `RESERVATIONS_PUBLIC_ENABLED=false`: restart the node with the
  variable set, confirm 503 on public routes, then restart it normally.
- The tick: `POST /api/reservations/tick` with the internal command token (see
  `architecture.md` for the auth header). Validators may also wait for the Node
  interval tick.

### 5. Messages (mock transports only)

- **SMS** (US node only): `[SMS MOCK] To: <phone> | Message: <text>` lines in
  `/tmp/menuza-logs/tenant-api-us.log`. Latest OTP for a number:
  `commands.read_sms_code` (edit the number). KSA sends no reservation SMS
  (email only); KSA OTP codes are in `tenant-api-ksa.log`.
- **Email:** from milestone `guest-messages` on, the dev email capture keeps
  every email in full (`architecture.md` section 9.6). Before that milestone,
  tenant-api only logs `[OCI EMAIL MOCK] To: … | Subject: …`, and App email
  under Workers dev fails against the real Resend API.
  - **Guest emails (tenant-api):** one JSON file per email in
    `/home/factory-user/repos/menuza/apps/tenant-api/.dev-mail/us/` (US node) or
    `.../.dev-mail/ksa/` (KSA node), named `<YYYYMMDDTHHmmssSSS>-<uuid>.json`.
    Record fields: `id`, `capturedAt`, `source`, `region`, `to`, `from`,
    `subject`, `html`, `text`, `meta` (`orgId`, `messageKind`, `messageId`; ids
    only). Newest first: `commands.list_dev_emails_us` / `list_dev_emails_ksa`;
    for one recipient: `grep -l '<email>' <dir>/*.json | xargs ls -t | head -1`.
    The node logs `DEV EMAIL CAPTURE ACTIVE -> <dir>` at boot; if that line is
    missing, the node was not started through `services.yaml`.
  - **Manager-alert emails (App, Workers dev):** viewer at
    `http://localhost:3001/mock-email`; JSON at
    `http://localhost:3001/mock-email/dev/messages?to=<email>&since=<ISO>`;
    clear with `POST /mock-email/dev/reset` (affects every validator; avoid
    while others read it).
  - The capture never sends anything; it is inactive in production builds.
- Follow manage and calendar links from captured emails in agent-browser to
  prove they work. Manage links carry their capability token in the URL
  fragment.

### 6. Payments (mock providers, from milestone `payment-mocks` on)

- Real Stripe and Checkout.com SDKs talk to in-process emulators served by the
  App. Hosted pages live under `http://localhost:3001/mock-payments/*` (Stripe
  Checkout with 3DS, Connect onboarding and Express dashboard, Checkout.com
  Hosted Payments Page with 3DS, Checkout.com dashboard, event log). The dev
  control API is under `/mock-payments/dev/*`. Details, test cards and webhook
  modes: `payment-mocks.md`.
- US flows use acme (Stripe Connect); KSA flows use riyadh-grill (Checkout.com
  sub-entity). Use the onboarding helper to make an org's connected account
  ready instantly.
- Regression targets: an existing online-ordering payment on acme (Stripe) and
  on riyadh-grill (Checkout.com HPP).

### 7. Native apps (commands only)

- Android: `commands.android_test`, `android_build`, `android_size` (byte
  budget), then `android_stop_gradle`. iOS: `commands.ios_build`, `ios_test`
  (TenantKit on Linux; SwiftUI views are not compiled on Linux).
- There is no emulator or simulator. The user checks screens on devices;
  validators do not.
- Contract fixtures are recorded from the local tenant-api; the tenant-api
  contract test keeps them honest.

### 8. Phone agent (tool tests and API calls only)

- No live calls. Validate with the `@repo/phone-agent-restaurant` / voice-agent
  tool tests and with curl against `POST /api/voice/actions/:name` on tenant-api
  using the voice agent token (see `architecture.md` for headers and the dry-run
  behavior of `web_test` calls).

## Validation Prerequisites

| Prerequisite                                                   | How it was verified during readiness                                                                    | Allowlist needed |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| tenant-api US healthy on 3007                                  | `/health` 200 about 6 s after start                                                                     | No               |
| tenant-api KSA healthy on 3009 with `TENANT_DB_DIR=.../db/ksa` | provision, OTP send/verify for riyadh-grill succeeded after the directory fix                           | No               |
| App dev on 3001 (`VITE_DIRECT_DEV=1`), warm                    | kody login, Staff pages, browser-direct tenant-api calls 200, CORS 204                                  | No               |
| Sites on 3008 (`[::1]`)                                        | acme home and OTP sign-in end to end; riyadh-grill site via resolver rule, `data-tenant-api-url` = 3009 | No               |
| Admin on 3005 + copied session                                 | `/feature-flags` reachable as kody after the session copy                                               | No               |
| agent-browser                                                  | drove operator login, Staff screens, guest OTP sign-in, KSA org setup                                   | No               |
| Playwright (workers' e2e specs)                                | `staff-roster.test.ts` 4/4 passed in CI mode on 3101 after a 110 s App build                            | No               |
| Seeded operator and orgs                                       | kody / acme / riyadh-grill present (riyadh-grill in D1 only)                                            | No               |
| Reservations flags per org                                     | set with `commands.set_org_flag <org> reservations.enabled true` (and child flags) before UI checks     | No               |
| Reservations demo data                                         | `commands.seed_reservations_acme` / `seed_reservations_ksa` (extended by each milestone)                | No               |
| Android/iOS toolchains                                         | 77/77 Android tests, release build within budget; 72/72 Swift tests                                     | No               |
| Mock SMS/email                                                 | SMS log lines verified; full email capture arrives in milestone `guest-messages`                        | No               |

No external allowlisting was required. No real credentials are used.

## Data isolation between concurrent validators

- All validators share the same orgs and tenant DBs. Partition by data, not by
  database:
  - give each validator its own guest phone numbers and emails (for example
    `+1555555<validator-number><nn>` and `rsv-<validator>-<n>@example.com`),
    party names, and booking dates (a distinct future date per validator where
    the flow allows it);
  - do not change shared org settings (services, turn times, pacing, flags,
    payment policies) while another validator depends on them. Group
    settings-changing assertions into one validator, or run them serially at the
    end;
  - region switches, kill switches and node restarts affect everyone: run those
    flows alone.
- The per-org write lock serializes concurrent writes; contention shows up as
  latency, not errors.
- Clean up is not required, but never delete seeded orgs, users or tenant DB
  files.

## Validation Concurrency

Machine: 4 CPUs, 7.9 GB RAM. Measured with all five services up: about 5.0-5.4
GB used, about 2.6 GB available (service RSS: vite 1.3-1.5 GB, workerd 0.7-1.1
GB with a 1.9 GB warm-up peak, Admin 0.6-0.9 GB plus a 0.75 GB esbuild, astro
0.75-0.8 GB, each tenant-api 0.12-0.19 GB). An App operator browser session
costs 450-530 MB; a Sites guest session 100-150 MB. 70% of 2.6 GB is 1.8 GB,
which fits 4 App sessions by memory, but CPU is the tighter limit: two
simultaneous reloads already reached about 80% CPU and first route loads take
30-66 s.

| Surface                                                                            | Max concurrent validators           | Rationale                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| agent-browser (App, Sites, Admin)                                                  | **3**                               | Memory fits 4; CPU limits to 3 with all services up.                               |
| agent-browser while an App build, typecheck, lint or Playwright run is in progress | **2**                               | An App build with services up drove available memory to 800 MB and swap to 3.4 GB. |
| agent-browser with Admin stopped and nothing heavy running                         | up to 4                             | Admin frees 0.6-1.4 GB. Use only when clearly idle.                                |
| curl (tenant-api)                                                                  | **4**                               | Each curl validator is negligible; the tenant-api nodes are light.                 |
| Native builds/tests                                                                | **1**, with browser sessions closed | Gradle daemon about 2 GB; stop it afterwards.                                      |

- Never run the App build or the App typecheck alongside 3 or more browser
  sessions.
- Close every agent-browser session you open
  (`agent-browser --session <name> close`) and stop services you started.

## Flow Validator Guidance: terminal

Surface: repository test suites (Vitest), read-only `sqlite3` queries and file
inspection. No browser, no service start/stop.

Isolation rules:

- Stay inside your assigned group's assertions and commands. Do not run the full
  milestone gate (`services.yaml` `commands.test`), a whole-App test suite,
  typecheck, lint or the App build.
- Concurrency (this round): at most **2 terminal validators** run at once; a
  browser validator may also be running. A property/scale suite is the heaviest
  thing in the mission; do not start a second suite of your own while one is
  running.
- Never write to a database from a shell command. `sqlite3` and
  `wrangler d1 execute … --command "SELECT …"` are read-only; the only writer
  allowed is `seed:reservations`, and only in the validator it is assigned to.
- Never modify product code, tests or configuration to make an assertion pass.
  Do not run `git checkout`, `git stash`, `git commit`, `git reset`, `git clean`
  or `git restore`; other validators share this working tree. If a
  Vitest/typecheck run regenerates `src/env.ts` formatting noise, leave it and
  report it.
- Never print a secret (token, key, session) into your report or evidence. Refer
  to it as `$INTERNAL_COMMAND_TOKEN` or `<internal-token>`.
- Vitest needs `CI=true`: `CI=true npx vitest run <paths>` inside a workspace,
  or `CI=true npm run test -w <workspace>` from the repo root.
- Record each exact command with its exit code and the observed test
  counts/lines in your report. Save trimmed raw output under your evidence
  directory.

## Flow Validator Guidance: agent-browser (App operator UI)

- Use exactly one browser session for this surface:
  `--session 4624c47a301b__appui`. Close it when you are done
  (`agent-browser --session "4624c47a301b__appui" close`).
- App: `http://localhost:3001`. Login per section 1 above (`kody` /
  `KodyLovesYou!2026`); open `/login` directly, never log out to switch users.
- **Flags are shared state and this surface owns them for this round.** Only
  this validator may change `reservations.*` flags. Use
  `bash /home/factory-user/.factory/missions/165ab51b-48a5-4632-8938-101be7ea8500/scripts/set-org-flag.sh <org-slug> <key> <value>`
  (writes local D1 and `data.db`).
  - Start from `reservations.enabled = false` for `acme` (VAL-FND-021), then set
    `reservations.enabled = true` for `acme` and `riyadh-grill`, and leave both
    `true` when you finish (later milestones need it on).
  - No cache flush is needed: the flag is read from D1 per request. Reload once
    if the sidebar still shows the old state.
- Concurrency: at most **1 App browser session** while test suites run this
  round. Do not start or stop services; App (3001), tenant-api US (3007) and KSA
  (3009) are already up.
- The first load of a route can take 30-66 s (on-demand Vite compile). A page
  with no interactive elements or an "Invalid hook call" error was loaded
  mid-optimization: reload it. Never wait for network idle (the notifications
  SSE stream stays open).
- For status-code checks, read the document response status from the browser
  session's network capture (React Router single fetch also produces
  `<path>.data` requests; judge the document request). A redirect to a `.data`
  URL returns 202 with the redirect in the body, so confirm document
  navigations, not `.data` XHRs.
- Screenshots and accessibility snapshots go under your evidence directory,
  named after the assertion id.

## Flow Validator Guidance: curl (App internal routes, tenant-api)

- Reachable ports: App `http://localhost:3001`, tenant-api US
  `http://localhost:3007`, KSA `http://localhost:3009`. Start nothing.
- Read `INTERNAL_COMMAND_TOKEN` from `apps/app/.env` (or `apps/app/.dev.vars`)
  into a shell variable, use it in the request header, and never echo it or
  write it into evidence: redact as `<internal-token>`.
- Always send the negative case first (no token / wrong token), then the
  authenticated case. Capture headers with `curl -si` when the assertion
  mentions `Cache-Control` or response shape.
- Do not restart nodes or change flags; the browser validator owns flags this
  round.

## Concurrency plan (round 1, user-testing-validator-foundation)

| Surface                  | Max concurrent | Plan                                                         |
| ------------------------ | -------------- | ------------------------------------------------------------ |
| agent-browser (App)      | 1              | one serial flag/nav/token group (VAL-FND-015, 016, 021, 022) |
| terminal (Vitest/sqlite) | 2              | batches, see below                                           |
| curl                     | 1              | VAL-FND-018 (+ the security sweep in the same group)         |

Batches used in round 1: (1) domain packages + tenant-db schema + App browser;
(2) engine/property/scale + context/guards; (3) state/routing/write +
control-plane/seed/docs.

## Runtime findings

Validators append dated findings here (setup fixes, flaky surfaces, isolation
lessons).

- 2026-10-16 (setup, round 1): App dev on 3001 started with
  `VITE_DIRECT_DEV=1 npm run dev` from `apps/app`; healthy in ~30 s. tenant-api
  US/KSA were already running from a prior session (PIDs 689586/689587) and were
  left running. Sites (3008) and Admin (3005) are not needed for the
  `foundation` assertions and were left stopped.
- 2026-10-16 (setup, round 1): local D1 and `data.db` already had the 8
  reservation permissions (admin granted 8, member 0) and the 6 system flag rows
  with `value='false'` from migration `0025`. Both orgs had `reservations.*` org
  overrides set to `true` by an earlier validator; the browser group resets
  `reservations.enabled` to `false` for the off-state check and restores `true`.
- 2026-10-16 (round 1, g6): **after flipping `reservations.enabled`, wait ~35 s
  before reloading.** The sidebar nav access is cached by the root loader
  (`reservations-nav:<orgId>:<userId>`, cachified, 30 s TTL,
  `apps/app/app/root.tsx`), so a plain reload right after `set-org-flag.sh`
  still shows the old nav. Route-level behaviour is not cached:
  `/acme/reservations*` 404s and redirects follow the flag immediately.
- 2026-10-16 (round 1, g6): `agent-browser screenshot` with a **relative** path
  writes into the browser session's working directory (the repo root), not the
  shell's cwd. Always pass an absolute path under
  `evidence/<milestone>/<group>/`. Also the sidebar "Reservations" group button
  can be covered by an `aside.bg-background` overlay for agent-browser's ref
  click; an in-page `document.querySelector(...).click()` works.
- 2026-10-16 (round 1, g5): `seed:reservations` prints "Provisioning tenant DB …
  Successfully provisioned" on **every** run, even when no migration is pending
  — there is no "no pending migrations" line. Confirm migration state by
  comparing `__drizzle_migrations` in the tenant DB with
  `packages/tenant-db/drizzle/meta/_journal.json`.
- 2026-10-16 (round 1, g4): the generated migration writes CHECK constraints as
  `CHECK(((` with no space; grep case-insensitively (`grep -i check`) rather
  than `grep "CHECK ("`.
- 2026-10-16 (round 1, g1/g2/g3): contract-vs-code vocabulary notes for future
  rounds — token-claims and TTL tests live in
  `packages/reservations/src/permissions.test.ts` (no `token.test.ts`);
  `resolveServices` returns a `ResolvedDayServices` object (services +
  closed/onlineClosed/specialDay), not a bare array;
  `apps/tenant-api/src/routes/auth.ts` imports the alias `normalizePhone` from
  `src/lib/phone.ts`, which re-exports `normalizeGuestPhone`; passing property
  runs print no seeds or counters (export `FC_SEED=<n>` to reproduce).
- 2026-10-16 (round 1, g2): engine mode gating **is** implemented —
  `isModeAllowedForChannel`
  (`packages/reservations/src/engine/day-state.ts:130-146`, applied at `:290`
  and `:322`) excludes `unavailable` everywhere and restricts
  `staff_only`/`walk_in_only` by channel. Do not re-report those as missing; a
  g2 flow report did, and it was corrected during synthesis.
- 2026-10-16 (round 1, g7): tenant-api's per-org context cache eviction is not
  directly observable over HTTP (identical payloads by design). Prove it with
  the fetch-spy tests in `src/lib/reservations-context.test.ts` /
  `src/routes/reservations-security.test.ts`
  (`POST /internal/reservations/context-changed` → fetch count 1→1→2); live
  response timing (ms) is corroboration only.
- 2026-10-16 (round 1, g5/g4): the local **KSA** tenant DB
  (`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`) still carries
  pre-fix trigger bodies (`RAISE(ABORT,'table_overlap')` with no
  `o.overbook = 0` filter, and `rsv_holds_single_conversion` requiring
  `OLD.status='converted' AND NEW.status='converted'`), while the US-dir DBs
  carry the corrected SQL. This is the known scrutiny round-2 item folded into
  `foh-setup-full-stack` (data-only trigger refresh); VAL-FND-011/012 build a
  fresh temp DB from the migration and are unaffected.
- 2026-10-17 (messages-and-waitlist-ui worker): the public Sites availability
  endpoint rate-limits at ~30 requests/min per client ("Too many attempts"). Do
  not scan days in a tight loop. To force a full day for notify-me / waitlist
  checks, insert a temporary `rsv_pacing_rules` row (max_covers=1) in the acme
  tenant DB and delete it afterwards. Floor-plan drag checks: dispatch synthetic
  dragstart/dragenter/dragover/drop/dragend with a DataTransfer (see
  `apps/app/tests/e2e/reservations-waitlist-messages.test.ts`).
- 2026-10-17 (guestbook-and-reports worker): restricted-grant gating (host
  without guest/report grants: no Reports link, no guest profile link, 403 from
  tenant-api) was only covered by unit/security tests. Validators of
  VAL-GUEST/VAL-REPORT gating assertions must exercise it in a separate browser
  context with a restricted operator account.

---

# Round: foh-core user testing (Setup, Reservation book, Host stand)

This block is the round-2 guidance for `user-testing-validator-foh-core`. It
supersedes the round-1 concurrency plan below it. Everything above still applies
(surfaces, login recipes, mock transports, data isolation).

## Environment state at the start of this round (verified by the validator)

- Services: `tenant-api-us` 3007, `tenant-api-ksa` 3009, `app` 3001 and `sites`
  3008 were started through `services.yaml` and pass their healthchecks. `admin`
  3005 was not started.
- `seed_reservations_acme` and `seed_reservations_ksa` have run. Seeded acme
  fixtures (location `v17plv08r5v357bie335lyq8`, tz `America/New_York`): 3 areas
  (`Main Dining Room` M1-M6, `Garden Terrace` T1-T4, `Chef Counter & Lounge`
  C1-C2), 12 tables, 2 combos, 3 services (`Lunch` Mon-Sat 12:00-14:30, `Dinner`
  all days 17:30-22:00, `Weekend Brunch` Sun+Mon 10:00-14:15), 4 turn-time
  brackets, 8 guests, 7 reservations on **2026-10-16** (today), 2 waitlist
  entries.
- Seeded acme location settings at round start: `day_start_min 240`,
  `interval_min 15`, `horizon_days 60`, `min_notice_min 30`,
  `same_day_cutoff_min null`, `online_party_min 1`, `online_party_max 8`,
  `party_max 20`, `large_party_mode contact`, `hold_minutes 7`, `freeze_min 30`,
  `auto_no_show_after_min null`, `max_active_per_phone 3`,
  `guest_modify_cutoff_min 120`,
  `contact_statuses_enabled`/`course_statuses_enabled` per row, `version 6`,
  `floor_plan_version 4`. Read the live values; do not assume.
- Org flags are ON for both orgs (the six contract keys plus extra keys earlier
  sessions set). Do not delete them.

## Minting operator tokens without the browser (`curl`/`terminal` groups)

`library/user-testing.md` §4 describes minting through the App. A faster
equivalent that signs with the same `TENANT_OPERATOR_TOKEN` from
`apps/app/.dev.vars` is installed at `/tmp/menuza-user-testing/mint-token.mjs`:

```bash
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope setup)
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book --grants read:reservation:any)   # read-only book
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org riyadh-grill --scope setup)                       # ksa token
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book --locations v17plv08r5v357bie335lyq8)
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book --impersonated)
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book --ttl 3600)   # over-long TTL, must be refused
TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book --secret wrong-secret-value)
```

Verified at round start: `--scope setup` →
`GET .../setup/locations/<id>/settings` 200; no token → 401; a setup token
narrowed to `read:reservation_settings:any` → `PUT .../settings` 403
`insufficient_permissions`. Never write a token value into a report or evidence
file; describe it (`<setup token, read-only>`).

## Data isolation registry for this round

Each group owns these resources; do not use another group's date, phone or email
prefix.

| Group | Surface      | Owned future business date(s)   | Owned US phone prefix / email prefix       |
| ----- | ------------ | ------------------------------- | ------------------------------------------ |
| g1    | terminal     | —                               | —                                          |
| g2    | curl         | 2026-10-19                      | `+15555550 2xx` / `rsv-g2-<n>@example.com` |
| g3    | browser      | —                               | —                                          |
| g4    | browser      | 2026-10-30                      | `+155555504xx` / `rsv-g4-<n>@example.com`  |
| g5    | browser      | 2026-11-02 … 2026-11-05         | `+155555505xx` / `rsv-g5-<n>@example.com`  |
| g6    | curl         | 2026-10-20                      | `+15555550 6xx` / `rsv-g6-<n>@example.com` |
| g7    | terminal     | —                               | —                                          |
| g8    | browser      | 2026-10-21                      | `+155555508xx` / `rsv-g8-<n>@example.com`  |
| g9    | browser      | 2026-10-22 + today (2026-10-16) | `+155555509xx` / `rsv-g9-<n>@example.com`  |
| g10   | browser      | 2026-10-23                      | `+155555510xx` / `rsv-g10-<n>@example.com` |
| g11   | curl/sqlite  | 2026-10-24                      | `+155555511xx` / `rsv-g11-<n>@example.com` |
| g12   | browser      | 2026-10-25 + today              | `+155555512xx` / `rsv-g12-<n>@example.com` |
| g13   | browser      | 2026-10-26                      | `+155555513xx` / `rsv-g13-<n>@example.com` |
| g14   | browser/curl | 2026-10-27                      | `+155555514xx` / `rsv-g14-<n>@example.com` |
| g15   | curl         | 2026-10-27                      | `+155555515xx` / `rsv-g15-<n>@example.com` |
| g16   | browser      | 2026-10-28                      | `+155555516xx` / `rsv-g16-<n>@example.com` |
| g17   | browser      | —                               | —                                          |

KSA groups: use `+966551 2xx` style numbers and `rsv-g<group>-<n>@example.com`.
KSA location id `oi97w1dxwcpnkpq9m9s8cnu8`, tenant DB
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`.

## Setup-mutation isolation rules (read before touching `/operator/reservations/setup/*`)

Setup rows are shared state for every other group's book/host flows. Rules:

- **Add, don't rewrite.** Create new areas/tables/combos/services/combos with
  labels prefixed by your group id (for example `G5-Area`, `G5-S1`). Do not
  rename, re-point, archive or resize seeded rows (`area_acme_main`,
  `tbl_acme_*`, `svc_acme_lunch|dinner|brunch`) except where your assertion
  explicitly requires modifying an existing table (for example
  `VAL-SETUP-013/014` table geometry, which must be saved back to the same
  coordinates afterwards).
- **Location settings:** read the live row first, change only the fields your
  assertion needs, and restore the original values before your session ends
  (VAL-SETUP-003/004/005/006 ask for persistence — verify the round-trip, then
  restore).
- **Special days / blocks / pacing / service-availability:** confine them to the
  dates in your registry row so no other group's date is affected.
- **Services:** if your assertion needs a new service, create it for your owned
  date range only (`effective_from`/`effective_to`) so other dates keep the
  seeded Lunch/Dinner/Brunch.
- **Never** delete or alter the seeded 7 reservations on 2026-10-16.

## Flow Validator Guidance: terminal (foh-core)

(Extends the round-1 terminal section. Concurrency this round: at most **2**
terminal validators at once, and only one property/scale suite at a time.)

- Commands are in `services.yaml` `commands.*`: use `test_workspace`,
  `test_files_tenant_api`, `test_files_app`, `e2e_build`, `e2e_spec`,
  `lingui_check`, `seed_reservations_acme`.
- Do not start a run that another group's report depends on concurrently: the
  App build/Playwright (group g7) must not run beside 3+ browser sessions; the
  engine property suite (g1) is the heaviest single run in the mission.
- Read-only SQLite only: `sqlite3 <db> "SELECT ..."`. The one writer allowed is
  `seed:reservations` in the group it is assigned to. Trigger-abort checks
  (VAL-BOOK-038) must run on a **throwaway copy** of the tenant DB (`cp` to
  `/tmp/menuza-user-testing/g11-<name>.db` and run the DELETE/UPDATE probes
  there) — never mutate the live acme DB.
- Never print a secret. Vitest needs `CI=true`.

## Flow Validator Guidance: curl (foh-core)

- Ports: tenant-api US `http://localhost:3007`, KSA `http://localhost:3009`, App
  `http://localhost:3001`. Start nothing.
- Mint tokens with `/tmp/menuza-user-testing/mint-token.mjs` (above) or through
  the App; never log the value.
- App resource routes need the operator **session cookie**: log in with
  `agent-browser` first if an assertion needs
  `/resources/reservations/region-summary`, or use `curl -b` with the session
  cookie you extract inside the browser session. `INTERNAL_COMMAND_TOKEN` for
  `/internal/reservations/*` comes from `apps/app/.dev.vars`.
- Always send the negative case before the positive one and capture `curl -si`
  when the assertion mentions headers.
- Public routes need `Origin: http://acme.menuza.test:3008` (or
  `http://riyadh-grill.menuza.test:3008` against 3009).
- This surface does not change org flags or location settings unless its
  assignment says so; the browser groups own UI-driven settings writes.

## Flow Validator Guidance: agent-browser (App operator UI)

- One session per validator: `--session d15910fb8c20__<group>` (for example
  `d15910fb8c20__g3`). Close it before you finish.
- App `http://localhost:3001`; login `kody` / `KodyLovesYou!2026` by opening
  `/login` directly. A first-visit cookie banner is harmless.
- First load of a route can take 30-66 s; reload a page that renders without
  interactive elements ("Invalid hook call"). Never wait for network idle (the
  notifications SSE stream stays open).
- Screenshots and snapshots go to absolute paths under
  `{missionDir}/evidence/foh-core/<group>/`.
- Read-only SQLite verification is expected for evidence
  (`sqlite3 packages/database/db/tenant_t58bgatqh3rv5...db "SELECT ..."`), but
  only `SELECT`.
- Judge status codes from the browser's network capture of the **document**
  request (single fetch also emits `<path>.data` XHRs; a `.data` redirect
  answers 202).

## Flow Validator Guidance: agent-browser (restricted operator accounts)

Group g14 additionally creates a role from the Host preset, an invite link and a
new member, then signs in as that member in a **second** session
(`--session d15910fb8c20__g14b`). Steps:

- Settings → Roles (`/acme/settings/roles`): create a role from the **Host**
  preset.
- Settings → Members (`/acme/settings/members`): invite an email, then read the
  invite link/code from local D1:
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "SELECT target, code FROM Verification ORDER BY createdAt DESC LIMIT 5"`.
- Complete signup in the second session and keep it until the group's RBAC
  assertions are done. Do not delete the role or the member.
- Keep the host user's phone/email inside the g14 registry row.

## Round foh-core concurrency plan

| Batch | Groups                                                             | Concurrent browsers |
| ----- | ------------------------------------------------------------------ | ------------------- |
| A     | g1 (terminal), g2 (curl), g17 (browser, first-visit flag walk)     | 1                   |
| B     | g3, g4 (browser), g6 (curl), g7 (terminal: App build + Playwright) | 2                   |
| C     | g5, g8, g9 (browser), g11 (curl/sqlite)                            | 3                   |
| D     | g10, g12, g13 (browser), g15 (curl)                                | 3                   |
| E     | g14, g16 (browser)                                                 | 2                   |

Never exceed 3 browser sessions; keep at 2 while g7 runs. Do not start an App
build, typecheck or lint yourself.

## Round foh-core results and runtime findings

Round 1 finished `fail` on 12 of 109 assertions (97 pass, 0 blocked); 17 groups,
4 batches plus 2 groups in the final batch. Every group's report is in
`validation/foh-core/user-testing/flows/`, evidence under
`evidence/foh-core/<group>/`.

### Things that cost time — reuse these

- **Local D1 has a system-level `reservations.enabled = true` row.** `data.db`
  has `false` for the system row, local D1 does not, and `getFeatureFlag` falls
  back to the system row. Deleting the org-level rows therefore does **not**
  hide the module. To induce a flag-off state in local D1 you must write
  `ConfigFlag.level='system'` (or set the org row to `false`), then restore.
  Affects any later milestone whose precondition is "module hidden".
- **Flag-off observations must be made inside the write window.** The App's dev
  D1 watcher restores `.wrangler/state` (all rows revert to `true`) within about
  40 s of a write. Toggle, observe, restore, then verify.
- **Invite/signup links do not work as the doc recipe implies.** `Verification`
  has no `code` column (it stores a TOTP secret), and App signup email fails in
  Workers dev (`API key is invalid`). Compute the 6-digit code locally from the
  stored secret with `@epic-web/totp` and delete the temp secrets afterwards.
  The Settings → Members "Create Link" button always mints the built-in Member
  role, so a custom-preset member has to go through the email invite.
- **The members/signup pages need a reload before React handlers attach**;
  several submits needed `form.requestSubmit()`; covered quick-action buttons
  needed a JS click.
- **Settings → Services, `Pacing`, `Overrides` and `Special days` render in the
  App on some cold loads but are driven by `fetch`**, not single fetch — wait
  for rows before asserting, and re-check after any navigation (`agent-browser`
  reports an empty page body otherwise).
- **`agent-browser` HTML5 drag is unreliable on the timeline/floor canvas** (CDP
  `mouseMoved` does not move an element with `draggable=true`). Dispatch
  `DragEvent`s or use the keyboard path. `fill ""` does not clear a
  React-controlled input; set the value through the native setter and dispatch
  `input`.
- **The App UI settings screen renders only a curated subset of fields**; 18
  settings fields are PUT-only (see
  `apps/app/app/utils/reservations/setup-api.ts`). A UI assertion that a
  settings value is editable can be unsatisfiable by construction — check the
  form first and, if the field is API-only, verify at the endpoint level and say
  so. Do not mark the user-visible behavior passed.
- **`apps/app/.dev.vars` holds `TENANT_OPERATOR_TOKEN`**, and the token issuer
  must be `brand.shortName` (`menuza`, lowercase). See the minting section
  above.
- **The public availability route** (`/reservations/*` on tenant-api, and Sites
  `/reserve`) is not implemented in `foh-core`; guest-facing manage/booking
  clauses belong to `guest-channels-and-crm`. Do not report their absence as a
  defect — report the clause as not exercisable yet.

### Defects confirmed in this round (do not re-diagnose from scratch)

| Assertion                   | Root cause                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-FND-006                 | `searchAvailability` folds `existingHolds` into occupancies without filtering `expiresAt` (`packages/reservations/src/availability.ts:395-435`); the `kind === 'hold'` branch in `assign.ts:370-420` also lacks the expiry filter that the `input.holds` loop at `:414` applies.                                            |
| VAL-FND-009                 | The property suite calls `bruteForceAssignExists` once per day scenario (`apps/tenant-api/src/services/engine.property.test.ts:45`), not after every step of `executeOperationSequence`.                                                                                                                                    |
| VAL-SETUP-020               | UI delete posts to `/locations/:id/pacing/:ruleId` (`setup-api.ts:1958-1966`) but tenant-api registers `DELETE /pacing/:id` only (`operator-reservations-setup.ts:1482-1507`).                                                                                                                                              |
| VAL-SETUP-021               | Same URL-shape mismatch for service availability (`setup-api.ts:2045-2053`).                                                                                                                                                                                                                                                |
| VAL-SETUP-023               | UI block create sends `startMin/endMin`; `createBlockForLocation` binds a `localToInstant()` object into a numeric column (`rsv-setup-crud.ts:3049-3056`) → 500. Blocks created with epoch `startAt/endAt` work, which is how later groups worked around it.                                                                |
| VAL-SETUP-025               | The conflicts panel reads `confirmationCode/businessDate/partySize/reason` from a payload that returns `kind/bookingId/details.businessDate`, so rows render as `· (p)`. The endpoint itself is correct.                                                                                                                    |
| VAL-BOOK-003, 008, 009, 013 | Detail sheet omits occasion and dining-area name and has no free-text dietary input (`occasion` comes back as a tag id); the day query ignores `serviceId` and there are no cover counters; area/source/tag filters are missing; the sheet omits source, occasion and event timestamps and never calls the events endpoint. |
| VAL-BOOK-037                | Status/course badges render raw English enums (`today.tsx:376,507,590`, `book.tsx:449,453`, `detail-sheet.tsx:403`).                                                                                                                                                                                                        |
| VAL-HOST-014                | `transitionReservationStatus` ignores the `tableIds` the App sends on the arrived→seat path, so the party seats without a table (no occupancy row, `tableIds: []`).                                                                                                                                                         |
| VAL-CROSS-006               | The UI block-create 500 above; the day feed has no `moveNotices` (reflow happens and emits `auto_reassigned`, but no notice reaches hosts); the timeline unassigned/conflicts badge does not surface a locked booking that a block displaced.                                                                               |

### Contract-versus-implementation terminology deviations (recorded, not failures)

`rsv_reservation_tables` → `rsv_table_occupancies`; `locked_assignment` →
`rsv_reservations.assignment`; event names `table_assigned` →
`table_changed`/`locked`/`unlocked` and `undone` → `status_undo`; idempotency
scopes are route paths, not `operator_create`/`walk_in`; a replayed create
answers 201, not 200; the full-slot code is `tables_occupied`; the course event
type is `course`.

### Left-behind state after round 1

Roles `G14-Host` (Host preset) and `G14-Viewer` (read-only) with members
`host_cross_g14` and `viewer_g14`; a disposable org `g16-disposable`; archived
tables `G16-*` and area `G16-Area`. The temporary location used for VAL-BOOK-031
was deleted. Both acme locations are back on `America/New_York`,
`floor_plan_version` 77, settings `version` 29; all `reservations.*` org flags
are `true`.

---

# Round: foh-core user testing round 2 (re-test of the 12 round-1 failures)

Round-1 synthesis: `validation/foh-core/user-testing/synthesis.json` (13 failed;
`VAL-CROSS-006` was moved to `online-booking-sites-and-app-ui` and is **not** in
this round). Fix features: `foh-core-ut-fix-backend` (commit `5826f11d`),
`foh-core-ut-fix-ui` (commit `4e0149b1`). Everything above still applies
(surfaces, login recipes, mock transports, isolation rules).

Targets this round: `VAL-FND-006`, `VAL-FND-009`, `VAL-SETUP-020`,
`VAL-SETUP-021`, `VAL-SETUP-023`, `VAL-SETUP-025`, `VAL-BOOK-003`,
`VAL-BOOK-008`, `VAL-BOOK-009`, `VAL-BOOK-013`, `VAL-BOOK-037`, `VAL-HOST-014`,
plus regression paths: Setup services / special days, Book, Floor and Arabic
RTL.

## Environment state at the start of round 2 (verified by the validator)

- Services: `tenant-api-us` 3007 and `tenant-api-ksa` 3009 were already running
  (restarted 02:09 UTC, code matches HEAD: the live day feed returns
  `counters` + `moveNotices`, and
  `DELETE /operator/reservations/setup/locations/:id/pacing/:ruleId` answers 401
  without a token instead of 404). `app` 3001 was started for this round
  (`VITE_DIRECT_DEV=1`, healthcheck 200). `sites` 3008 and `admin` 3005 are
  **stopped** this round.
- Flags: all `reservations.*` org rows are `true` for `acme` and `riyadh-grill`,
  and local D1's **system** row `reservations.enabled` is also `true`. The
  module is visible for both orgs.
- Data leftovers from the fix workers on acme (account for them, do not delete):
  - `rsv_floor_elements` rows 9 and 10 are two `wall` elements in `G15-Area`;
    live `floor_plan_version` for the seeded location is **79** (not 77). No
    other layout change.
  - One `UI Fix Tester` seated reservation
    (`rsv_c0912e24-c52a-4996-afa3-f01143ec9f8d`) on **2026-10-17** at 19:00 on
    `G10-T1` (`tbl_08a45749-5fbc-459b-aca0-a12c4a39007f`) with an active
    occupancy, plus a `Walk-in Guest` seated at 21:33 on 2026-10-17.
- 2026-10-16 rows (the seeded "today" fixtures) are still present and must not
  be deleted or altered: 13 reservations, `svc_acme_lunch` rows at 12:30/13:00
  and `svc_acme_dinner` rows 18:00–21:15, channels `host` (9), `phone` (2),
  `walk_in` (2), with one `cancelled` and one `no_show`.
- **Business date caveat:** the org time zone is `America/New_York`. Until
  2026-10-17 04:00 UTC the business date is still 2026-10-16; after that it
  flips to 2026-10-17. Read the date from the screen or API, never hardcode
  "today", and expect the seeded 2026-10-16 fixtures to become yesterday
  mid-round.

## D1 flag toggle recipe (use this, never `delete` the org rows)

Local D1 (`apps/app/.wrangler/state`) has a **system-level**
`reservations.enabled = true` row, so `getFeatureFlag` still resolves `true`
when the org rows are deleted — deleting rows does **not** hide the module. To
induce the flag-off state:

```bash
bash {missionDir}/scripts/set-org-flag.sh acme reservations.enabled false   # writes local D1 + data.db
# observe within the write window (the App's dev D1 watcher restores .wrangler/state in about 40 s)
bash {missionDir}/scripts/set-org-flag.sh acme reservations.enabled true    # restore
```

Rules: only the group that owns the flag check may toggle; toggle and restore in
the same session; confirm the restore
(`SELECT key, level, value FROM ConfigFlag WHERE key='reservations.enabled'` via
`npx wrangler d1 execute DB --local --json` from `apps/app`); the sidebar nav
itself is cached for 30 s (`reservations-nav:<orgId>:<userId>`) so reload after
~35 s or check the route status instead of the sidebar. Route-level gating is
not cached.

## What the fixes changed (so you know what to re-check)

- Backend (`5826f11d`): `packages/reservations/src/engine/availability.ts` +
  `assign.ts` (drop expired holds),
  `packages/reservations/src/engine/engine.property.test.ts` +
  `testing/arbitraries.ts` (per-step oracle),
  `packages/tenant-db/src/resolver.ts`, tenant-api
  `operator-reservations-setup.ts` (location-scoped DELETE aliases for pacing +
  service availability), `rsv-setup-crud.ts` (block `startMin`/`endMin` →
  epoch), `rsv-booking-service.ts` (`tableIds` honoured on a transition to
  `seated`), `rsv-day-feed-service.ts` (day filters + `counters` +
  `moveNotices`), `reservations-write.ts` (real org id as the setup lock key).
- App (`4e0149b1`): `setup-api.ts` (delete paths, conflicts mapping),
  `book-api.ts`, new `labels.ts` (i18n label maps), `book.tsx`, `today.tsx`,
  `detail-sheet.tsx`, `booking-sheet.tsx`, `floor.tsx`, `timeline.tsx`,
  `conflict-panel.tsx`, `walk-in-dialog.tsx`, `use-host-stand.ts`, `settings.*`
  screens, `locales/{en,ar}.po`.

## Data isolation registry for round 2

| Group        | Surface  | Owned business date(s)                                                              | Owned US phone / email prefix                  |
| ------------ | -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| r2-flaggate  | browser  | —                                                                                   | —                                              |
| r2-engine    | terminal | —                                                                                   | —                                              |
| r2-api       | curl     | 2026-10-31 (blocks), 2026-11-06 (its own service)                                   | `+155555520xx` / `rsv-r2api-<n>@example.com`   |
| r2-suites    | terminal | —                                                                                   | —                                              |
| r2-setup-ui  | browser  | 2026-10-30 (blocks), 2026-11-05 (special days), its own service                     | `+155555521xx` / `rsv-r2setup-<n>@example.com` |
| r2-book-ui   | browser  | 2026-10-29 (new bookings; 2026-10-16/20 read-only)                                  | `+155555522xx` / `rsv-r2book-<n>@example.com`  |
| r2-today-rtl | browser  | current business date (2026-10-16 → 17)                                             | `+155555523xx` / `rsv-r2today-<n>@example.com` |
| r2-floor     | browser  | 2026-10-30 (its own tables/reservations); floor canvas may also be viewed for today | `+155555524xx` / `rsv-r2floor-<n>@example.com` |

KSA: `riyadh-grill`, location `oi97w1dxwcpnkpq9m9s8cnu8`, tenant DB
`packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db`. Setup-mutation
isolation rules from round 1 still apply (add, do not rewrite; restore location
settings you change; confine special days/blocks/pacing/service-availability to
your own dates and services).

## Flow Validator Guidance: terminal (round 2)

- Commands from `services.yaml`: `test_workspace`, `test_files_tenant_api`,
  `test_files_app`. `CI=true` is required.
- At most **2** terminal validators at once and only one property/scale suite at
  a time. Do not run `commands.test` (the full gate), a whole-App suite,
  typecheck, lint or the App build.
- Read-only SQLite only (`sqlite3 <db> "SELECT ..."`); never mutate the live
  acme DB from a shell (trigger probes run on a `/tmp` copy).
- Never print a secret. Record exact commands, exit codes and observed test
  counts.

## Flow Validator Guidance: curl (round 2)

- Ports: tenant-api US `http://localhost:3007`, KSA `http://localhost:3009`, App
  `http://localhost:3001` (App internal routes need the operator session cookie;
  prefer the tenant-api routes).
- Mint tokens with
  `/tmp/menuza-user-testing/mint-token.mjs --org acme --scope book|setup|guests|reports|payments`
  (secret read from `apps/app/.dev.vars`; issuer `menuza`). Never write a token
  value into evidence or a report — describe it.
- Always send the negative case (no token / wrong scope) before the positive
  one, and use `curl -si` when the assertion mentions headers. Do not change org
  flags; the browser groups own UI-driven writes.

## Flow Validator Guidance: agent-browser (round 2)

- One session per validator: `agent-browser --session c7e026d0d5c8__<group>`;
  close it when you finish.
- App `http://localhost:3001`; login `kody` / `KodyLovesYou!2026` by opening
  `/login` directly. First load of a route can take 30-66 s; reload a page that
  renders without interactive elements ("Invalid hook call"). Never wait for
  network idle.
- Judge status codes from the network capture of the **document** request
  (single fetch also emits `<path>.data` XHRs; a `.data` redirect answers 202).
- Screenshots and snapshots go to absolute paths under
  `{missionDir}/evidence/foh-core/<group>/`.
- Local D1 reads:
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "SELECT ..."`;
  tenant DB reads:
  `sqlite3 packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db "SELECT ..."`
  (SELECT only).
- HTML5 drag is unreliable through CDP: dispatch `DragEvent`s or use the
  keyboard path (keyboard drag and drop is part of the product). `fill ""` does
  not clear a React-controlled input; set the value through the native setter
  and dispatch `input`.

## Round 2 concurrency plan

| Batch | Groups                                                                                  | Concurrency                     |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------- |
| 0     | r2-flaggate (browser, flag off/on), r2-engine (terminal, property suite), r2-api (curl) | 1 browser + 1 terminal + 1 curl |
| 1     | r2-setup-ui, r2-book-ui (browsers), r2-suites (terminal)                                | 2 browsers + 1 terminal         |
| 2     | r2-today-rtl, r2-floor (browsers)                                                       | 2 browsers                      |

Never exceed 3 browser sessions. Do not start an App build, typecheck or lint.
`r2-flaggate` runs first and alone in the flag sense: it toggles
`reservations.enabled` off for `acme` and must restore it before it finishes.

## Round 2 results and runtime findings

Round 2 re-tested the 12 foh-core failures the two fix commits targeted, plus
the Setup services/special-days, Book, Floor and Arabic-RTL regression paths:
**10 pass, 2 fail, 0 blocked**. Seven groups in three batches (flag gate +
engine + curl API; setup UI + book UI + targeted suites; RTL/Today + floor).
Reports: `validation/foh-core/user-testing/flows/r2-*.json`; evidence under
`evidence/foh-core/r2-*/`. Round-1 synthesis preserved as
`validation/foh-core/user-testing/synthesis-round1.json`.

| Assertion     | Result   | Key evidence                                                                                                                                                                                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VAL-FND-006   | pass     | `vitest run src/engine` 6 files / 26 tests; expired holds filtered in `availability.ts:404-409` and `assign.ts:379-380`; live hold still 0 slots, expired 15/15 in the direct probe                                                                                                                                |
| VAL-FND-009   | pass     | full `@repo/reservations` suite 19 files / 73 tests; per-step oracle loop in `engine.property.test.ts:128-152` + `testing/arbitraries.ts:1041-1079`; 300 day scenarios, 100 sequences × 8–16 steps                                                                                                                 |
| VAL-SETUP-020 | pass     | UI create 201 (channel select limited to all/online) and UI delete `DELETE /locations/:id/pacing/:id` 200; cross-location 404; legacy `/pacing/:id` still works                                                                                                                                                    |
| VAL-SETUP-021 | pass     | four modes created from the UI, UI delete 200 (was 404), 400 `invalid_target` for zero/two targets                                                                                                                                                                                                                 |
| VAL-SETUP-023 | pass     | block create from the Special days form 201 (was 500) for single-table and area blocks, occupancies expanded, delete 200; reflow + `moveNotices` verified by curl                                                                                                                                                  |
| VAL-SETUP-025 | pass     | panel renders 8 rows as `CODE · date · Party of N` + localized reason matching the `/conflicts` payload                                                                                                                                                                                                            |
| VAL-BOOK-008  | pass     | service/area/source/tag filters narrow rows and `counters` matches the filtered set; ETag per query, 304 on repeat                                                                                                                                                                                                 |
| VAL-BOOK-009  | pass     | name / middle phone / confirmation code / table-label search and status/area/source/tag filters, intersections included                                                                                                                                                                                            |
| VAL-BOOK-013  | pass     | sheet loads `GET /reservations/:id/events` 200 and renders timestamped history with actor kinds                                                                                                                                                                                                                    |
| VAL-HOST-014  | pass     | arrived drop → `POST /status` 200, occupancy row for `tbl_acme_m4`, `seated_at` set, day-feed `tableIds` non-empty; booked drop → `POST /assign` 200; occupied-table seat 409 without overbook                                                                                                                     |
| VAL-BOOK-003  | **fail** | sheet/endpoint return area, duration 120 (+120-minute occupancy), dietary and internal notes, but the endpoint's `occasion` is the resolved tag id `tag_acme_anniversary` instead of the chosen value `anniversary` (serializer maps `occasion` to `occasion_tag_id`; the App strips the prefix client-side)       |
| VAL-BOOK-037  | **fail** | all status/course badges now Arabic and RTL correct, but the contact-status chip renders English `Left message` (`contact_status='left_message'`); `CONTACT_STATUS_LABELS` (`labels.ts:34-39`) and `CONTACT_STATUSES` (`detail-sheet.tsx:61-66`) use invented keys while the canonical vocabulary is `left_message | no_answer | wrong_number` (architecture.md:716) |

Regression re-checks all passed: `VAL-FND-021` (flag off → 404 on
`/acme/reservations`, `/settings` and the token route, sidebar group gone;
restored), `VAL-SETUP-018/019/022`, `VAL-BOOK-001/002/006/010/011/012`,
`VAL-HOST-012/013/015/016/017`, and the targeted suites (`tenant-api` 51 tests,
`tenant-db` schema 6, App reservations utils 66, engine units 15 — all exit 0).
`VAL-SETUP-026` was only partially re-verified: the browser half was not
re-exercised (its location is in sync; forcing a mismatch would have written
outside the group's boundary), while the banner was observed rendering on the
second acme location and `reservations-setup.test.ts` passes.

### Things that cost time — reuse these (round 2)

- **`GET /operator/reservations/setup/locations/:id/conflicts` runs the reflow
  engine**, so a GET can append events and bump day versions. Expect it, and do
  not treat the extra writes as a defect.
- `rsv_day_versions` does not bump exactly +1 per block operation (observed
  +2/+2/+2 for create/create/delete).
- Creating a reservation needs an `Idempotency-Key` (400 without one), and a
  create with no `tableIds` still auto-assigns a table; to reach the
  "unassigned" precondition,
  `POST /book/reservations/:id/assign { tableIds: [] }`.
- The **business date can disagree with the location's date**:
  `operator-reservations-book.ts:199,278,377` fall back to the UTC date, so
  Today showed 2026-10-17 while it was still 23:15 EDT on 2026-10-16. Read the
  date from the screen and do not treat the fallback as a new defect
  (pre-existing).
- Floor/book drags still need dispatched `DragEvent`s; status-filter buttons and
  several row actions are "covered" for CDP clicks (use an in-page `.click()`);
  native setters are needed for `input[type=date]`/`input[type=time]`; the
  booking sheet keeps its previous guest/date state when reopened.
- The auto-assigned best-fit table ignores the Dining Area preference when
  `areaPrefStrict` is false (no UI toggle) — recorded, not adjudicated.
- Pacing-cap warnings remain unobservable from the UI (same as round 1).
- `r2-setup-ui`: pacing and service-availability rules have no UI _edit_ control
  (create + delete only); the availability form cannot express zero/two targets
  (post from the page to prove the 400); the services form blocks invalid time
  ordering client-side; special-day row actions share test ids across rows on
  the same date.
- `r2-flaggate`: let the 30 s nav cache expire _before_ toggling, otherwise the
  sidebar check eats the ~40 s D1 write window; the role editor's Reservations
  group sits below the fold.
- A `ps`-based "another vitest is running" guard can match its own command line
  — match `vitest\.mjs` only.

### Remaining defects after round 2 (do not re-diagnose)

| Assertion    | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-BOOK-003 | Booking/query serializer returns the occasion **tag id** in the `occasion` field (`occasion === occasionTagId`, both `tag_acme_anniversary`); the booking sheet submits the bare value (`anniversary`, `OCCASION_OPTIONS`) and the new `OCCASION_LABELS` map is keyed by bare values too, so the chosen value is lost in the response and the client strips the `tag_acme_` prefix to display it (`book-api.ts:888-891`). Either return the bare value in `occasion` (keeping `occasionTagId`) or amend the assertion. |
| VAL-BOOK-037 | `CONTACT_STATUS_LABELS` (`apps/app/app/utils/reservations/labels.ts:34-39`) and `CONTACT_STATUSES` (`detail-sheet.tsx:61-66`) use `sms_sent                                                                                                                                                                                                                                                                                                                                                                            | left_voicemail | confirmed_by_phone`; the canonical values are `left_message | no_answer | wrong_number`, so a stored `left_message` renders the English humanized enum in Arabic and the detail sheet's Contact Tracking selector cannot show or set it. |

Residual engine observation (not a failure of VAL-FND-006): a hold row passed
through the **generic** `occupancies` input still ignores `expiresAt`
(`availability.ts:415-430` maps `input.occupancies` straight into
`assignBookings`). Only the two adjudicated paths (`existingHolds` and the
`kind === 'hold'` branch) were fixed; callers should not pass holds through
`occupancies`.

### Left-behind state after round 2

Flags: local D1 system row `reservations.enabled` true, both org rows true
(never deleted; the flag was toggled off only inside three short r2-flaggate
windows and restored each time). New acme test data inside the registry:
`R2Book` (2026-10-29), `R2-API-*` (2026-10-31) with the `R2-API-Service`,
`R2Today` (2026-10-17), `R2Floor` (2026-10-30), plus `R2-SETUP-Svc` and one
archived `R2-SETUP-Temp` service. The UI fix worker's leftovers remain (two
`wall` elements in `G15-Area`, `floor_plan_version` 79, `UI Fix Tester` seated
at G10-T1 on 2026-10-17). `Waterfront Kitchen` (`vw6s16lrjjvyafd3dc4cqexu`)
still carries `time_zone=UTC` in `rsv_location_settings` against the
control-plane `America/New_York`, so the settings screen shows a real
`tz_mismatch` banner there.

---

# Round: foh-core user testing round 3 (re-test of the two round-2 failures + Today/Settings regressions)

Round-2 synthesis: `validation/foh-core/user-testing/synthesis.json`. Round-2
fix commit: `521df7ed`. Scope this round (orchestrator): **VAL-BOOK-003** and
**VAL-BOOK-037** only, plus quick regression checks on the Today business date
and the Settings conflicts panel. Everything above still applies (surfaces,
login recipes, mock transports, setup-mutation isolation).

## Environment state at the start of round 3 (verified by the validator)

- HEAD = `521df7ed`, clean tree on `pr/reservations`. tenant-api US (3007) and
  KSA (3009) were already running and **already serve HEAD**, verified live: at
  03:49 UTC on 2026-10-17 (`TZ=America/New_York` = 2026-10-16),
  `GET /operator/reservations/book/day?locationId=v17plv08r5v357bie335lyq8` with
  **no** `date` parameter returned `businessDate: "2026-10-16"`, 13
  reservations, counters 11 parties / 30 covers — the America/New_York business
  date, not the UTC date, i.e. the pre-fix UTC fallback is gone.
- App (3001) was started by this validator with `VITE_DIRECT_DEV=1`; healthcheck
  200 after ~4 minutes cold. Start dev servers with a detached/background
  launcher (the harness `fireAndForget`), not a plain `&` inside a one-shot
  shell, or the server dies with its shell.
- Sites (3008) and Admin (3005) are not needed this round and stay stopped.
- **The business date is the service day, not the calendar day.**
  `resolveBusinessDate` (`rsv-business-date.ts`) calls
  `currentBusinessDate(nowMs, locationTz, dayStartMin)`
  (`packages/reservations/src/time.ts:230`), and the seeded acme location has
  `day_start_min = 240`. So even after the New York calendar date rolls over at
  04:00 UTC, the business date stays **2026-10-16 until 04:00 EDT = 08:00 UTC on
  2026-10-17** (this session ends long before that). At 04:01 UTC the live day
  feed still returns `businessDate: "2026-10-16"` while the UTC calendar date is
  2026-10-17 — that difference is the _correct_ new behavior (the old UTC
  fallback would have said 2026-10-17). Never hardcode "today": read it from the
  screen and compare with `TZ=America/New_York date` (the day-start offset
  applies).
- Leftovers to account for, never delete: floor plan v79 (two `wall` elements in
  `G15-Area`), `UI Fix Tester` seated on `G10-T1` on 2026-10-17, R2* rows
  (2026-10-20, 2026-10-29/30/31), `rsv_acme_1` on 2026-10-16
  (`contact_status='left_message'`, `occasion_tag_id='tag_acme_anniversary'`),
  and `Waterfront Kitchen` (`vw6s16lrjjvyafd3dc4cqexu`, settings
  `time_zone=UTC`) which intentionally shows the settings tz-mismatch banner.
  The 13 seeded 2026-10-16 reservations must not be deleted or altered.

## What commit `521df7ed` changed (what to re-check)

- `apps/tenant-api/src/services/rsv-day-feed-service.ts` (+ new
  `rsv-business-date.ts`): the day feed/book routes return the **bare occasion
  code** in `occasion` (system key, e.g. `anniversary`) and keep
  `tag_acme_anniversary` in `occasionTagId`; the default business date comes
  from the **location time zone** instead of the UTC date.
- `apps/app/app/utils/reservations/book-api.ts`: the client-side `tag_acme_`
  prefix-stripping workaround is gone (the bare value now flows through).
- `apps/app/app/utils/reservations/labels.ts` +
  `components/reservations/detail-sheet.tsx`: `CONTACT_STATUS_LABELS` /
  `CONTACT_STATUSES` rekeyed to the canonical
  `left_message | no_answer | wrong_number` (+ `none`), Arabic `تم ترك رسالة` /
  `لا يوجد رد` / `رقم خاطئ`.
- `apps/tenant-api/src/services/rsv-setup-service.ts`:
  `GET /operator/reservations/setup/locations/:id/conflicts` is now a **dry
  run** (`dryRun: true`, `rsv-setup-service.ts:1563`, threaded through
  `:720-1350`) — no occupancy, reservation, event or day-version writes. In
  round 2 that GET could append events and bump `rsv_day_versions`.

## Data isolation registry for round 3

| Group      | Surface                       | Owned business date(s)                 | Owned US phone / email prefix                 |
| ---------- | ----------------------------- | -------------------------------------- | --------------------------------------------- |
| r3-book003 | browser (App)                 | 2026-11-12                             | `+155555540xx` / `rsv-r3book-<n>@example.com` |
| r3-rtl     | browser (App)                 | 2026-11-13 (+ read-only 2026-10-16/17) | `+155555541xx` / `rsv-r3rtl-<n>@example.com`  |
| r3-regress | browser (App) + curl + sqlite | 2026-11-14 (+ read-only today)         | `+155555542xx` / `rsv-r3reg-<n>@example.com`  |

Setup-mutation isolation rules from rounds 1-2 still apply (add, do not rewrite;
restore any location setting you change).

## Flow Validator Guidance: agent-browser (round 3)

- One session per validator: `agent-browser --session e1fd6c6d6da7__<group>`;
  close it when you finish. The App was started cold this round: the **first**
  load of a route can take 30-66 s, and a page that renders with no interactive
  elements or an "Invalid hook call" error was loaded mid-optimization — reload
  it. Never wait for network idle (the notifications SSE stream stays open).
- App `http://localhost:3001`; login `kody` / `KodyLovesYou!2026` by opening
  `/login` directly (a first-visit cookie banner is harmless).
- Judge document status codes from the network capture of the **document**
  request (single fetch also emits `<path>.data` XHRs; a `.data` redirect
  answers 202).
- Screenshots and snapshots go to absolute paths under
  `{missionDir}/evidence/foh-core/<group>/`.
- Read-only SQLite evidence:
  `sqlite3 /home/factory-user/repos/menuza/packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db "SELECT ..."`
  (SELECT only). acme location id for the seeded restaurant:
  `v17plv08r5v357bie335lyq8`.
- HTML5 drag is unreliable through CDP (dispatch `DragEvent`s or use the
  keyboard path). `fill ""` does not clear a React-controlled input (use the
  native setter + an `input` event). The booking sheet's later time-slot buttons
  can be reported "covered" — use the default slot or an in-page `.click()`.

## Flow Validator Guidance: curl (round 3)

- Ports: tenant-api US `http://localhost:3007`, KSA `http://localhost:3009`, App
  `http://localhost:3001`. Start nothing.
- Mint operator tokens with
  `node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book|setup`
  (issuer `menuza`, secret read from `apps/app/.dev.vars`). Always send the
  negative case first. Never write a token value into evidence or a report —
  describe it.
- Public routes need `Origin: http://acme.menuza.test:3008`.

## Flow Validator Guidance: terminal (round 3)

- Read-only SQLite only (`sqlite3 <db> "SELECT ..."`), `CI=true` for Vitest. At
  most **1** terminal run at a time this round. Do not start an App build,
  typecheck, lint or the full gate.

## Round 3 concurrency plan

| Batch | Groups                                 | Concurrency                                                       |
| ----- | -------------------------------------- | ----------------------------------------------------------------- |
| A     | r3-book003 (browser), r3-rtl (browser) | 2 browsers                                                        |
| B     | r3-regress (browser + curl + sqlite)   | 1 browser (runs alone so the conflicts dry-run snapshot is clean) |

## Round 3 results and runtime findings

Round 3 re-tested the two round-2 failures plus the two regression targets: **4
of 4 pass, 0 fail, 0 blocked**. Three groups in two batches (2 browsers; then 1
browser + curl/sqlite alone). Reports:
`validation/foh-core/user-testing/flows/r3-*.json`; evidence under
`evidence/foh-core/r3-*/`. Round-2 synthesis preserved as
`synthesis-round2.json`.

| Assertion                  | Result   | Key evidence                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-BOOK-003               | **pass** | `GET /operator/reservations/book/reservations/:id` returns `occasion='anniversary'` (bare value) with `occasionTagId='tag_acme_anniversary'`; diningAreaId, durationMin 120, dietary + internal notes, 120-minute occupancy on G4-2 (buffer 0); created `rsv_2248ace9-f6c9-4905-ac69-06e5e031b022` (#YKTPAF) on 2026-11-12      |
| VAL-BOOK-037               | **pass** | seeded `rsv_acme_1` (`contact_status='left_message'`) now renders the Arabic chip `تم ترك رسالة`; full-page scan for English contact-status strings is empty; selector round-trips canonical values (`none`/`left_message`/`no_answer`/`wrong_number`) with Arabic labels; dir=rtl, LTR codes/times/phones, zero console errors |
| VAL-BOOK-011 (regression)  | **pass** | day feed with no `date` param and the Today screen's Business date control both show `2026-10-16` at 04:01 UTC while the UTC date is `2026-10-17` (correct service day for tz `America/New_York` + `day_start_min=240`); 13 rows, counters 11/30                                                                                |
| VAL-SETUP-025 (regression) | **pass** | conflicts panel renders 10 rows matching the payload; the GET is a dry run — before/after snapshots identical across 3 panel loads + 2 authenticated GETs (day versions, event count 253 + `MAX(at)`, occupancy count 160, last-5 `updated_at`)                                                                                 |

### Things that cost time — reuse these (round 3)

- **The business date is a service day, not a calendar day**
  (`currentBusinessDate(now, tz, dayStartMin)`), so with acme's
  `day_start_min=240` it advances at 04:00 local (08:00 UTC), not at UTC
  midnight. At 04:01 UTC on 2026-10-17 the correct value was still 2026-10-16 —
  the _opposite_ of the pre-fix UTC fallback, which is exactly what makes the
  live probe decisive. Compute the expected value with
  `node -e "const d=new Date(Date.now()-240*60000); console.log(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).format(d))"`.
- **Dry-run measurement method for the conflicts GET:** snapshot
  `rsv_day_versions` (all rows), `COUNT(*)` and `MAX(at)`/per-type counts of
  `rsv_reservation_events`, `COUNT(*)` of `rsv_table_occupancies` and the last-5
  `rsv_reservations.updated_at` immediately before and after the loads; run it
  while no other group writes.
- **Start the App detached.** A `nohup … &` inside a one-shot shell dies with
  that shell (the App answered `/resources/healthcheck` 200 at 03:49:16 and was
  gone a minute later); use the harness background (`fireAndForget`) or
  `setsid`.
- `booking-sheet` slot buttons are addressed by minute testid
  (`booking-slot-1140` = 19:00), not by time string; the date input needs the
  native setter.
- The detail sheet's Contact Tracking control is a native `<select>`: ref clicks
  fail with "Could not compute box model" — use `agent-browser select` with the
  canonical value.
- The Settings conflicts panel is below the fold, so an element screenshot of it
  can come out blank; scroll first or use a full-page shot.
- ~~The module header Date control (`#reservations-date-input`) shows the
  App-shell UTC calendar date and can disagree with the Today list's Business
  date control (see the discovered issue below).~~ **Fixed in commit 05659c95**
  (`online-booking-sites-and-app-ui`): the header Date control and "Jump to
  Today" now use the service-day business date from the day feed.
- ~~Breadcrumbs stay Latin on Arabic pages (round-2 observation, unchanged)~~
  **Fixed in commit 05659c95**: the reservations breadcrumb segments are
  Lingui-wrapped and translated
  (`apps/app/app/components/workspace-breadcrumb.tsx:72-83`, `ar.po`).

### Round-3 discovered issue (reported, not failed)

- **Header date control vs service day.**
  `apps/app/app/routes/reservations+/_layout.tsx:98` shows the App-shell UTC
  calendar date, and `apps/app/app/utils/reservations/book-api.ts:1526` reads
  `dayStartMin` from the payload root while the response carries
  `settings.dayStartMin=240`, so the client-computed "Jump to Today" target
  collapses to the calendar date. On Today the list and feed were correct
  (`2026-10-16`), only the header control said `2026-10-17`. No contract
  assertion in round-3 scope covers it; the orchestrator may want a small fix
  feature. **Resolved in commit 05659c95** (`online-booking-sites-and-app-ui`):
  both now use the service-day business date
  (`reservations+/_layout.tsx:130-153`, `book-api.ts:1032-1033`).

### Left-behind state after round 3

Flags untouched: local D1 system `reservations.enabled` true, both org rows
true. New acme rows inside the registry:
`rsv_2248ace9-f6c9-4905-ac69-06e5e031b022` (#YKTPAF, `R3Book Guest One`,
2026-11-12) and `rsv_9dcf4f57-ed26-40f7-917b-c0090a597b81` (#QL7LZ3,
`R3Rtl Guest One`, 2026-11-13, `contact_status='left_message'`). Earlier
leftovers unchanged (floor plan v79 with two `wall` elements in `G15-Area`,
`UI Fix Tester` on `G10-T1`, R2* rows, Waterfront Kitchen tz mismatch). The 13
seeded 2026-10-16 reservations were not modified.

---

# Round: guest-channels-and-crm (notes from the scrutiny validator, before user testing)

The milestone `guest-channels-and-crm` shipped commits `c336ca21` (public API),
`05659c95` (Sites pages + App Requests), `97bb99a4` (messages/tick/waitlist
backend), `e5c6e296` + `5e7c5b12` (message/waitlist UI, occupied-table seat),
`2c411941` (waitlist fixes) and `661d65a5` (Guestbook + reports). Facts for this
round's validators:

- **`commands.set_org_flag` now refreshes the tenant-api context.** The script
  POSTs `/internal/reservations/context-changed` to ports 3007 and 3009 after
  writing the flag, so the "wait out the 5-minute public-write context
  freshness" step in VAL-ONLINE-027/028 is obsolete. The App's sidebar nav is
  still cached by the root loader (`reservations-nav:<orgId>:<userId>`, 30 s
  TTL), so wait ~35 s before judging the nav after a flag flip. If the nodes are
  down, the POST is best-effort and the 5-minute wait applies again.
- **Left-behind local state from the milestone's workers.** `riyadh-grill`'s
  `Organization.siteLocales` is now `["en","ar"]` in local D1 (a precondition
  for `/ar/reserve`; check it before assuming the locale is missing).
  Seeded/worker bookings remain on acme (`CXKM9CAP` cancelled, `J6XNSYC9` and
  `GKTX0QAT` approved) and riyadh-grill (`P765YM89`). The acme customer
  `+15555550123` was completed as **"Signed Guest"**, so assertions that expect
  the OTP flow to ask for a name again must use a fresh phone number.
- **Sites serves the published-org payload from a 24-hour KV cache.** Changing
  org fields (such as `siteLocales`) by SQL does not invalidate it; publish from
  the App UI or purge the KV key, otherwise `/reserve` keeps the old locales.
- **The Sites availability endpoint rate-limits (~30 requests/min).** Do not
  scan days in a tight loop; insert a temporary `rsv_pacing_rules` row
  (`max_covers=1`) in the tenant DB to force a full day, and delete it
  afterwards.
- **Restricted-grant gating still needs a second browser context.** The
  milestone's workers covered no-grant gating with tenant-api security tests and
  the App guards test; the recipe for a restricted operator is at line ~275 of
  this file (VAL-GUEST-011/013, VAL-REPORT-002/020 depend on it).
- **Guest emails need the nodes restarted through `services.yaml`** (the dev
  capture is enabled by `DEV_EMAIL_CAPTURE_DIR` in the current start scripts).
  Start the App on 3001 before tick-based message checks: when the App context
  is unreachable, tenant-api holds due messages for 10 minutes and the tick
  reports `flags_unknown`.

---

# Round: guest-channels-and-crm user testing (online booking, guest messages, waitlist, Guestbook, reports)

This block is the round guidance for
`user-testing-validator-guest-channels-and-crm` (181 pending assertions). It
supersedes earlier concurrency plans; everything above (surfaces, login recipes,
token minting, mock transports, isolation rules, setup-mutation rules) still
applies.

## Environment state at the start of this round (verified by the validator)

- Services started through `services.yaml`: `tenant-api-us` 3007,
  `tenant-api-ksa` 3009, `app` 3001 (`VITE_DIRECT_DEV=1`), `sites` 3008. **Admin
  3005 is NOT started** (no platform-fee assertion is in this milestone).
- Dev email capture is active: both nodes logged
  `DEV EMAIL CAPTURE ACTIVE -> .dev-mail/us` and `.dev-mail/ksa`; the US
  directory `apps/tenant-api/.dev-mail/us/` already has files. `.dev-mail/ksa/`
  is created by the first KSA email.
- Flags in local D1: `reservations.enabled`, `.online`, `.waitlist`,
  `.experiences` are `true` for **acme** and **riyadh-grill**. The round
  baseline for acme location `v17plv08r5v357bie335lyq8`:
  `large_party_mode = 'request'`, `contact_phone = '+1 (555) 234-5678'`,
  `hold_minutes = 7`, `guest_modify_cutoff_min = 120`, `online_party_max = 8`,
  `online_party_min = 1`, `waitlist_enabled/online/notify_me = 1`,
  `waitlist_response_min = 10`, `waitlist_max_parties = null`,
  `request_deadline_hours = 24`, `auto_no_show_after_min = null`,
  `day_start_min = 240`, `min_notice_min = 30`, `horizon_days = 60`,
  `version 33`. Re-read before you change anything; restore what you change.
- Sites locales: acme and riyadh-grill both have `siteLocales = ["en","ar"]`,
  `sitePublished = 1`. The four extra locales for VAL-ONLINE-055 must be enabled
  in the App and published (the published payload is cached).
- acme has 3 locations: `v17plv08r5v357bie335lyq8` (seeded _Downtown Flagship_,
  tz `America/New_York`), `vw6s16lrjjvyafd3dc4cqexu` (_Waterfront Kitchen_,
  deliberately mismatched `rsv_location_settings.time_zone`, so the settings
  screen shows a real tz-mismatch banner), `b5hymj7733l3wxrg74dytzty`.
  riyadh-grill (KSA) location `oi97w1dxwcpnkpq9m9s8cnu8`, tz `Asia/Riyadh`.
- Data present: acme 120 `rsv_guests` rows and reservations across many dates
  from earlier rounds, several waitlist entries, one `seeded` `wl_acme_1` still
  `waiting`; riyadh-grill has its own rows (seeded by `seed:reservations`). **Do
  not delete** seeded 2026-10-16 reservations, `R2*`/`R3*` rows, `UI Fix Tester`
  on `G10-T1`, the two `wall` elements in `G15-Area` (floor plan v79), the acme
  customer `+15555550123` ("Signed Guest": the OTP flow will not ask for a name
  again), or any worker booking (`CXKM9CAP`, `J6XNSYC9`, `GKTX0QAT` on acme;
  `P765YM89` on KSA).
- `commands.set_org_flag` now POSTs `/internal/reservations/context-changed` to
  both nodes, so public-route flag changes apply immediately (the old 5-minute
  wait is gone). The App sidebar nav is still cached ~30 s by the root loader.
- Business date: `day_start_min = 240` and tz `America/New_York`, so the acme
  service day flips at 04:00 EDT = 08:00 UTC. **Never hardcode "today"**; read
  it from the screen/API. Validator-owned future dates below are all inside the
  60-day horizon.

## Data isolation registry for this round

Each group owns its dates, phones and emails. Do not use another group's.

| Group              | Surface            | Owned acme business date(s)                                                     | Owned phone block / email prefix         |
| ------------------ | ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| g1-public-read     | curl               | 2026-10-20                                                                      | `+155555501x` / `rsv-g1-n@example.com`   |
| g2-public-write    | curl               | 2026-10-21                                                                      | `+155555502x` / `rsv-g2-n@example.com`   |
| g3-manage-api      | curl               | 2026-10-22                                                                      | `+155555503x` / `rsv-g3-n@example.com`   |
| g4-rules           | curl + browser     | 2026-10-23                                                                      | `+155555504x` / `rsv-g4-n@example.com`   |
| g5-msg-tick        | curl               | 2026-10-24                                                                      | `+155555505x` / `rsv-g5-n@example.com`   |
| g6-msg-booking     | curl               | 2026-10-25                                                                      | `+155555506x` / `rsv-g6-n@example.com`   |
| g7-msg-schedule    | curl               | 2026-10-26                                                                      | `+155555507x` / `rsv-g7-n@example.com`   |
| g8-waitlist-api    | curl               | 2026-10-27                                                                      | `+155555508x` / `rsv-g8-n@example.com`   |
| g9-guest-api       | curl               | 2026-10-28                                                                      | `+155555509x` / `rsv-g9-n@example.com`   |
| g10-waitlist-guest | curl + browser     | **2026-11-16** (was 2026-10-29, which a leftover `closed` special day blocks)   | `+155555510x` / `rsv-g10-n@example.com`  |
| g15-guest-merge    | curl               | 2026-10-30                                                                      | `+155555515x` / `rsv-g15-n@example.com`  |
| g16-reports-api    | curl               | 2026-10-31 (D), 2026-11-01 (D+1)                                                | `+155555516x` / `rsv-g16-n@example.com`  |
| b1-sites-guest     | browser + curl     | 2026-11-02                                                                      | `+155555521x` / `rsv-b1-n@example.com`   |
| b2-requests-block  | browser            | 2026-11-03                                                                      | `+155555522x` / `rsv-b2-n@example.com`   |
| b3-waitlist-ui     | browser            | 2026-11-04                                                                      | `+155555523x` / `rsv-b3-n@example.com`   |
| b4-msg-app         | browser + curl     | **2026-11-17** (was 2026-11-05, which a leftover `replace` special day changes) | `+155555524x` / `rsv-b4-n@example.com`   |
| b5-guestbook       | browser            | 2026-11-06                                                                      | `+155555525x` / `rsv-b5-n@example.com`   |
| b6-erase           | browser + curl     | 2026-11-07                                                                      | `+155555526x` / `rsv-b6-n@example.com`   |
| b7-reports-ui      | browser            | 2026-11-08                                                                      | `+155555527x` / `rsv-b7-n@example.com`   |
| b8-dashboard       | browser + curl     | today + 2026-11-09                                                              | `+155555528x` / `rsv-b8-n@example.com`   |
| b9-restricted      | browser + curl     | 2026-11-10                                                                      | `+155555529x` / `rsv-b9-n@example.com`   |
| b10-ksa            | browser + terminal | 2026-11-11 (KSA)                                                                | `+9665566110x` / `rsv-b10-n@example.com` |
| b11-sites-locales  | browser + curl     | 2026-11-12                                                                      | `+155555531x` / `rsv-b11-n@example.com`  |
| g12-flags          | curl + browser     | 2026-11-13                                                                      | `+155555532x` / `rsv-g12-n@example.com`  |
| g13-switches       | terminal + curl    | 2026-11-14                                                                      | `+155555533x` / `rsv-g13-n@example.com`  |
| g14-holds          | browser + curl     | 2026-11-15                                                                      | `+155555534x` / `rsv-g14-n@example.com`  |
| t1-suites          | terminal           | —                                                                               | —                                        |

## Isolation rules for this round (read before you act)

- **Serial operations** (only the group that owns them may do them, and it must
  restore state): org flag toggles (g12-flags), tenant-api node restarts / env
  overrides / rate-limit loops (g13-switches), acme location-settings changes
  such as special days, per-service table availability, pacing rules,
  `hold_minutes`, `guest_modify_cutoff_min`, large-party mode (g4-rules,
  g14-holds, and the specific assertions that name them). Never leave a setting
  or flag changed when your session ends. Record the "before" and "after" values
  in your report.
- **Add, do not rewrite**: create your own areas/tables/services/guests with
  your group prefix; never rename, archive or resize seeded rows; confine
  special days, blocks and pacing to your own dates; never delete seeded
  reservations or another group's rows.
- The per-org write lock serializes concurrent writes; contention shows as
  latency, not errors. A transient 429 or 404 is possible while
  g12-flags/g13-switches hold a flag off or a restart; re-check after ~60 s
  before reporting it as a defect, and say what you saw.
- Nothing in this round needs Admin. Do not start it (memory).
- Never print a token or secret in a report, evidence file or message. Describe
  it (`<guests token>`).

## Flow Validator Guidance: agent-browser (guest-channels round)

- One session per validator: `agent-browser --session 276ff6d660b4__<group>`
  (for example `276ff6d660b4__b1`). **Close it when you finish**
  (`agent-browser --session "<name>" close`); keep sessions ≤ 3 concurrent (the
  validator batches by concurrency).
- App `http://localhost:3001`: login `kody` / `KodyLovesYou!2026` by opening
  `/login` directly (never log out to switch users; a first-visit cookie banner
  is harmless). Sites: `http://acme.menuza.test:3008` (in `/etc/hosts`) and, for
  `riyadh-grill` and other orgs, launch the session with
  `--args "--host-resolver-rules=MAP *.menuza.test [::1]"`.
- First load of an App route can take 30-66 s (on-demand Vite compile); a page
  with no interactive elements or "Invalid hook call" was loaded
  mid-optimization: reload. Never wait for network idle (the notifications SSE
  stream stays open).
- Judge document status codes from the network capture of the **document**
  request (single fetch also emits `<path>.data` XHRs; a `.data` redirect
  answers 202).
- HTML5 drag is unreliable through CDP: dispatch `DragEvent`s with a
  `DataTransfer` or use the keyboard path. `fill ""` does not clear a
  React-controlled input (use the native setter + an `input` event). Native
  `<select>`: use `agent-browser select`, not a ref click.
- Screenshots and snapshots go to absolute paths under
  `{missionDir}/evidence/guest-channels-and-crm/<group>/`.
- Guest browser flows call tenant-api directly (`http://localhost:3007` for
  acme, `:3009` for riyadh-grill); the Sites page exposes it as
  `document.documentElement.dataset.tenantApiUrl`. Sites SSR never renders guest
  data: assert that by curl-ing the HTML, not by the browser.
- Read-only SQLite evidence:
  `sqlite3 /home/factory-user/repos/menuza/packages/database/db/tenant_t58bgatqh3rv0s3movrecyj1.db "SELECT ..."`
  (acme) and `.../db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db` (KSA). SELECT only.
  Local D1 reads:
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "SELECT ..."`.

## Flow Validator Guidance: curl (guest-channels round)

- Ports: tenant-api US `http://localhost:3007`, KSA `http://localhost:3009`, App
  `http://localhost:3001`. Start nothing.
- Public routes need the Sites Origin:
  `-H 'Origin: http://acme.menuza.test:3008'` (KSA:
  `http://riyadh-grill.menuza.test:3008` against 3009). Mutations are POST-only;
  where the contract says so, send `Idempotency-Key` (a fresh uuid per attempt)
  and `X-Client`.
- Operator tokens:
  `TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book|setup|guests|reports|payments)`;
  narrow the grants with `--grants a,b`; negative tokens with `--secret wrong`,
  `--ttl 3600`, `--impersonated`, `--locations <one-id>`. Never echo a token
  value into evidence or a report — `echo ${#TOKEN}` is fine.
- Internal token: read `INTERNAL_COMMAND_TOKEN` from `apps/app/.dev.vars` into a
  shell variable and never print it. Tick:
  `curl -s -H "Authorization: Bearer $INTERNAL" -H 'Content-Type: application/json' -d '{"orgId":"t58bgatqh3rv0s3movrecyj1"}' http://localhost:3007/api/reservations/tick`.
  Waiting for the Node interval (120 s) is an acceptable alternative.
- **Rate-limit hygiene:** public read routes are limited per client
  (availability 60/min, calendar 30/min, durable holds 10/10 min, manage
  mutations 30/h). Do not loop these routes outside the group that owns the
  rate-limit assertions (g13-switches); a stray 429 means you waited too little,
  not a defect.
- Always send the negative case before the positive one; capture `curl -si` when
  the assertion names headers.
- Save trimmed raw output under
  `{missionDir}/evidence/guest-channels-and-crm/<group>/`.

## Flow Validator Guidance: terminal (guest-channels round)

- Read-only SQLite (`sqlite3 <db> "SELECT ..."`), `CI=true` for Vitest, no App
  build, no typecheck, no lint, no full gate. At most **2** terminal validators
  at once and only one property/scale suite at a time.
- Do not start or stop services except where your own assertion says so
  (g13-switches owns node restarts).
- Never print a secret. Record each exact command, its exit code, and the
  observed test counts/lines.

## Flow Validator Guidance: mixed surfaces (guest-channels round)

Some groups legitimately combine a browser session, `curl` and read-only
`sqlite3` (g4, g10, b1, b6, b8, b10, g12, g13, g14). Keep one browser session,
do your curl work between UI steps, and put each assertion's evidence in a
single `<assertion-id>.json`/`.png`/`.txt` file naming scheme under your
evidence directory.

## Common recipes

- **Mint an operator token:** see above. `--scope guests` also grants
  `read:reservation:any`; `--scope book` grants read+update reservation only (no
  guest/report/settings grants).
- **SMS:** `/tmp/menuza-logs/tenant-api-us.log` lines
  `[SMS MOCK] To: <phone> | Message: <text>`; OTP codes for a phone:
  `grep -oE 'To: \+1555555011 \| Message: .*[0-9]{6}' /tmp/menuza-logs/tenant-api-us.log | tail -1 | grep -oE '[0-9]{6}$'`.
  KSA sends no reservation SMS.
- **Email:** newest first `ls -t apps/tenant-api/.dev-mail/us/*.json | head`;
  for one recipient `grep -l '<email>' <dir>/*.json | xargs ls -t | head -1`.
  Each file carries `to, subject, html, text, meta.messageKind`. The App-side
  capture (manager emails) is at `http://localhost:3001/mock-email` and
  `GET /mock-email/dev/messages?to=<email>`; `POST /mock-email/dev/reset`
  affects every validator — do not reset it while others read.
- **Read the live day feed** (operator route, `book` token):
  `GET http://localhost:3007/operator/reservations/book/day?locationId=v17plv08r5v357bie335lyq8`.

## Round guest-channels concurrency plan

| Batch | Groups                                                       | Concurrency                             |
| ----- | ------------------------------------------------------------ | --------------------------------------- |
| A     | b1, b2, b3 (browser) · g1, g2, g3, g5 (curl) · t1 (terminal) | 3 browsers + 4 curl + 1 terminal        |
| B     | b4, b5, b6 (browser) · g6, g7, g8, g9 (curl)                 | 3 browsers + 4 curl                     |
| C     | b7, b9, b11 (browser) · g10, g15 (curl)                      | 3 browsers + 2 curl                     |
| D     | b8, b10, g4 (browser) · g16 (curl)                           | 3 browsers + 1 curl                     |
| E     | g12 (flags, serial) · g14 (holds, serial)                    | 2 browsers + curl (flag windows ≤ 60 s) |
| F     | g13 (restarts + rate limits, serial, runs alone)             | 1                                       |

Never exceed 3 browser sessions or 4 curl validators; do not start an App build,
typecheck or lint.

## Runtime findings (guest-channels round, batch A — reuse these, do not re-diagnose)

- **Shared client identity for the durable rate limits.** `resolveClientIp`
  (`apps/tenant-api/src/lib/rate-limit.ts:48`) falls back to the literal
  `unknown` when neither `cf-connecting-ip` nor `x-forwarded-for` is present, so
  **every** local client (curl and browser) hashes to one `subject_hash` in
  `rsv_rate_counters`. The shared buckets bit batch A: `book_ip` reached its
  20/day limit at ~11:26 UTC and refused every `POST /reservations` for the rest
  of the UTC day (VAL-ONLINE-013/014/016/040 were blocked by it). The parent
  cleared the shared `unknown`-hash rows (acme + KSA) at ~12:10 UTC. Rules for
  the rest of the round:
  - **curl groups: give yourself a private client identity** by adding
    `-H 'X-Forwarded-For: 10.<group>.<n>.1'` (a distinct value per group) to
    public-route requests. This is the documented client-identity mechanism, not
    a bypass, and it keeps groups from starving each other.
  - **browser groups cannot set that header**, so the shared `book_ip` (20/day),
    `requests_ip` (5/10 min), `holds_ip` (10/10 min), `waitlist_join_ip` and
    `notify_me_ip` budgets are shared with every other validator. Do your public
    writes early in the session, keep them minimal, and if a public write
    answers `429 rate_limited`, retry once after ~60 s; if it still refuses,
    mark the affected assertion `blocked` with the evidence instead of forcing
    it.
  - Do **not** clear counters yourself (no shell writes to the DB). Only
    `g13-switches` exercises the durable-limit assertions, and it does so with
    its own X-Forwarded-For identity.
- **Guest manage/status links in messages point at the App origin and 404.**
  Captured confirmation emails and `[SMS MOCK]` texts carry
  `http://localhost:3001/reserve/manage#t=…` (and the waitlist ready message the
  same for `/reserve/waitlist`) because the App context's `siteOrigin` falls
  back to `ENV.BASE_URL` when the org has no custom domain
  (`apps/app/app/routes/resources+/reservations.context.ts:181`, consumed by
  `apps/tenant-api/src/services/rsv-message-service.ts:333`). `VAL-CROSS-011`
  failed on this; expect the same for `VAL-MSG-009` and any assertion that
  follows a link from a message. Report it, do not re-diagnose it, and use the
  token itself against tenant-api (`X-Reservation-Token`) to test the underlying
  behavior.
- **`POST /reservations/requests` can leak a raw internal error.** When the
  engine picks a table still held by another pending request it returns
  `409 {"error":"conflict","message":"Failed query: insert into \"rsv_table_occupancies\" …"}`
  because `pending_approval` is missing from `ACTIVE_BOOKING_STATUSES`
  (`packages/reservations/src/engine/assign.ts:301`). Reproduced by b2 and g5.
  Report it as an observation if you hit it; do not re-diagnose.
- **Leftover special days and blocks on acme** (from earlier rounds, keep them):
  `closed` 2026-10-29 (`G13-Closed`), `closed` 2026-11-02, `online_closed`
  2026-11-03, `modified` 2026-11-04, `replace` 2026-11-05 (`G5-*`); table blocks
  on 2026-10-25 (`tbl_acme_m6`), 2026-10-28 (`m1`,`m2`), 2026-10-30 (`p1`).
  riyadh-grill has `closed` 2026-11-02 (`G5-KSA-Closed`). Check your own date is
  bookable before concluding a slot is missing; the registry above already moved
  the two colliding dates.
- **App hydration noise:** opening the notification bell produced two one-off
  React nesting console errors (button-in-button, p-in-p) for b3; clean reloads
  show zero errors. Treat repeated, reproducible console errors as a defect, a
  single post-bell blip as noise.
- **`large_party_mode` baseline** is `request` (the validator set it at round
  start, settings version 33→33 after the change). `VAL-ONLINE-039` switches it
  to `contact` and back; nobody else changes it.
- **Operator cancel UI has no reason input** although the API accepts
  `cancelReason` (b1 observation) — record, do not fail an assertion on it
  unless the assertion requires entering a reason.
- **`GET /reservations/` with a trailing slash** returns Hono's default 404
  shape (not the uniform `not_found`); use the exact route paths.

## Runtime findings (guest-channels round, batch B)

- **The tick token works.** `INTERNAL_COMMAND_TOKEN` from `apps/app/.dev.vars`
  was verified by the parent to return 200 on `POST /api/reservations/tick` (the
  node has no `apps/tenant-api/.env`). A 401 there means a quoting/shell
  problem, not a different token source.
- **`VAL-MSG-009` fails on the same manage-link origin defect as
  `VAL-CROSS-011`** (b4 evidence). The token itself is fine:
  `GET /reservations/manage` and `/reservations/manage/calendar.ics` with
  `X-Reservation-Token` return 200. Both failures share one root cause
  (`siteOrigin` → `ENV.BASE_URL`); treat them as one defect with two assertion
  failures.
- **acme has no logo configured** (`siteIconKey = null`, `siteTheme = null`), so
  confirmation emails render the org-name text fallback plus the theme's hex
  colors instead of a logo image (g6). That is the correct fallback for an org
  without a logo — record it, do not fail branding assertions on it.
- **Message settings are shared state and were rewritten by three groups at
  once** (b4, g6, g7 changed per-kind enables, notes and quiet hours in the same
  batch; versions 44→54). They restored the baseline and reported it, but future
  rounds should serialize message-settings work: change one field, verify,
  restore, and re-read before each write. Location `b5hymj7733l3wxrg74dytzty` is
  a useful isolated single-table location for quiet-hours/reminder experiments.
- **Timing:** the Node interval tick (120 s) races manual ticks for
  deadline-based checks (g7, g8 saw interval ticks beat their manual ones). Read
  `rsv_messages`/row state after both, and describe what actually fired.
- **Operator booking route shape:**
  `POST /operator/reservations/book/reservations` needs `date` (or
  `businessDate`) plus `time` (or `localStartMin`); `slotMin` is rejected with
  400 `missing_time` (g8). Join `Idempotency-Key` values must be at least 8
  characters.
- **Roles:** the `G14-Host`/`G14-Viewer` custom roles created in an earlier
  round are gone (local D1 has only `admin` and `user`), although the member
  users `host_cross_g14`/`viewer_g14` still exist. A restricted operator must be
  created fresh (role preset → invite → TOTP code → signup) or the grant
  behaviour must be proven with narrowed tokens and the substitution stated.

## Runtime findings (guest-channels round, batches C–G and the g2b retest)

- **The App report builder filters its catalog with staffing grants only.**
  `catalogForGrants(fullCatalog, staff.subjects)` in
  `apps/app/app/routes/_app+/$orgSlug_+/reports+/new.tsx:35`, `_index.tsx:38`
  and `$reportId.tsx:48` hides the `bookings` and `waitlist_entries` subjects
  even for an admin whose minted reports token lists both (b7,
  `VAL-REPORT-014`). A fix touches all three routes, not just the builder.
- **Staff availability ignores special days.** With the day marked
  `closed`/`online_closed`, `GET /operator/reservations/book/availability` still
  returned 141 slots and `POST /operator/reservations/book/reservations` created
  a reservation on the closed day (201), while public availability answered
  `closed` (g4, `VAL-ONLINE-007`). The App booking sheet therefore offers closed
  days (`VAL-CROSS-007`).
- **Staff availability ignores `max_parties` pacing, but the staff _write_ path
  enforces it.** The availability read offered the slot past the limit; the
  second booking answered `409` (g4). Do not "fix" a 409 in a write test by
  assuming availability lied — check `rsv_pacing_rules` for the service (acme
  seeds lunch `max_parties 6`, dinner `8`, brunch `7` per 15-minute bucket,
  channel `all`).
- **Staff availability is hold-blind.** With a live guest hold on the slot the
  operator availability endpoint still returns `available:true` with
  `suggestedTableIds`, unscoped and area-scoped (g14, `VAL-CROSS-009`). The
  staff day feed does list live holds and the booking write path does respect
  them (`rsv-booking-service.ts` passes `engineHolds` into `assignTables`), so
  the gap is confined to the availability read.
- **Operator block creation 409s when the block overlaps existing
  reservations.** `POST /operator/reservations/setup/blocks` (area block over
  Main Dining, 2026-10-21 17:30–19:00) answered
  `409 {"error":"conflict","message":"Failed query: insert into \"rsv_table_occupancies\" …"}`
  and persisted nothing (checked `rsv_blocks`). Fallback that works: occupy the
  tables with staff bookings — a combo dies when either member table is
  occupied.
- **Recipe: force a slot down to a single unit** (used to re-test
  `VAL-ONLINE-016`). For party 8 at acme the only fitting units are `G10-T1..T4`
  (max 8), `G10-T5/T6/T11/T12` (max 12), `acme_m6` (max 8) and the combos
  `cmb_acme_m3_m4` / `cmb_acme_p2_p3` (max 8). Block or occupy all but one (7
  staff bookings at 17:30/17:45 fit inside dinner pacing `max_parties 8`), let
  the guest hold take the last table, then create the staff booking on it with
  `overbook: true`; the guest conversion then answers `409 slot_unavailable`
  with `alternatives.sameDay` / `alternatives.otherDates`.
- **Useful acme shapes:** `rsv_table_occupancies` columns are `kind` / `hold_id`
  / `reservation_id` (not `owner_kind`/`owner_id`); guests carry `phone_e164`
  (no `phone`); reservations use `local_start_min` (no `start_min`);
  `rsv_blocks` targets a `table_id` **or** an `area_id` (exactly one, CHECK
  enforced); the public availability body lists only available slots (no
  per-slot `available` flag) with `dayVersion`, `settingsVersion`, `timeZone`
  and `now`.
- **Node restart group (g13)** stopped and restarted both tenant-api nodes to
  exercise the kill switches and restored them; health and flags were
  re-verified afterwards. Message-settings writes remain serialized work (batch
  B note).
- **Left-behind state on 2026-10-21** (the g2/g2b owned date): lunch 12:00–13:00
  party-8/2 leftovers from earlier groups, online booking 13:15 (online/web p2),
  native bookings 13:30 (ios) and 13:45 (android), and an evening party-8 block:
  `G10-T1..T4` at 17:30, `G10-T5/T6/T11` at 17:45, `acme_m6` + `acme_p2/p3` at
  17:30 and a staff overbook on `G10-T12` at 17:30. A future round needing a
  clean 17:30 slot should use another date or other areas.
- **Round result:** 181 assertions tested by 21 flow groups → 175 pass, 6 fail
  (VAL-ONLINE-007, VAL-CROSS-007, VAL-CROSS-009, VAL-CROSS-011, VAL-MSG-009,
  VAL-REPORT-014). The four assertions an earlier batch left `blocked` on the
  shared `book_ip` bucket (VAL-ONLINE-013/014/016/040) were re-tested with a
  private `X-Forwarded-For` identity and pass. Synthesis:
  `validation/guest-channels-and-crm/user-testing/synthesis.json`.

---

# Round: guest-channels-and-crm user testing, ROUND 2 (re-test after fixes)

This block is the round guidance for the round-2 re-run. Everything above still
applies (surfaces, login recipes, token minting, mock transports, message/email
capture, data isolation rules, App/Sites quirks). Round-1 flow reports live in
`validation/guest-channels-and-crm/user-testing/flows/`; round-2 reports use
`r2-*` file names in the same directory.

## Scope of round 2

Re-test **only** these six assertions, after the fixes in `gcc-ut-fix-backend`
(commit `af7ffb5a`) and `gcc-ut-fix-ui` (commit `c043ba8f`, HEAD):

| Assertion      | Round-1 failure                                                       | Fixed in     |
| -------------- | --------------------------------------------------------------------- | ------------ |
| VAL-ONLINE-007 | Operator availability/booking ignored special days                    | backend + UI |
| VAL-CROSS-007  | App booking sheet offered/booked a closed day; pacing warning missing | backend + UI |
| VAL-CROSS-009  | Operator availability was hold-blind                                  | backend + UI |
| VAL-CROSS-011  | Manage link in messages used the App origin (404)                     | backend      |
| VAL-MSG-009    | Same manage-link origin defect                                        | backend      |
| VAL-REPORT-014 | Report builder offered neither `bookings` nor `waitlist_entries`      | UI           |

Plus quick regressions (reported, not assertion-tracked): public booking
end-to-end through the API, public large-party requests, operator availability
on a normal day, and the two extra backend fixes in the same commit (uniform
`slot_unavailable` instead of a raw query error; typed `409 block_conflict`).

**Do not re-open VAL-ONLINE-015 and VAL-ONLINE-032** — their contract-literal
deviations were accepted in round 1 and are recorded as passed.

## Environment state at the start of round 2 (verified by the validator)

- Services started through `services.yaml`: `tenant-api-us` 3007,
  `tenant-api-ksa` 3009, `app` 3001 (`VITE_DIRECT_DEV=1`), `sites` 3008. All
  healthchecks pass (App warm; Sites `/` and `/reserve` 200 for
  `acme.menuza.test`). **Admin 3005 is NOT started** (no platform-fee assertion
  in scope).
- `rsv_rate_counters` was cleared in **both** tenant DBs at round start (all
  buckets, round-1 precedent). Browser sessions cannot set `X-Forwarded-For`, so
  they share the durable `book_ip` (20/day), `holds_ip` (10/10 min),
  `requests_ip` (5/10 min) buckets with every other browser validator: do public
  writes early and keep them minimal. curl groups must give themselves a private
  identity: `-H 'X-Forwarded-For: 10.<group>.<n>.1'` (the durable limiter takes
  the **last** XFF entry as the client identity).
- **The manage-link fix is confirmed working at the API level.** The parent
  created a public booking on **2026-11-24 19:00** (party 2, confirmation
  `5VWKMSJX`, email `rsv-parent-smoke@example.com`) and the captured
  confirmation email carries
  `http://acme.menuza.test:3008/reserve/manage#t=<manage token>` — the Sites
  origin, not `localhost:3001`. Treat that booking as parent leftover; do not
  reuse the email address or the date.
- Flags: `reservations.enabled/.online/.waitlist/.experiences/.payments/.voice`
  are all `true` for `acme` and `riyadh-grill` in local D1 (plus extra keys
  earlier sessions set). Do not flip them this round.
- Leftover state to leave alone: the **five future special days** on acme
  (`closed` 2026-10-29, `closed` 2026-11-02, `online_closed` 2026-11-03,
  `modified` 2026-11-04, `replace` 2026-11-05), the table blocks on
  2026-10-25/28/30, the seeded areas/tables/services/combos, seeded 2026-10-16
  reservations and the
  `R2*`/`R3*`/`G*`/`CXKM9CAP`/`J6XNSYC9`/`GKTX0QAT`/`P765YM89` rows from earlier
  rounds.
- acme location `v17plv08r5v357bie335lyq8` settings before round 2:
  `hold_minutes 7`, `large_party_mode request`, `guest_modify_cutoff_min 120`,
  `online_party_max 8`, `day_start_min 240`, `horizon_days 60`, tz
  `America/New_York`. **Re-read before changing; restore what you change.**
- Pacing rules (acme, seeded): lunch `max_covers 20 / max_parties 6`, dinner
  `28 / 8`, brunch `22 / 7`, per 15-minute bucket, channel `all`.
- Useful shapes: `rsv_special_days` uses `from_date`/`to_date` (not `date`),
  `rsv_tables` uses `min_covers`/`max_covers`, `rsv_pacing_rules` has
  `from_min`/`to_min`/`bucket_min`/`max_covers`/`max_parties`/`channel`,
  `rsv_service_availability` is `(service_id, table_id, mode)`.

## Data isolation registry for round 2

| Group            | Surface                   | Owned acme business date(s)                                                             | Owned phone / email prefix              |
| ---------------- | ------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| r2-backend-rules | curl + sqlite             | `closed` 2026-11-18, `online_closed` 2026-11-19, hold 2026-11-20                        | `+155555540x` / `rsv-r2a-n@example.com` |
| r2-app-sheet     | browser + curl            | 2026-11-23                                                                              | `+155555541x` / `rsv-r2b-n@example.com` |
| r2-manage-links  | browser + curl + terminal | 2026-10-18 (tomorrow)                                                                   | `+155555542x` / `rsv-r2c-n@example.com` |
| r2-reports-ui    | browser + curl            | —                                                                                       | `+155555543x` / `rsv-r2d-n@example.com` |
| r2-regress       | curl                      | booking 2026-11-25, block probe 2026-11-25, request 2026-11-21, availability 2026-11-22 | `+155555544x` / `rsv-r2e-n@example.com` |

## Serial and interference rules for round 2

- **r2-backend-rules owns**: acme special days on 2026-11-18/19 and
  `hold_minutes` (leave it at 3 only for the hold test, restore 7).
- **r2-app-sheet owns**: acme special days on 2026-11-23, one 4-top table's
  dinner `service_availability` (`staff_only`) and one dinner `rsv_pacing_rules`
  row (`max_parties=1`, channel `all`). Restore all three before finishing. It
  runs in its own batch (batch B) so its pacing rule cannot starve another
  group's dinner bookings.
- **r2-manage-links owns** 2026-10-18: nobody else touches that date.
- No group changes org flags, message settings, quiet hours or the seeded rows
  this round.
- The per-org write lock serializes writes; contention shows as latency. A
  transient 429/404 while another group holds a flag off is not a defect (no
  group holds flags off this round).

## Flow Validator Guidance: agent-browser (round 2)

- One session per validator: `agent-browser --session cf9b643b8455__<group>`
  (for example `cf9b643b8455__r2b`). **Close it when you finish.** At most 2
  browser sessions run in batch A; batch B runs 1.
- App `http://localhost:3001` (login `kody` / `KodyLovesYou!2026` by opening
  `/login`; cookie banner harmless). Sites `http://acme.menuza.test:3008` (in
  `/etc/hosts`); for `riyadh-grill` add
  `--args "--host-resolver-rules=MAP *.menuza.test [::1]"` at launch.
- First load of an App route can take 30-66 s (Vite on-demand compile); reload a
  page with no interactive elements or an "Invalid hook call". Never wait for
  network idle.
- Judge document status codes from the **document** request in the network
  capture (single fetch emits `<path>.data` XHRs; a `.data` redirect answers
  202).
- Screenshots/snapshots to absolute paths under
  `{missionDir}/evidence/guest-channels-and-crm/<group>/`, named after the
  assertion id.
- Booking sheet: slot buttons are addressed by minute testid
  (`booking-slot-1140` = 19:00). Native `<select>` needs `agent-browser select`;
  a React-controlled input needs the native setter + `input` event (`fill ""`
  does not clear it).
- Guest Sites pages call tenant-api directly (`http://localhost:3007`); the page
  exposes it as `document.documentElement.dataset.tenantApiUrl`. Sites SSR never
  renders guest data.

## Flow Validator Guidance: curl (round 2)

- Ports: tenant-api US `http://localhost:3007`, KSA `http://localhost:3009`, App
  `http://localhost:3001`. Start nothing.
- Public routes need `-H 'Origin: http://acme.menuza.test:3008'` (KSA:
  `http://riyadh-grill.menuza.test:3008` against 3009), plus your private
  `-H 'X-Forwarded-For: 10.<group>.<n>.1'`.
- Operator tokens:
  `TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book|setup|guests|reports|payments [--grants a,b|--locations <id>|--secret wrong|--ttl 3600])`.
  Never echo a token value; describe it (`<book token>`).
- Internal token: read `INTERNAL_COMMAND_TOKEN` from `apps/app/.dev.vars`; tick:
  `curl -s -H "Authorization: Bearer $INTERNAL" -H 'Content-Type: application/json' -d '{"orgId":"t58bgatqh3rv0s3movrecyj1"}' http://localhost:3007/api/reservations/tick`.
- Public bodies: `POST /reservations/holds` =
  `{locationId, slot:{date, localMin, partySize}, areaPref?, website: ""}`;
  `POST /reservations` =
  `{holdToken, guest:{firstName,lastName,phone,email}, smsOptIn, locale, website: ""}`
  with an `Idempotency-Key` (≥ 8 chars); `POST /reservations/requests` =
  `{locationId, slot, guest, ...}`. Turnstile is off locally; the honeypot
  `website` must be empty.
- Capture `curl -si` when the assertion names response headers or shapes. Save
  trimmed output under your evidence directory.

## Flow Validator Guidance: terminal (round 2)

- Read-only SQLite (`sqlite3 <db> "SELECT ..."`), `CI=true` for any Vitest you
  run for your own assertion, no App build/typecheck/lint/full gate. At most 1
  terminal run at a time this round.
- Never print a secret. Record every exact command, its exit code and the
  observed lines.

## Round-2 concurrency plan

| Batch | Groups                                                                         | Concurrency                                                |
| ----- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| A     | r2-manage-links, r2-reports-ui (browser) · r2-backend-rules, r2-regress (curl) | 2 browsers + 2 curl                                        |
| B     | r2-app-sheet (browser + curl)                                                  | 1 browser, alone (owns pacing/service-availability writes) |

Batch A curl groups may start before the browser groups are warm. Batch B starts
only after every batch-A group has reported.

## Round 2 results and runtime findings

Round 2 re-tested the six round-1 failures plus regressions: **5 of 6 assertions
pass, 1 fails** (VAL-CROSS-007). Five groups in two batches. Reports:
`validation/guest-channels-and-crm/user-testing/flows/r2-*.json`; evidence under
`evidence/guest-channels-and-crm/r2-*/`. Round-1 synthesis preserved as
`synthesis-round1.json`.

| Assertion      | Result            | Key evidence                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-ONLINE-007 | **pass**          | closed day: public `closed`/0 slots, operator 0 slots + `dayState.state='closed'`; online_closed: public 0 slots, operator 141 slots + `onlineClosed`; staff booking 409 `closed_day` (no driver text) / 201 with `warnings:[{code:'closed_day'}]` on override; special days deleted, both dates back to 28 slots |
| VAL-CROSS-007  | **fail** (step 2) | Steps 1/3/4/5 fixed (sheet closed-day alert + disabled submit, override path, staff_only 4-top: public p4 17 -> 0, staff p4 19; pacing bucket hidden from Sites, 409 + warning + toast on override) but the Sites page kept the pre-change 36 chips after the first special-day change on a fresh date            |
| VAL-CROSS-009  | **pass**          | live hold: operator availability `available:false, held:true, heldTableIds:[...]`, held table withheld; second guest hold 409 `slot_unavailable`; after release/expiry both channels offer the slot again and the newest hold row is `expired` with inactive occupancies                                          |
| VAL-CROSS-011  | **pass**          | 5/5 checkpoints: Sites booking 54F1K1PN, confirmation + modification + cancellation_restaurant emails, one SMS with the manage link, manage page (confirmed/modified/cancelled), `.ics` 200, operator history with the guest `modified` event, 19:00 and 20:00 released                                           |
| VAL-MSG-009    | **pass**          | the captured email's manage link is `http://acme.menuza.test:3008/reserve/manage#t=<token>` (Sites origin), opens in a fresh anonymous session with first name/date/party/status, token only in the fragment, `.ics` summary/start match                                                                          |
| VAL-REPORT-014 | **pass**          | kody's builder lists 15 subjects including Bookings and Waitlist entries (and both run); the fresh restricted operator (`r2d_restricted`, role "R2D Reports no reservation") lists 10 with neither, and their token subjects = ["phone_calls"]                                                                    |

### The round-2 defect: the availability ETag does not change on the first mutation of a never-mutated date (VAL-CROSS-007)

`GET /reservations/availability` answers
`ETag: "<dayVersion>.<settingsVersion>.<flagBits>"` with
`Cache-Control: private, max-age=0`. `readDayVersion` returns 1 when
`rsv_day_versions` has no row for the date
(`apps/tenant-api/src/services/rsv-public-engine.ts:438-454`), and the first
write for that date **inserts version 1**
(`apps/tenant-api/src/services/rsv-setup-crud.ts:111-132`) instead of bumping,
so the ETag is identical before and after the first change. A client that
already cached the day revalidates with `If-None-Match` and gets **304**, so it
keeps the stale body. Reproduce (parent-verified on 2026-11-26, then restored):

```bash
# 1. baseline (date never mutated): note the ETag
curl -s -D - -o /tmp/a.json -H 'Origin: http://acme.menuza.test:3008' -H 'X-Forwarded-For: 10.99.2.1' \
  'http://localhost:3007/reservations/availability?locationId=v17plv08r5v357bie335lyq8&date=2026-11-26&partySize=2'
# 2. close the day (setup token) via POST /operator/reservations/setup/special-days {"businessDate":"2026-11-26","kind":"closed",...}
# 3. replay the cached ETag -> 304 while a fresh fetch answers {"status":"closed","slots":[]}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: http://acme.menuza.test:3008' -H 'X-Forwarded-For: 10.99.2.1' \
  -H 'If-None-Match: "1.68.11"' 'http://localhost:3007/reservations/availability?...'
# 4. delete the special day -> version 2 -> ETag "2.68.11"
```

A **staff booking** on a fresh date has the same effect (2026-11-27: ETag
`"1.68.11"` before and after the 201, replay 304, `rsv_day_versions` still 1),
so this also covers the "after any booking ... new ETag" clause of
VAL-ONLINE-002. The Sites `/reserve` page's default-cache fetch is what renders
the stale chips; an in-page `fetch(..., {cache:'no-store'})` shows the correct
state. When a future round re-tests this, judge the guest channel by the Sites
page after a plain reload (that is the user-visible behavior), and keep the curl
replay as the mechanism proof.

### Other round-2 findings worth reusing

- **The manage-link fix is real**: confirmation emails and SMS now carry the
  Sites origin (`http://acme.menuza.test:3008/reserve/manage#t=...`);
  `resolveSitesOrigin`
  (`apps/app/app/utils/reservations/sites-origin.server.ts`) returns the local
  Sites host for a localhost `BASE_URL`.
- **The restricted-operator recipe in this file is stale**: `Verification` has
  no `code` column any more. Read the onboarding code from the App dev email
  capture instead (`http://localhost:3001/mock-email`,
  `GET /mock-email/dev/messages?to=<email>`), and note that signup **rejects
  hyphens in usernames** (`r2d_restricted`, not `r2d-restricted`).
- **There is no `GET /operator/reservations/book/requests` route**: the operator
  requests list is the day feed filtered to `pending_approval`.
- **Operator writes need `Idempotency-Key`**:
  `POST /operator/reservations/book/reservations` (and its `/status` cancel)
  answer `400 missing_idempotency_key` without it.
- **The App's service-availability screen has no bulk path** (one row per
  create/delete); a fixture needing many mode rows is faster through the setup
  API with a setup token.
- **Pacing warnings**: the operator availability payload's `pacingWarning` still
  reflects only `maxCovers` (`rsv-day-feed-service.ts:1500-1504`), so a
  `max_parties`-only breach shows no pre-submit warning; the write path refuses
  with 409 `pacing_parties_exceeded` and the explicit override returns 201 with
  a `warnings` array plus the toast "Booked over the pacing party limit.".
- **Round-2 leftover rows** (all inert; keep or reuse): parent smoke booking
  `5VWKMSJX` on 2026-11-24 19:00 (party 2, `rsv-parent-smoke@example.com`); r2a
  bookings `U2EB35` (2026-11-18) and `LS76UD` (2026-11-19) plus the archived
  `R2A-Area`/`R2A-T1`; r2b five cancelled R2B reservations on 2026-11-23; r2c
  booking `S87XKRY9` on 2026-10-18 20:00; r2d restricted operator
  `rsv-r2d-1@example.com` / `r2d_restricted` with role "R2D Reports no
  reservation" and the saved report "R2D Bookings subject check"; r2e declined
  requests on 2026-11-21 and cancelled bookings on 2026-11-22/25; parent probe
  rows on 2026-11-26 (day version 2) and 2026-11-27 (cancelled `rsv_e4126c6e`).

---

# Round: guest-channels-and-crm user testing, ROUND 3 (re-test after `gcc-ut-fix-round2`)

This block is the round guidance for the round-3 re-run. Everything above still
applies (surfaces, login recipes, token minting, mock transports, data isolation
rules, App/Sites quirks). Round-3 flow reports use `r3-*` file names in
`validation/guest-channels-and-crm/user-testing/flows/`.

## Scope of round 3

Exactly **two** assertions, both affected by the round-2 fix (commit
`d8b41f4e`):

| Assertion      | Why it is re-tested                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VAL-CROSS-007  | Round 2 failed step 2: after the **first** mutation of a never-mutated business date, the Sites guest channel kept serving stale availability from its HTTP cache (ETag unchanged). Round 3 re-runs the whole 5-step journey, with the guest check done as a **plain reload of `/reserve` after warming the cache** (no devtools cache disable, no `cache:'no-store'` bypass). |
| VAL-ONLINE-002 | Only the **ETag clause** is in scope: `If-None-Match` replay -> 304, and "after any booking is made on that date the same conditional request returns 200 with a new ETag". The slot/header shape clauses passed in round 1.                                                                                                                                                   |

Everything else in this milestone passed in rounds 1-2 and must **not** be
re-run. Do not re-open VAL-ONLINE-015 / VAL-ONLINE-032 (contract-literal
deviations accepted in round 1).

## The fix under test (commit `d8b41f4e`)

- `readDayVersion` (`apps/tenant-api/src/services/rsv-public-engine.ts`) now
  returns **0** when `rsv_day_versions` has no row for the date (it returned 1
  before), and the first write inserts version 1, so the public ETag
  `"<dayVersion>.<settingsVersion>.<flagBits>"` moves on the first write
  (`"0.68.11"` -> `"1.68.11"`).
- Pacing and service-availability writes call `bumpBookingHorizonDayVersions`,
  which bumps **every** bookable date in the horizon. An ETag cached before such
  a write is invalidated for all dates.
- Operator availability now also evaluates `max_parties` for `pacingWarning`
  (`findOperatorPacingBreaches` + `evaluatePacing` in
  `rsv-day-feed-service.ts`).

Parent-verified baseline (2026-10-17, read-only): fresh dates have no
`rsv_day_versions` row and answer `ETag: "0.68.11"` / `dayVersion: 0`
(2026-12-03 -> 28 slots for party 2; 2026-11-29 -> 36 slots).

## Environment state at the start of round 3 (verified by the validator)

- Services started through `services.yaml`: `tenant-api-us` 3007, `app` 3001
  (`VITE_DIRECT_DEV=1`), `sites` 3008. All three healthchecks pass.
  **`tenant-api-ksa` 3009 and Admin 3005 are NOT started** - nothing in scope
  needs them.
- All `reservations.*` flags are `true` for `acme` (org
  `t58bgatqh3rv0s3movrecyj1`) in local D1. Do **not** flip flags this round.
- `rsv_rate_counters` was cleared for acme at round start (test-environment
  reset, round-2 precedent). Browsers cannot set `X-Forwarded-For`, so browser
  validators share the durable `book_ip` (20/day) / `holds_ip` (10/10 min) /
  `requests_ip` (5/10 min) buckets: keep public writes minimal and early.
- acme primary location `v17plv08r5v357bie335lyq8`, `settingsVersion` 68 at
  round start. Live holds expire in `hold_minutes` (7); guest modify cutoff 120;
  online party max 8; horizon 60 days; tz `America/New_York`. **Re-read before
  you change anything; restore what you change.**
- Leftover future special days (leave alone): `closed` 2026-10-29, `closed`
  2026-11-02, `online_closed` 2026-11-03, `modified` 2026-11-04, `replace`
  2026-11-05.
- Baseline `rsv_pacing_rules`: the three seeded `pace_acme_*` rows plus the
  inert `pac_7cb22b19-002d-414b-9359-70bcda8a78ea` (service
  `srv_c8a12a46-4926-4c37-b409-ac0486d10677`, `max_covers 12 / max_parties 6`).
  Baseline `rsv_service_availability`: 6 rows (2 `online`, 1 `staff_only`, 1
  `unavailable`, 2 `walk_in_only`). Leave all baseline rows alone.
- `rsv_special_days` uses `from_date`/`to_date` (not `date`); `rsv_tables` uses
  `label`/`min_covers`/`max_covers`; `rsv_service_availability` is
  `(service_id, table_id, area_id, mode)`.

## Data isolation registry for round 3

| Group       | Surface        | Owned acme business date                                                      | Owned phone / email prefix              |
| ----------- | -------------- | ----------------------------------------------------------------------------- | --------------------------------------- |
| r3-etag-api | curl           | 2026-11-29 (booking clause); 2026-11-28 only if a second fresh date is needed | `+155555545x` / `rsv-r3a-n@example.com` |
| r3-cross007 | browser + curl | 2026-12-03                                                                    | `+155555546x` / `rsv-r3b-n@example.com` |

Both dates have **no `rsv_day_versions` row** for the primary location (verify
read-only before you start) and no special day/block. That is what makes the
first-write ETag behaviour observable. If either date has acquired a version row
before your test starts (another group or a parent probe touched it), say so in
the report and pick another fresh future date inside the 60-day horizon.

## Serial and interference rules for round 3

- **Batch A = `r3-etag-api` alone; batch B = `r3-cross007` alone.** They must
  not overlap: `r3-cross007` changes pacing and service availability, and those
  writes bump every bookable date's version (`bumpBookingHorizonDayVersions`),
  which would invalidate `r3-etag-api`'s cached ETag mid-test.
- **`r3-cross007` owns**: acme special days on 2026-12-03, one dinner
  `rsv_service_availability` row, and one dinner `rsv_pacing_rules` row. Delete
  all three before finishing and re-verify that Sites and the public API are
  back to the baseline for that date.
- **`r3-etag-api` owns** 2026-11-29 (and optionally 2026-11-28). Nobody else
  touches those dates.
- No group changes org flags, message settings, quiet hours, location settings
  or the seeded rows. curl groups must give themselves a private identity with
  `-H 'X-Forwarded-For: 10.<group>.<n>.1'` (the durable limiter takes the
  **last** XFF entry).

## Flow Validator Guidance: agent-browser (round 3)

- One session per validator: `agent-browser --session 54c29399a486__r3b`.
  **Close it when you finish.**
- App `http://localhost:3001` (login `kody` / `KodyLovesYou!2026` by opening
  `/login` directly; never log out to switch users). Sites
  `http://acme.menuza.test:3008` (in `/etc/hosts`).
- First load of an App route can take 30-66 s (Vite on-demand compile); reload a
  page with no interactive elements or an "Invalid hook call". Never wait for
  network idle (the notifications SSE stream stays open).
- Judge document status codes from the **document** request in the network
  capture (single fetch emits `<path>.data` XHRs; a `.data` redirect answers
  202).
- Screenshots/snapshots to absolute paths under
  `/home/factory-user/.factory/missions/165ab51b-48a5-4632-8938-101be7ea8500/evidence/guest-channels-and-crm/r3-cross007/`,
  named after the assertion id and step.
- Booking sheet: slot buttons are addressed by minute testid
  (`booking-slot-1140` = 19:00). Native `<select>` needs `agent-browser select`;
  a React-controlled input needs the native setter + `input` event (`fill ""`
  does not clear it).
- Sites `/reserve` inputs are React-controlled (same native-setter recipe;
  re-verify the date value after each change). Guest pages call tenant-api
  directly (`http://localhost:3007`), exposed as
  `document.documentElement.dataset.tenantApiUrl`.
- **The warmed-cache guest check is the heart of round 3.** Load `/reserve` for
  the test date and confirm the time chips are rendered _before_ the change,
  then change the special day through the App UI, then **plain-reload**
  `/reserve` (no cache bypass, no devtools "disable cache", no
  `cache:'no-store'` in an in-page fetch) and confirm the closed note appears
  and the chips are gone. Record from the network capture: the availability URL,
  the request's `If-None-Match` header (if any), the response status (must be
  **200**, not 304) and the `ETag` before and after. A 304 + stale chips is the
  round-2 failure; do not paper over it with a cache-bypassing fetch - if the
  plain reload is stale, the assertion fails.

## Flow Validator Guidance: curl (round 3)

- Ports: tenant-api US `http://localhost:3007`, App `http://localhost:3001`.
  Start nothing.
- Public routes need `-H 'Origin: http://acme.menuza.test:3008'` plus your
  private `-H 'X-Forwarded-For: 10.<group>.<n>.1'`.
- Operator tokens:
  `TOKEN=$(node /tmp/menuza-user-testing/mint-token.mjs --org acme --scope book|setup|guests|reports|payments [--grants a,b|--locations <id>|--secret wrong|--ttl 3600])`.
  Never echo a token value; describe it (`<book token>`).
- Internal token: read `INTERNAL_COMMAND_TOKEN` from `apps/app/.dev.vars`; tick:
  `curl -s -H "Authorization: Bearer $INTERNAL" -H 'Content-Type: application/json' -d '{"orgId":"t58bgatqh3rv0s3movrecyj1"}' http://localhost:3007/api/reservations/tick`.
- Public bodies: `POST /reservations/holds` =
  `{locationId, slot:{date, localMin, partySize}, areaPref?, website: ""}`;
  `POST /reservations` =
  `{holdToken, guest:{firstName,lastName,phone,email}, smsOptIn, locale, website: ""}`
  with an `Idempotency-Key` (>= 8 chars); `POST /reservations/requests` =
  `{locationId, slot, guest, ...}`. Turnstile is off locally; the honeypot
  `website` must be empty.
- Always capture `curl -si` when the assertion names response headers (`ETag`,
  `Cache-Control`). Always copy the returned `ETag` string exactly (including
  the quotes) into `If-None-Match`.
- Operator writes need an `Idempotency-Key` (>= 8 chars), except where the
  contract says `expectedVersion` only.

## Flow Validator Guidance: terminal (round 3)

- Read-only SQLite (`sqlite3 <db> "SELECT ..."`), `CI=true` for any Vitest you
  run for your own assertion, no App build/typecheck/lint/full gate. At most 1
  terminal run at a time this round.
- Never print a secret. Record every exact command, its exit code and the
  observed lines.

## Round-3 concurrency plan

| Batch | Group       | Surface                            | Concurrency      |
| ----- | ----------- | ---------------------------------- | ---------------- |
| A     | r3-etag-api | curl                               | alone            |
| B     | r3-cross007 | agent-browser (App + Sites) + curl | 1 browser, alone |

Batch B starts only after batch A has reported (the horizon-wide version bump).

## Round 3 results and runtime findings

Round 3 re-tested exactly two assertions against commit `d8b41f4e`: **both
pass** (VAL-CROSS-007 and VAL-ONLINE-002's ETag clause). Two groups, two serial
batches. Reports:
`validation/guest-channels-and-crm/user-testing/flows/r3-etag-api.json`,
`flows/r3-cross007.json`; evidence under
`evidence/guest-channels-and-crm/r3-*/`. The round-2 synthesis is preserved as
`synthesis-round2.json` and the round-3 synthesis is `synthesis.json`.

| Assertion                    | Result   | Key evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAL-ONLINE-002 (ETag clause) | **pass** | 2026-11-29 was never mutated (0 `rsv_day_versions` rows, `dayVersion 0`, ETag `"0.68.11"`, 36 grid slots); exact-ETag replay -> **304** empty body; one hold + one booking (201/201, `4X3EQ144`) -> old ETag replayed -> **200 with `"2.68.11"`** and the capacity change visible in the slot set; new ETag -> 304; sqlite shows the version row and the booking                                                                                                                                                                                                                                                                                                                                         |
| VAL-CROSS-007 (all 5 steps)  | **pass** | 2026-12-03 baseline 28 slots/`"0.68.11"`; `online_closed` as the **first** write -> day version 1, ETag `"1.68.11"`, Sites plain reload 200 + closed note + **zero stale chips**, curl replay of the pre-change ETag -> **200** with the new body (round 2: 304 + stale), operator 141 slots `online_closed`, App Book 201; `closed` -> Sites/API closed 0 slots, operator 0 slots, sheet alert + disabled submit, 409 `closed_day` / 201 + warning on override; `staff_only` T4 -> public p4 15 -> 0, public p2 16 unchanged, operator p4 19; pacing `max_parties=1` -> Sites drops the bucket, operator `available:false / pacingWarning:true` (newly fixed), 409 / 201 + warnings + toast on override |

Verified fix behaviour (useful for future rounds):

- `readDayVersion` reads "no row" as 0 and the first write inserts version 1, so
  the first mutation of a fresh date moves the ETag. **A hold is itself a
  versioned write**, so hold + booking ends at version 2 (not 1).
- **The warmed browser did not revalidate**: in this session agent-browser's
  Chrome re-fetched on a plain reload (no `If-None-Match`, no 304 anywhere), so
  a plain reload alone cannot distinguish "the fix works" from "the browser
  never cached". The mechanism proof for the round-2 defect path is the **curl
  replay of the pre-change ETag** (now 200 + new body) plus a labelled in-page
  default-cache fetch (not a bypass).
- On an `online_closed` day the **operator** availability returns the full slot
  list with `dayState.state: "online_closed"` (staff unaffected); 0 slots is the
  **`closed`** day's value.
- Operator availability now reports `available:false` / `pacingWarning:true` for
  a `max_parties`-only breach, and the App booking sheet renders the `*` marker
  plus the pacing alert. The sheet **auto-ticks "Override slot pacing cap"**
  when a pacing-full slot is selected, so the refusal run must untick it first.
  On a `replace` day the operator read still lists slots for every location
  service, not only the resolved ones (known quirk) - select the fixture service
  by name.
- Sites `/reserve` deep-links `?date=&party=` are the reload-safe path; plain
  field changes do not update the URL.

Environment left by round 3: `r3-cross007` restored everything (special day
deleted, 9 availability rows + pacing rule deleted, 4 bookings cancelled);
parent re-verified 0 special days >= 2026-12-01, 6 availability rows, 4 pacing
rules, and 2026-12-03 back to 28 slots (`ETag "33.68.11"`). Inert leftovers:
batch A's booking `4X3EQ144` on 2026-11-29 (guest `rsv-r3a-1@example.com`, day
version 2), the batch-B cancelled reservations and guest rows
(`rsv-r3b-1/2/3/5@example.com`), and the audit/version rows both groups
generated.
