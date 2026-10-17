# Mission guidance: Reservations module

Operational rules for every worker and validator in this mission. Read this file
fully at the start of every session. The repository's `AGENTS.md` and
`apps/app/AGENTS.md` also apply; where they conflict with this file, this file
wins for this mission.

Where to find things:

- Scope and decisions: `mission.md`. Design (authoritative): `architecture.md`.
  Acceptance: `validation-contract.md`.
- Commands and services: `services.yaml` (the only source of commands). Session
  setup: `init.sh`.
- Reference knowledge: `library/` (`environment.md`, `user-testing.md`,
  `staffing-patterns.md`, `engine-notes.md`, `opentable-reference.md`,
  `app-ui-patterns.md`, `sites-patterns.md`, `payments-reference.md`,
  `payment-mocks.md`, `integrations-reference.md`, `native-reference.md`). Raw
  research: `research/` (read only when a library file points there).

## Mission Boundaries (NEVER VIOLATE)

**Repository and git**

- Work only in `/home/factory-user/repos/menuza` on branch `pr/reservations`.
  Commit your feature's changes there.
- Never push, deploy, or change git identity or config. Never touch the
  `upstream` remote or the `feat/resy-reservation-integration` branch.
- Never rewrite or discard commits or uncommitted work you did not create in
  this session: no `git reset --hard`, `git clean`, `git stash drop`, rebases,
  or checkouts over someone else's changes.

**Ports:** only 3001 (App), 3005 (Admin), 3007 (tenant-api US), 3008 (Sites),
3009 (tenant-api KSA), 3101 (Playwright's App server) and 24678/24679 (vite
HMR). Never start services on other ports. Never run root `npm run dev` (it
kills every dev port and starts all apps).

**External services:** no real payment, email or SMS providers, and never add
real API keys. Payments use the local emulators (milestone `payment-mocks`),
email uses the dev capture (milestone `guest-messages`), SMS uses `[SMS MOCK]`
log lines. No live phone calls.

**Off-limits actions**

- Never run `.agents/setup`, `node scripts/write-ci-app-env.mjs` or `db:reset`.
  Never delete `apps/app/.wrangler/state`, `packages/database/db/*.db` or tenant
  DB files.
- Never edit `apps/app/.env`, `apps/app/.dev.vars` or `apps/admin/.env`. A new
  env var must have a safe default in its Varlock schema or in code, so local
  dev works without editing `.env` files. If a feature truly needs a local
  `.env` change, return to the orchestrator.
- Never kill processes you did not start, and never use broad `pkill` patterns.
  Stop services with the `stop` commands in `services.yaml`.

**Resources (4 CPUs, 7.9 GB RAM)**

- Never run the App typecheck and App ESLint at the same time (about 3.4 GB and
  4.1 GB).
- Never run the App build or the App typecheck alongside 3 or more browser
  sessions.
- Native builds run one at a time; stop the Gradle daemon afterwards
  (`commands.android_stop_gradle`).
- Do not run the full milestone gate (`commands.test`, about 12 minutes) as a
  session baseline. Baseline with the scoped commands for the area you will
  touch.
- Stop every service, browser session and test process you started before you
  end your session.

Workers: if you cannot complete your work within these boundaries, return to the
orchestrator. Never violate them.

## Mission Directives

**Tools**

- `agent-browser` for every manual check of a web UI (App, Sites, Admin). `curl`
  for tenant-api routes.
- Vitest (with Testing Library for components) for unit and integration tests.
  fast-check for property tests in `@repo/reservations`.
- Playwright for App e2e specs, with tenant-api stubbed the way the staffing
  specs do it (see `library/app-ui-patterns.md`).
- Gradle scripts in `apps/android` and SwiftPM in `apps/ios` for native work
  (`services.yaml` native commands).

**Skills**

- Invoke the `agent-browser` skill before any browser-based verification.
- Read the repo's project guides that match your area before coding:
  `docs/skills/project-tenant-data/SKILL.md` (regional data),
  `project-permissions`, `project-security`, `project-testing`,
  `project-database`, `project-routing`, `project-react-patterns`,
  `project-forms`, `project-ui-guidelines` (App UI), `project-public-sites`
  (Sites), `project-payments-commerce` (payments), `project-email-marketing`
  (messages, journeys), `project-integrations`, `project-jobs-observability`
  (ticks, cron), `project-mobile` (native).

**Dependencies**

- Use libraries already in the repo (see `library/app-ui-patterns.md` for UI
  libraries such as drag and drop and charts). The only approved new dependency
  is `fast-check` (`^4.3.0`, devDependency) in new packages. Adding any other
  third-party dependency requires returning to the orchestrator first.
- New workspace packages: `@repo/zoned-time`, `@repo/reservations`, and any
  reservations-named restaurant adapter named in `architecture.md`. After
  creating a workspace package run `commands.install` and commit the resulting
  `package-lock.json` change (that change is intended).
- Payments use the existing Stripe SDK and Checkout.com SDK already used by
  online ordering, pointed at the local emulators.

**Other rules**

- **Test-driven:** write a failing test first for new behavior and bug fixes,
  then implement.
- **Residency:** guest PII (names, phones, emails, notes, allergies, tags) lives
  only in the regional tenant DB. Never put it in the control plane, logs,
  cross-plane payloads, Sites SSR, App loaders or dashboard server loaders.
  Cross-plane payloads carry ids, counts, amounts and non-personal configuration
  only. Validation errors never echo rejected values.
- **Flags:** everything user-visible is behind the reservations flags
  (`architecture.md`): `reservations.enabled`, `reservations.online`,
  `reservations.waitlist`, `reservations.payments`, `reservations.experiences`,
  `reservations.voice` (plus system/org `reservations.platform_fee_bp`). Only a
  literal `true` turns a flag on, and child flags count only while
  `reservations.enabled` is on. Enforce at token mint and in every loader and
  action; tenant-api enforces child flags through the token's `features` claim.
- **Canonical vocabulary:** the 8 permissions are `read:reservation:any`,
  `update:reservation:any`, `read:reservation_guest:any`,
  `update:reservation_guest:any`, `read:reservation_settings:any`,
  `update:reservation_settings:any`, `read:reservation_report:any`,
  `update:reservation_payment:any`. Operator JWTs use `typ: 'rsv+jwt'`,
  `aud: 'tenant-api-reservations-operator'`, and claims `orgId`, `region`,
  `scope`, `grants`, `locationIds`, `features`, `impersonated`. Internal App <->
  tenant-api routes authenticate with
  `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`. Always match
  `validation-contract.md` and `architecture.md` verbatim.
- **Security gates:** every new tenant-api reservations route (operator and
  public) is added to `apps/tenant-api/src/routes/reservations-security.test.ts`
  and swept across every mounted route for: missing token (401), forged secret
  (401), wrong audience (`tenant-api-staffing` AND `tenant-api-operator`, 401),
  wrong `typ` (401), over-long TTL (`>900s` standard, `>300s`
  sensitive/impersonated, 401), grantless (403), wrong scope (403), impersonated
  write (403), cross-org (`ORG_B`, 403/404), and excluded `locationIds`
  (403/404). Every reservations route must also verify
  `organization.hasProvisionedDb` is true (returning uniform 404 when false,
  mirroring `staff-auth.ts`). Every new App reservations loader and action
  awaits `requireReservationsAccess` first and is covered by the App guards
  test. A route without both is incomplete.
- **Write path:** every reservation write AND every setup/config mutation
  (including `operator-reservations-setup.ts`, `rsv-setup-crud.ts`, and
  `rsv-setup-service.ts`) goes through `withReservationWrite` so multi-row saves
  (such as `saveFloorPlan` and combo/block updates) execute inside a serialized
  per-org transaction. Every versioned operator mutation (location settings,
  floor-plan save, reservation edits/status/notes/assign, service notes) sends
  and checks `expectedVersion` (returning 409 `stale_version` on mismatch). Use
  the stable error codes from `@repo/reservations`. Status transitions whose
  contract has no `expectedVersion` (for example large-party approve/decline)
  are guarded by a status precondition (409 `invalid_status_transition`)
  instead; do not add `expectedVersion` to them.
- **Honest handoffs:** if you could not perform a skill step (a surface
  unreachable, a live check skipped, tests written after code), say so in
  `skillFeedback.deviations` and state what you substituted.
  `followedProcedure: true` with no deviations means every step was done as
  written.
- **Time & timers:** the business date plus the local start minute is the source
  of truth. Use `@repo/zoned-time` helpers; never hand-roll time-zone math. Live
  elapsed/remaining timers (`useLiveNow`) tick every 15 seconds
  (`intervalMs: 15_000`), and polling cadences follow `architecture.md`
  (Floor/Today/Waitlist 5 s, Book/Timeline 10 s, Calendar/Overview 60 s),
  pausing or preserving dirty form state while modals, detail sheets
  (`?r=<id>`), or drag operations are active.
- **i18n:** every user-visible string goes through Lingui — including option
  label arrays (weekdays, shapes, element kinds, occasions, dietary chips,
  course/contact stages, section colors), enum badges, and `aria-live`
  screen-reader announcements (`check-lingui.mjs` only checks extracted messages
  and cannot detect un-wrapped English literals!). App and Admin: fill `en` and
  real `ar` translations. Sites: fill all six locales (en, ar, es, fr, de, zh).
  Run the extract command for each app you changed, fill every non-source
  `msgstr`, stage the `.po` files with the source change, and run
  `commands.lingui_check` before committing. Right-to-left layouts mirror the
  interface but never floor geometry, times or numbers.
- **Design system:** use `@repo/ui` primitives (Base UI; `render` prop, not
  `asChild`) and theme tokens. No new App ESLint errors
  (`commands.lint_app_files` on your changed files, or
  `commands.lint_app_gate`).
- **Restaurant-specific paths:** reservations code lives in reservations-named
  paths (plus `restaurant/` adapters) so it can be excluded from upstream
  template syncs as a unit. Keep restaurant words out of generic packages: the
  `@repo/staffing` vocabulary test must stay green, and `@repo/phone-agent`
  stays generic.
- **Migrations:** tenant migrations continue after `0015`
  (`0016_reservations_foundation.sql`, then the additive migrations named in
  `architecture.md`). Control-plane migrations start at `0025`. Never edit a
  migration an earlier feature committed unless an orchestrator-approved fix
  feature explicitly requires an in-place trigger/constraint correction on the
  current branch; when doing so (or in `seed:reservations`), refresh the
  affected triggers/objects in every existing local tenant DB across both
  `TENANT_DB_DIR` roots (`packages/database/db/tenant_*.db` and
  `packages/database/db/ksa/tenant_*.db`) and verify `sqlite_master`. Apply
  control-plane migrations locally with `commands.migrate_control_plane`.
- **Out of scope** (do not build): POS integration, Reserve with Google, two-way
  SMS, the Expo app, a diner marketplace, loyalty points, gift cards, the
  background re-optimizer, free-form message template editing, WebSocket live
  updates.

## Conventions

- Follow the repo's TypeScript, import-order, naming and component conventions
  (repo `AGENTS.md`). Zod for every input.
- `@repo/reservations` stays pure: no I/O, no UI strings, no provider calls.
- tenant-api mirrors the staffing structure (services plus routes, tests beside
  them; `library/staffing-patterns.md`).
- App routes, utilities and components follow the route map and paths in
  `architecture.md`. The operator browser calls tenant-api directly with the
  short-lived token; App loaders never fetch or return guest data.
- Sites client modules call tenant-api directly from the browser; Sites SSR
  never renders or proxies guest data.
- Comments only where the reason is not obvious from the code.
- Commits: `feat(reservations): <description>` (or `fix(...)`, `test(...)`,
  `docs(...)`), scoped to your feature. Before each commit run
  `commands.clean_generated`; never commit formatting-only `src/env.ts` diffs,
  unrelated `package-lock.json` drift, `test-results/` or `playwright-report/`.
  The pre-commit hook (lint-staged and the Lingui check) must pass; use
  `--no-verify` only when the hook cannot pass for a reason outside your change,
  after running lint, typecheck and `commands.lingui_check` yourself, and say
  why in the commit message.

## Operational notes

- `init.sh` runs at session start: it re-adds the Linux ESLint bindings when
  missing, warns about unlinked workspace packages and lockfile drift, and
  cleans `env.ts` formatting noise.
- Start only the services your verification needs, using `services.yaml`. A warm
  App start takes about 69 s; the first start after any `npm install` can take
  about 15 minutes. Do not reinstall dependencies unless your feature adds one.
- Service logs: `/tmp/menuza-logs/<service>.log`. Gate logs:
  `/tmp/menuza-gate/`.
- Toolchain env vars are not in the shell profile; every native command in
  `services.yaml` exports them inline.
- `@repo/security` and `@repo/observability` are consumed from `dist`; rebuild
  after changing them (`commands.build_dist_package`).
- Local flags for manual checks: `commands.set_org_flag <org> <key> <value>`
  (writes local D1 and, when present, `data.db`).

## Testing & Validation Guidance

Instructions for validators. Validators must follow these.

- Use `library/user-testing.md` for surfaces, bootstrap steps, data isolation
  and concurrency limits (at most 3 concurrent browser validators, 2 while a
  build, typecheck, lint or Playwright run is in progress; up to 4 curl
  validators; native one at a time with browsers closed).
- Operator UI: agent-browser as kody on `acme` (US) and `riyadh-grill` (KSA).
  Guest UI: agent-browser on Sites, acme in English and riyadh-grill in Arabic.
  Admin only for the platform fee.
- Turn reservations flags on per org with `commands.set_org_flag` before UI
  checks, and turn child flags off when an assertion checks gating.
- Messages are validated through the mock transports only: `[SMS MOCK]` log
  lines and the dev email capture. Payments are validated through the local
  emulators and their mock hosted pages, never real providers.
- Phone agent: tool tests and tenant-api API calls only. No live calls.
- Native apps: Gradle and Swift commands only. The user checks screens on
  devices; do not fail native assertions for the absence of device UI checks.
- Admin saves the platform fee to `data.db` while App dev reads local D1.
  Copying the value into D1 before checking amounts is an expected local step,
  not a defect.
- The 59 App ESLint errors in menu files are pre-existing and out of scope.
- Validators do not modify product code. Report defects with evidence.
- Start the App on 3001 before any tick-based message check. When tenant-api
  cannot reach the App for flags, it holds due messages for 10 minutes and the
  tick reports `flags_unknown`.
- Dev email capture to `apps/tenant-api/.dev-mail/{us,ksa}` only works when
  tenant-api runs from the current `services.yaml` start commands. Restart nodes
  started by older sessions before checking captured mail.
- Operator-created bookings are email-only (no SMS opt-in on the host form). SMS
  checks use public bookings with `smsOptIn`.

## Known Pre-Existing Issues (Do Not Fix)

- App ESLint reports 59 design-system errors in six menu files (baseline for the
  lint gate).
- Logging out and back in lands on `/_.data` (404). Use a new browser session
  and open `/login`.
- No role grants `read:analytics:any` (repo known issue).
- The pre-commit ESLint step checks nothing; run workspace lint yourself.
- The tenant-api test log line `ERR_JWT_CLAIM_VALIDATION_FAILED` is expected
  output from a negative test.
