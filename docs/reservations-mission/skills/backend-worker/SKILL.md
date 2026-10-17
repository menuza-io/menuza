---
name: backend-worker
description:
  Builds server-side reservations work with no UI - tenant-db migrations and
  triggers, tenant-api operator/public/internal/voice routes and services, the
  regional tick and messages, control-plane migrations and permissions, App
  token mint and App resource routes, jobs-cron, report subjects, staffing
  demand sources, journey triggers and phone-agent actions - test-first, with
  the security sweep, real-SQLite concurrency tests and curl checks against the
  running tenant-api.
---

# Backend worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- Vitest (tenant-api, tenant-db, App and package suites). Real SQLite files for
  concurrency tests, the way staffing tests do it.
- `curl` against the running tenant-api (US 3007, KSA 3009) for manual
  verification. `sqlite3` and `npx wrangler d1 execute DB --local` to inspect
  databases.
- `agent-browser` (invoke the skill first) only when the feature has an App-side
  effect you must observe in a browser, such as an operator token used by an
  existing screen.
- References: `architecture.md` (data model, routes, write path, tick, messages,
  payments responsibilities, security gates, env vars),
  `library/staffing-patterns.md` (the staffing files to mirror),
  `library/integrations-reference.md` (phone agent, staffing forecast, journeys,
  reports), `library/payments-reference.md` (regional payment state only;
  provider calls belong to the App), `library/opentable-reference.md`
  (semantics), repo guides `docs/skills/project-tenant-data`,
  `project-security`, `project-permissions`, `project-database`,
  `project-testing`, `project-jobs-observability`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, and the matching `architecture.md` sections. List each route
   or service with its request and response shapes, error codes, flags and token
   scopes, and the tables it reads and writes.
2. **Find the staffing equivalent and mirror it**
   (`library/staffing-patterns.md`): route registration, token verification and
   guard, service layout, transactions, outbox, tick hooks, tests and seed
   scripts. Keep reservations code in reservations-named files.
3. **Write failing tests first** and run them to see them fail:
   - Tenant DB: schema tests for new tables, constraints and indexes; trigger
     tests (table-overlap trigger, append-only triggers, hold-converts-once
     trigger) that prove the database itself rejects bad writes.
   - Services: behavior tests on real SQLite files, including concurrency (two
     parallel bookings for the last table: exactly one wins; idempotent replay
     returns the first result; a stale `expectedVersion` gets the conflict code
     and changes nothing).
   - Routes: happy paths, Zod validation errors that never echo rejected values,
     uniform 404s, child-flag refusal through the token's `features` claim, rate
     limits where specified.
   - Security sweep: add every new operator and public route to
     `apps/tenant-api/src/routes/reservations-security.test.ts` (every operator
     route swept in the per-route loop for missing token, forged secret,
     wrong-audience including both `tenant-api-staffing` and
     `tenant-api-operator`, wrong `typ`, over-long TTL, grantless, wrong-scope,
     impersonated-write on mutations, cross-organization `ORG_B`, and excluded
     `locationIds`, plus active-but-unprovisioned org `hasProvisionedDb = false`
     returning 404; for public routes, missing or unknown Origin and invalid
     capability tokens).
   - App server code (token mint, `/resources/reservations/*`,
     `/resources/sites/*`): `requireInternalCommandAuth` (or the documented
     auth) first, flag and permission enforcement at mint, ids-only payloads.
4. **Implement.**
   - Migrations: add a new numbered file; never edit a committed migration
     unless an orchestrator-approved fix feature explicitly directs an in-place
     trigger/constraint correction on the current branch. When any trigger or
     hand-appended SQL in `0016_reservations_foundation.sql` is updated (or when
     `seed:reservations` runs), refresh the affected triggers in every existing
     local tenant DB across BOTH roots (`packages/database/db/tenant_*.db` and
     `packages/database/db/ksa/tenant_*.db`) and verify with a read-only
     `sqlite_master` query. Tenant migrations continue after `0015`;
     control-plane after `0024`. Mirror permission strings wherever
     `architecture.md` says (for example `ORG_PERMISSIONS`, `setup-roles.ts`).
   - Every reservation write AND every setup/config mutation goes through
     `withReservationWrite` (lock, busy retry, one transaction: sweep,
     idempotency, reload and re-validate with the engine, write rows, events and
     messages, bump `day_version`). Messages are enqueued inside the transaction
     and sent after commit.
   - Residency: guest PII stays in the tenant DB. Cross-plane calls and outbox
     rows carry ids, counts, amounts and non-personal config only. Logs never
     contain names, phones, emails, notes or tokens.
   - Kill switches and env vars exactly as named in `architecture.md`, with safe
     defaults so local dev needs no `.env` edits.
5. **Apply and inspect migrations.** Control-plane:
   `commands.migrate_control_plane`, then check the new rows in both `data.db`
   (`sqlite3`) and local D1 (`wrangler d1 execute`). Tenant: start tenant-api
   and make a request so the org's database migrates; inspect it with `sqlite3`.
6. **Verify against the running server with curl.** Start `tenant-api-us` (and
   `tenant-api-ksa` for regional behavior) from `services.yaml`; run
   `commands.seed_reservations_acme` when the feature needs data. Exercise every
   expectedBehavior, including refusals (bad token, wrong Origin, stale version,
   out-of-range 400 bounds, rate limit, kill switch). Record each request
   (method, path, key headers without secrets) and the status and key fields of
   the response. For operator routes, use a real token captured from the App
   (see `library/user-testing.md`) or the test helpers.
7. **Seed and docs.** Extend `seed:reservations` when the feature adds
   demo-relevant data (idempotent, through the same services as the API). Note
   that `scripts/seed-reservations.ts` is outside
   `apps/tenant-api/tsconfig.json` and Drizzle ignores unknown column keys —
   always verify seeded field values (not just row counts) with `sqlite3`
   against `packages/tenant-db/src/schema.ts` column names. Update the docs the
   feature names.
8. **Stop what you started** (services by process group, any test watchers).
9. **Programmatic verification (approved worker scoping), then commit:**
   - Targeted Vitest files for what you changed
     (`commands.test_files_tenant_api` / `test_files_app` / `test_workspace`),
     then the whole suite of each changed workspace that is cheap
     (`@repo/tenant-db`, `@repo/reservations`, other packages) and
     `commands.test_tenant_api` (about 95 s or more) whenever tenant-api
     changed. Run `commands.test_app` (about 7.5 min, alone) only when App
     server code changed broadly; otherwise run the affected App test files.
   - Typecheck each changed workspace (`commands.typecheck_workspace`); the App
     typecheck (`commands.typecheck_app`) only when App files changed, never at
     the same time as App ESLint.
   - `commands.lint_oxc`; `commands.lint_app_files` on changed App files;
     `commands.lint_workspace` for changed workspaces that have a lint script.
   - `commands.lingui_check` if you touched any user-visible string.
   - `commands.clean_generated`, review `git status` and the staged diff (no
     PII, no secrets, no lockfile drift), then commit.

## Example Handoff

```json
{
	"salientSummary": "Built the public hold and book endpoints (POST /reservations/holds, POST /reservations/bookings) with Origin-resolved org, honeypot, in-memory plus durable rate limits, idempotency keys and HMAC capability tokens stored as hashes; tenant-api suite (1,612 tests) and the security sweep pass, and curl against :3007 and :3009 confirmed 201/409/404/429/503 paths.",
	"whatWasImplemented": "apps/tenant-api/src/routes/reservations-public.ts registers POST /reservations/holds and POST /reservations/bookings (POST-only, X-Client recorded as channel). Org resolved from Origin via the existing sites-origin resolver; unknown Origin returns the uniform 404 body. services/rsv-public-booking-service.ts: createHold runs in withReservationWrite (sweep, idempotency check on Idempotency-Key, engine re-validation, rsv_holds insert with 7-minute expiresAt, day_version bump) and returns { holdId, expiresAt, now, holdToken }; book converts a live hold exactly once (trigger-backed), creates/links the guest, enqueues the confirmation message inside the transaction and returns { reservationId, manageToken, status }. Tokens are HMAC-SHA256 capability tokens; only their hashes are stored (rsv_capability_tokens). Durable limits in rsv_rate_counters: 10 holds/min per IP hash, 60/min per org. RESERVATIONS_PUBLIC_ENABLED=false answers 503 on every /reservations/* route. Seed: seed:reservations now creates two demo holds-turned-bookings for tomorrow.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-public.test.ts src/services/rsv-public-booking-service.test.ts",
				"exitCode": 1,
				"observation": "Before implementation: 27 failing as expected (routes return 404)."
			},
			{
				"command": "cd apps/tenant-api && CI=true npx vitest run src/services/rsv-public-booking-service.concurrency.test.ts",
				"exitCode": 0,
				"observation": "20 parallel holds for the last 2-top on a real SQLite file: exactly 1 succeeds, 19 get 409 RSV_SLOT_UNAVAILABLE; replay with the same Idempotency-Key returns the original holdId."
			},
			{
				"command": "CI=true npm run test -w tenant-api",
				"exitCode": 0,
				"observation": "84 files, 1,612 tests passed in 118 s, including reservations-security.test.ts with both new routes in the public sweep (missing Origin, unknown Origin, forged hold token, expired hold, cross-org token)."
			},
			{
				"command": "curl -s -X POST localhost:3007/reservations/holds -H 'Origin: http://acme.menuza.test:3008' -H 'Idempotency-Key: k1' -H 'Content-Type: application/json' -d '{\"locationId\":\"main\",\"date\":\"2026-10-20\",\"time\":\"19:00\",\"partySize\":2}'",
				"exitCode": 0,
				"observation": "201 with holdId, expiresAt = now + 420 s, holdToken present; repeating with Idempotency-Key k1 returned the same holdId."
			},
			{
				"command": "curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3007/reservations/holds -H 'Origin: http://unknown.menuza.test:3008' ...",
				"exitCode": 0,
				"observation": "404 with the same body as an unknown route."
			},
			{
				"command": "for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:3007/reservations/holds ...; done",
				"exitCode": 0,
				"observation": "201 x10 then 429 x2; after restarting tenant-api-us the next request is still 429 (durable counter)."
			},
			{
				"command": "RESERVATIONS_PUBLIC_ENABLED=false (restart tenant-api-us) then curl POST /reservations/holds",
				"exitCode": 0,
				"observation": "503 on holds, bookings and config; restarted normally afterwards."
			},
			{
				"command": "curl -s -X POST localhost:3009/reservations/holds -H 'Origin: http://riyadh-grill.menuza.test:3008' ...",
				"exitCode": 0,
				"observation": "201 on the KSA node; the hold row exists only in packages/database/db/ksa/tenant_ru0dm42cud9scs4g2duep21c.db."
			},
			{
				"command": "npx turbo run typecheck --filter=tenant-api --filter=@repo/tenant-db --filter=@repo/reservations",
				"exitCode": 0,
				"observation": "3 tasks successful."
			},
			{
				"command": "npm run lint:oxc",
				"exitCode": 0,
				"observation": "0 errors."
			},
			{
				"command": "bash .../scripts/clean-generated.sh",
				"exitCode": 0,
				"observation": "Only feature files staged; no env.ts or lockfile changes."
			}
		],
		"interactiveChecks": []
	},
	"tests": {
		"added": [
			{
				"file": "apps/tenant-api/src/routes/reservations-public.test.ts",
				"cases": [
					{
						"name": "creates a hold with expiresAt and server now",
						"description": "201 returns holdId, expiresAt 7 minutes after now, and a hold token whose hash is stored."
					},
					{
						"name": "unknown Origin gets the uniform 404",
						"description": "Body and headers match a nonexistent route."
					},
					{
						"name": "honeypot field filled returns a fake success without writing",
						"description": "No rsv_holds row is created."
					},
					{
						"name": "validation errors do not echo input",
						"description": "A 400 for an invalid phone lists the field name only."
					}
				]
			},
			{
				"file": "apps/tenant-api/src/services/rsv-public-booking-service.concurrency.test.ts",
				"cases": [
					{
						"name": "last table race has exactly one winner",
						"description": "20 concurrent holds on one remaining table produce one hold and 19 RSV_SLOT_UNAVAILABLE."
					},
					{
						"name": "hold converts to a booking only once",
						"description": "Two concurrent book calls with the same hold: one 201, one 409 RSV_HOLD_CONSUMED."
					}
				]
			}
		]
	},
	"discoveredIssues": [
		{
			"severity": "medium",
			"description": "The existing sites-origin resolver lowercases the host but keeps a trailing dot, so 'acme.menuza.test.:3008' resolves to acme.",
			"suggestedFix": "Strip a trailing dot in the shared resolver (affects careers apply too); add a test."
		}
	]
}
```

## When to Return to Orchestrator

- A route, table or contract shape needed by the feature is missing from
  `architecture.md`, or the architecture contradicts the validation contract.
- An earlier feature's migration or route is wrong and fixing it requires
  editing a committed migration.
- The feature would need guest PII in the control plane, in logs, or in a
  cross-plane payload.
- A tenant DB reports schema drift ("table already exists", missing migrations)
  that is not caused by your feature.
- tenant-api or App cannot start or stay healthy with the `services.yaml`
  commands.
