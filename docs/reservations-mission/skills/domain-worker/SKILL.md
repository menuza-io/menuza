---
name: domain-worker
description:
  Builds the pure TypeScript domain packages (@repo/zoned-time,
  @repo/reservations) - time math, config schemas, availability engine, table
  assignment, state machine, policy and message math, API schemas and error
  codes - test-first, with fast-check property tests against a brute-force
  oracle and DST tests.
---

# Domain worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- Vitest for all tests. fast-check (`^4.3.0`, devDependency of the package) for
  property tests, checked against a deliberately simple brute-force oracle
  written in the test folder.
- No browser tools: this worker's output has no UI.
- References: `architecture.md` (domain package API, invariants, engine budgets,
  error codes), `library/engine-notes.md` (algorithms, oracle design, what to
  test), `library/opentable-reference.md` (meaning of statuses, pacing, turns,
  special days), `library/staffing-patterns.md` (how `@repo/staffing` is laid
  out; mirror its package.json, tsconfig, vitest config, exports and barrel
  files).

## Work Procedure

1. **Understand the feature.** Read the feature's description, expectedBehavior
   and every assertion in its `fulfills` list (`validation-contract.md`). Read
   the matching `architecture.md` sections (domain package API, invariants,
   budgets, error codes) and `library/engine-notes.md`. Write down the exact
   functions, types and error codes you will add, and how each assertion will be
   proven.
2. **Inspect what you are mirroring or moving.** For new packages, copy the
   shape of `packages/staffing` (package.json scripts `typecheck`/`test`,
   `exports` pointing at source `.ts`, tsconfig, vitest config). When moving
   code (for example `packages/staffing/src/tz.ts` into `@repo/zoned-time`),
   move it unchanged and keep a re-export at the old path so every importer
   still compiles.
3. **Write failing tests first**, and run them to confirm they fail for the
   right reason:
   - Example-based tests for every expectedBehavior and every error code,
     including edge cases named in the contract.
   - Property tests (fast-check) against the brute-force oracle for engine work:
     execute random operation sequences (`search`, `hold`, `book`, `modify`,
     `cancel`, `seat`, `finish`, `no_show`, `block`, `settings`, `clock`) and
     verify all canonical invariants I1 through I8 (`architecture.md` §1.2)
     after every step: (I1) seating witness — every capacity-consuming
     reservation has active occupancy rows on concrete tables/combo covering
     `[start_at, end_at)`, or `overbooked = 1`, or a table-less Experience cap;
     (I2) no double booking — no two active non-overbook occupancies on the same
     table overlap, and party size / combinable bounds hold; (I3) online never
     borrows — guest-channel availability never uses capacity created by a staff
     overbook; (I4) holds count — a live hold consumes capacity like a booking
     and an expired hold consumes nothing; (I5) locked never moves — no
     automatic process (repair, reflow) moves a `locked` assignment or any
     reservation that has arrived (`partially_arrived`/`arrived`), is
     seated/finished (`partially_seated`/`seated`/`finished`), or is inside
     `freeze_min`; (I6) atomic modify — a failed modification leaves the
     reservation and its occupancies unchanged; (I7) search/book agreement — any
     slot returned by a search can be held immediately against the same state
     and clock; (I8) monotonic release — cancelling, finishing, releasing, or
     shrinking a reservation never decreases availability. In your handoff, map
     each invariant I1–I8 to the exact oracle function/line and per-step test
     assertion that proves it. Use the approved scale (up to 120 tables, 80
     combinations, 900 bookings per day) in at least one property, with
     `numRuns` and a fixed seed that keep the package suite under about 60
     seconds.
   - Budget tests: the engine stops at the approved expansion budgets (search
     200 per slot, book 2,000, reflow 5,000) and returns `'no_fit'` /
     `budgetExhausted` rather than partial plans when exhausted (and a
     successful reflow in scale tests has `unresolvable.length === 0`).
   - DST tests for `America/New_York`, `America/Los_Angeles`, `Europe/London`
     and `Asia/Riyadh`: spring-forward gaps (`2027-03-14` NY/LA, `2027-03-28`
     London, `gap: 'skip'` returning `null` vs `gap: 'after'`), fall-back
     overlaps (`2026-11-01` NY/LA, `2026-10-25` London,
     `overlap: 'earlier' | 'later'`, 90-min fold), `day_start_min ± 1` boundary
     transitions, services that cross midnight, release times on DST days.
4. **Implement the smallest pure code that passes.** No I/O, no network, no
   database, no `Date.now()` or `Math.random()` inside domain functions (inject
   `now` and any seed), no UI strings (return codes, not sentences). Business
   date plus local start minute is the source of truth for a booking's time; use
   `@repo/zoned-time` for every conversion.
5. **Keep the public API and return types exactly as `architecture.md` and
   `validation-contract.md` name them.** Export through the package entry
   points. Never silently alter function signatures, option parameters, or
   return types specified in `validation-contract.md`; if any minor adaptation
   is needed, support the exact contract signature and record any details in the
   handoff.
6. **Harden property tests.** Run the property suite with several random seeds
   once (temporarily remove the fixed seed or loop over seeds) to shake out real
   bugs, fix what they find, then restore the fixed seed. Record the seeds you
   tried.
7. **Check consumers.** If you changed an export that tenant-api, App or Sites
   already import, typecheck those workspaces too. When moving code out of
   `@repo/staffing`, run the full staffing suite, including
   `packages/staffing/src/vocabulary.test.ts`.
8. **Programmatic verification (approved worker scoping), then commit:**
   - `CI=true npm run test -w @repo/reservations` (and `-w @repo/zoned-time`,
     `-w @repo/staffing` when touched).
   - `npx turbo run typecheck --filter=<each changed package>`; add
     `--filter=tenant-api`, `--filter=sites` or the App typecheck
     (`commands.typecheck_app`, 6 GB heap, never at the same time as App ESLint)
     only when you changed something they import.
   - `commands.lint_oxc`.
   - `commands.clean_generated`, review `git status` and `git diff --stat`, then
     commit (`feat(reservations): ...`).

## Example Handoff

```json
{
	"salientSummary": "Implemented the availability engine in @repo/reservations (slot search, pacing per 15-minute window and per service, turn times by party size, alternatives ranked by distance) test-first; 64 example tests and 7 fast-check properties against the brute-force oracle pass (`CI=true npm run test -w @repo/reservations`, 41 s), and typecheck plus oxlint are clean.",
	"whatWasImplemented": "packages/reservations/src/engine/availability.ts: searchAvailability(dayState, request, { now, budget }) returning { slots, alternatives, budgetExhausted }. Pacing (covers and parties per window, per service caps) in engine/pacing.ts; turn-time resolution (party-size bands with service overrides) in engine/turn-times.ts; alternatives (same day +/-90 min, then next 3 days with the same service) in engine/alternatives.ts; calendarSummary(range) in engine/calendar.ts. Live holds consume capacity until expiresAt; expired holds are ignored. Staff-overbooked occupancy is excluded from online capacity. Expansion counter enforces the 200-per-slot search budget and sets budgetExhausted. Error codes RSV_PARTY_TOO_LARGE, RSV_OUTSIDE_HORIZON, RSV_BEFORE_MIN_NOTICE and RSV_SERVICE_CLOSED added to errors.ts and exported. No I/O; now is injected.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd packages/reservations && CI=true npx vitest run src/engine",
				"exitCode": 1,
				"observation": "Before implementation: 64 failing (searchAvailability is not a function), as expected."
			},
			{
				"command": "CI=true npm run test -w @repo/reservations",
				"exitCode": 0,
				"observation": "12 files, 171 tests passed in 41 s, including 7 properties (numRuns 200, seed 4242) at 120 tables / 80 combinations / 900 bookings."
			},
			{
				"command": "for s in 1 7 99 2024 31337; do FC_SEED=$s CI=true npx vitest run src/engine/availability.property.test.ts; done",
				"exitCode": 0,
				"observation": "All 5 seeds pass. Seed 99 first exposed a pacing window off-by-one at 23:45 on a service crossing midnight; fixed and covered by an example test."
			},
			{
				"command": "npx turbo run typecheck --filter=@repo/reservations --filter=@repo/zoned-time",
				"exitCode": 0,
				"observation": "2 tasks successful."
			},
			{
				"command": "npm run lint:oxc",
				"exitCode": 0,
				"observation": "0 errors (19 pre-existing warnings, none in packages/reservations)."
			},
			{
				"command": "bash .../scripts/clean-generated.sh",
				"exitCode": 0,
				"observation": "Only packages/reservations changes remain staged."
			}
		],
		"interactiveChecks": []
	},
	"tests": {
		"added": [
			{
				"file": "packages/reservations/src/engine/availability.test.ts",
				"cases": [
					{
						"name": "returns slots on the booking grid within the service window",
						"description": "A 15-minute grid with a 17:00-22:00 service yields 17:00..21:15 for a 105-minute turn."
					},
					{
						"name": "respects minimum notice and same-day cutoff",
						"description": "Slots earlier than now + minNotice are excluded; after the cutoff the day returns RSV_BEFORE_MIN_NOTICE."
					},
					{
						"name": "live hold consumes capacity, expired hold does not",
						"description": "The same request sees one fewer table while a hold is live and the full set one second after expiresAt."
					},
					{
						"name": "excludes staff-overbooked capacity from online search",
						"description": "An overbooked occupancy on table T4 never makes T4 or its combinations available online."
					}
				]
			},
			{
				"file": "packages/reservations/src/engine/availability.property.test.ts",
				"cases": [
					{
						"name": "matches the brute-force oracle",
						"description": "For random day states up to 120 tables / 80 combinations / 900 bookings, the set of bookable slots equals the oracle's."
					},
					{
						"name": "every returned slot can be held",
						"description": "Holding any returned slot immediately succeeds in the oracle model."
					}
				]
			},
			{
				"file": "packages/reservations/src/engine/dst.test.ts",
				"cases": [
					{
						"name": "spring-forward gap in America/New_York has no 02:xx slots",
						"description": "On 2026-03-08 the grid skips the nonexistent hour and turn times stay 105 real minutes."
					},
					{
						"name": "Asia/Riyadh has no DST shifts",
						"description": "Slots on the US DST dates are unchanged for a Riyadh location."
					}
				]
			}
		]
	},
	"discoveredIssues": [
		{
			"severity": "low",
			"description": "architecture.md names the calendar function calendarSummary but the API schema section calls the response CalendarDays; implemented calendarSummary returning CalendarDays.",
			"suggestedFix": "Align the two names in architecture.md."
		}
	]
}
```

## When to Return to Orchestrator

- The architecture's API or invariants are contradictory, or an invariant cannot
  hold with the specified data model (for example a property fails against a
  correct oracle because the rules allow it).
- An engine budget cannot be met without changing the algorithm described in
  `architecture.md`.
- Moving code out of `@repo/staffing` would change staffing behavior or break
  its vocabulary test.
- The feature needs I/O, persistence or a dependency other than fast-check.
