# Reservations mission plan

This folder is a snapshot of the multi-agent mission that built the Reservations
module on branch `pr/reservations`. It holds the plan, the acceptance contract,
the worker instructions and the validation reports. It is not product code.

The same snapshot lives in `docs/reservations-mission/` and `.factory/mission/`.

## Status

All four pending features are implemented and committed on `pr/reservations`.
The mission is **not closed**: the 175 assertions stay `pending` in
`validation-state.json`, because the formal scrutiny and user-testing validators
were not run (no browser login on the dev machine). `validation-state.json`
carries two extra fields per pending assertion: `implementedAtCommit` and
`verification` (`tests-cite-id` when a test file cites the id,
`no-id-tagged-test` otherwise). That is a lower bound, not a verdict: many tests
cover an assertion without citing its id. The per-assertion test files are in
`validation/payments-integrations-and-native/evidence.json`.

| Milestone                          | State                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `foundation`                       | Validated                                                                   |
| `foh-core`                         | Validated                                                                   |
| `guest-channels-and-crm`           | Validated (scrutiny and 3 user-testing rounds)                              |
| `payments-integrations-and-native` | Implemented and unit-tested; assertions pending live validation (see below) |

### Commits since the 4-feature handover

| Commit                 | Content                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `6c8ec334`             | Hardening from a principal-engineer review (write gate, undo, guest privacy, retries, ETag)                    |
| `72032cc7`             | `payment-mocks-full-stack`                                                                                     |
| `8b544867`             | `reservation-payments-and-experiences-backend` (+ carry-overs a to e)                                          |
| `8cac7e43`             | `reservation-payments-experiences-and-integrations-ui` (+ carry-overs)                                         |
| `9947dff9`             | `native-and-docs` (iOS, Android, contract fixtures, final docs)                                                |
| `064fe45a`, `c195c48b` | UI polish: shell, host stand, settings, sheets, waitlist, guests, reports (`library/ui-design-conventions.md`) |

### What is verified

Full gate run on the final tree (after freeing disk space):

- tenant-api 2,726 passed (1 skipped); `@repo/tenant-db` 183; typecheck clean
  for tenant-api, sites, admin, jobs-cron, voice-agent, `@repo/reservations`,
  `@repo/payments`, `@repo/database`.
- Earlier green runs, unchanged since: `@repo/reservations` 142,
  `@repo/payments` 264, `@repo/staffing` 641, Sites 339, jobs-cron 96,
  voice-agent 209, phone-agent 101, phone-agent-restaurant 54,
  marketing-workflow 19.
- App: 349 of 352 test files pass. The 3 failing files (38 tests) are the
  staffing `kiosk-app`, `my-schedule-page` and `my-schedule-session` tests,
  which fail on `localStorage` because this machine runs Node 26 while the repo
  pins 22.18. They do not touch reservations. 939 reservation-area tests pass;
  App typecheck and `node scripts/check-lingui.mjs` pass.
- `@repo/database`: 1 failing test, the seed check for 0025/0026 against the
  stale `packages/database/db/data.db` (see below). The migration test itself
  passes.
- Android: 116 JVM tests, `assembleDebug`, lint (warnings only). iOS:
  `swift build`.

### Not verified (do these next)

1. **Log in.** The local D1 has no demo user, so `kody` is rejected. Importing
   the seed into local D1 is allowed only with the owner's consent (AGENTS.md);
   the recipe is in `apps/app/AGENTS.md`. Then drive the screens in a browser
   and mark assertions passed with the `user-testing` skill.
2. **Disk space.** The machine hit 100% once during this work (a 5.3 GB local
   worker trace store under `apps/app/.wrangler/state/v3/observability`); it was
   freed by the owner and the gates were re-run. Keep an eye on it.
3. **Playwright specs** (written, not run): `payment-mocks`, and the edited
   reservations specs (`reservations-setup`, `-host-stand`,
   `-waitlist-messages`, `-guestbook-reports`); they use the new `setup-group-*`
   and menu testids.
4. **Production build exclusion**:
   `npm run build:cf -w app && node scripts/check-no-payment-mocks.mjs apps/app/build`.
5. **iOS**: real `swift test` and a simulator pass (needs Xcode); **Android**:
   device pass for RTL, Keystore and the payment round trip.
6. **Live curl checks** against tenant-api (NATIVE-003, CROSS-033) and the Sites
   `/experiences` pages with a published experience.
7. Apply control-plane migration `0026` to `packages/database/db/data.db`: its
   migration journal has drifted (`JobPosting` already exists), so
   `npm run db:migrate:deploy` fails on this machine. Local D1 is migrated.

### Decisions to confirm

- Android release AAB budget raised from 220,000 to 255,000 bytes (measured
  248,389; APK 154,504 of 160,000). Reason is in
  `apps/android/size-budget.json`.
- Provider webhooks terminate at the US App, which forwards only ids and amounts
  to the regional node (documented deviation from ADR 048's first wording).
- Checkout.com guarantee charges and refunds a 100-minor verification.
- Production needs a new secret, `SITES_RESERVATION_PAYMENT_TOKEN` (App and
  Sites, 32+ chars, distinct from every other token); `scripts/launch-setup.mjs`
  does not generate it yet. Sites no longer receives `INTERNAL_COMMAND_TOKEN`.
- The busy_timeout fix for extra libsql connections was reverted (it blocks the
  event loop); see `docs/reservations.md` Known issues.
- The root `esbuild` override (`^0.28.1`) breaks Admin dev (Vite 6) on a fresh
  install; locally worked around in `apps/admin/node_modules` only.
- `AGENTS.md` still names `app.epic-startup.test`; this machine uses
  `https://app.menuza.test:2999`.

Known issues that were reviewed and not fixed are listed in
`docs/reservations.md` (Known issues).

## What is here

| Path                     | Purpose                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mission.md`             | The approved mission proposal (scope, milestones, testing strategy)                                                                  |
| `architecture.md`        | Authoritative architecture: components, data flow, invariants                                                                        |
| `validation-contract.md` | 485 `VAL-*` behavioural assertions that define "done"                                                                                |
| `validation-state.json`  | Pass/pending status of each assertion                                                                                                |
| `features.json`          | Ordered feature list. Pending features are the remaining work; each has `fulfills` (assertion ids it completes) and carry-over notes |
| `AGENTS.md`              | Mission rules for workers: boundaries, conventions, testing guidance                                                                 |
| `services.yaml`          | Commands (install, typecheck, lint, test gates) and dev services with ports                                                          |
| `init.sh`                | Idempotent environment setup run before each worker session                                                                          |
| `skills/`                | Per-worker-type procedures (backend, app-ui, sites, payments, native, docs, domain)                                                  |
| `library/`               | Accumulated knowledge: engine notes, UI/Sites patterns, user-testing recipes                                                         |
| `scripts/`               | Gate scripts (typecheck, lint, test) and helpers such as `set-org-flag.sh`                                                           |
| `research/`              | Raw research notes gathered during planning                                                                                          |
| `validation/`            | Scrutiny and user-testing synthesis reports per milestone                                                                            |
| `handoffs/`              | Worker handoff records (what each worker did, verified and left open)                                                                |

Not included: screenshots and HAR evidence (212 MB), worker transcripts and
runtime state.

## Paths

The files were written for a sandbox where the repository lived at
`/Users/zama/menuza` and the mission folder at
`/Users/zama/menuza/.factory/mission`. Replace those prefixes with your local
repository path and this folder when you run commands from `services.yaml` or
`scripts/`.
