---
name: app-ui-worker
description:
  Builds operator-facing screens in the App (React Router 8, @repo/ui) and the
  Admin platform-fee control - routes, loaders and actions behind
  requireReservationsAccess, browser-direct tenant-api calls with the rsv+jwt
  token, ETag polling, drag and drop, Lingui en/ar - test-first, with guards and
  component tests, a stubbed-tenant-api Playwright spec, and agent-browser
  checks on acme (US) and riyadh-grill (KSA).
---

# App UI worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- `agent-browser` skill: invoke it before any browser verification. Every App
  screen you build is checked in agent-browser.
- Vitest with Testing Library for component and utility tests; the reservations
  guards test; Playwright for App e2e specs with tenant-api stubbed (the
  staffing specs show how).
- References: `architecture.md` (access layer, route map, token, tenant-api
  route shapes, polling, flags), `library/app-ui-patterns.md` (layout,
  navigation, UI kit, libraries, i18n, Playwright patterns),
  `library/opentable-reference.md` (what each screen means to a host or
  manager), `library/staffing-patterns.md` (staffing App routes to mirror),
  `library/user-testing.md` (login, flags, data isolation), repo
  `apps/app/AGENTS.md` and guides `docs/skills/project-ui-guidelines`,
  `project-routing`, `project-react-patterns`, `project-forms`,
  `project-permissions`, `project-testing`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, the route map and access layer in `architecture.md`, and the
   tenant-api route shapes the screen uses. List each screen state you must
   handle: loading, empty, populated, validation error, version conflict (409),
   permission-limited, flag-off 404, and right-to-left.
2. **Find the staffing equivalent** (route module, token hook, tenant-api
   client, polling, toasts, sheets, tables) and mirror it. Use `@repo/ui`
   primitives (Base UI, `render` prop) and theme tokens; check
   `library/app-ui-patterns.md` for available libraries before writing your own
   drag and drop or charts.
3. **Write failing tests first:**
   - Guards: every new loader and action awaits `requireReservationsAccess`
     first with the right permission and flag; add the routes wherever the
     reservations guards test enumerates them.
   - Component and utility tests for key interactions and states (conflict
     handling reloads and explains, quick actions call the right endpoint with
     `expectedVersion`, keyboard alternatives for drag and drop, announcements
     for screen readers).
   - A Playwright spec (or an extension of the milestone's spec) for the main
     flow, with tenant-api responses stubbed.
4. **Implement.**
   - Loaders return flags, permissions, location facts and the token-mint
     context only. Guest data is fetched in the browser from tenant-api with the
     short-lived token; never fetch, return or log it on the App server.
   - Every mutation sends `expectedVersion`; on a conflict, reload the affected
     data and tell the user what changed. In local-draft editors (such as
     `floor-plan-canvas.tsx` and `detail-sheet.tsx`), never clear the `dirty`
     flag on a failed/409 save.
   - Polling with ETags at the intervals in `architecture.md`
     (Floor/Today/Waitlist 5 s, Book/Timeline 10 s, Calendar/Overview 60 s; live
     timers `useLiveNow` every `15_000` ms); pause polling during drags and
     while the detail sheet (`?r=<id>`), booking sheet, or walk-in dialog has
     unsaved edits so background polls never clobber user input.
   - All strings through Lingui — grep your touched routes and components for
     hardcoded English option tables, enum badges, and `aria-live` template
     strings before running `lingui:extract` (`check-lingui.mjs` only checks
     extracted messages); right-to-left mirrors the interface but never floor
     geometry, times or numbers.
5. **Verify in agent-browser** (the main evidence for this worker):
   - Start `tenant-api-us`, `tenant-api-ksa` and `app` from `services.yaml`
     (warm start about 69 s; after an install, poll the healthcheck for up to 20
     minutes). Seed with `commands.seed_reservations_acme` /
     `seed_reservations_ksa` and turn on the needed flags with
     `commands.set_org_flag`.
   - Log in as kody and walk every expectedBehavior on `acme`; repeat the key
     flows on `riyadh-grill` (KSA node). Check `?lng=ar`.
   - Check gating: with `reservations.enabled` off the routes return 404 and the
     sidebar group is hidden; a user without the permission cannot see or reach
     the screen.
   - Check the network: calls go from the browser straight to tenant-api with a
     Bearer token; App `.data` responses contain no guest names, phones or
     emails. Check the console for errors.
   - Take screenshots of each main state. Close your browser sessions when done.
6. **Run the Playwright spec.** Close browser sessions first (resource limits),
   then `commands.e2e_build` and `commands.e2e_spec`; for a new spec also run
   `commands.e2e_spec_repeat`.
7. **Lingui.** `commands.lingui_extract_app` (and `lingui_extract_admin` for
   Admin), fill every Arabic `msgstr` with a real translation, stage the `.po`
   files.
8. **Admin features** (the platform-fee control) follow the same steps against
   Admin on 3005: start it only for this, log in through
   `commands.copy_admin_session`, and remember Admin writes `data.db`.
9. **Stop what you started** (services, browser sessions, Playwright).
10. **Programmatic verification (approved worker scoping), then commit:**
    - When a consolidated feature includes domain (`packages/reservations`,
      `packages/zoned-time`), backend (`apps/tenant-api`, `apps/jobs-cron`,
      `packages/*`) and/or Sites (`apps/sites`) work alongside App UI: follow
      `domain-worker`, `backend-worker`, and `sites-worker` rules for those
      layers, add every new `/operator/reservations/*`, `/reservations/*`,
      `/internal/reservations/*`, and `/api/reservations/*` route to
      `apps/tenant-api/src/routes/reservations-security.test.ts` (sweeping all
      token/audience/TTL/impersonated/cross-org/location/unprovisioned
      variants), and run `CI=true npm run test -w @repo/reservations`,
      `commands.test_tenant_api`, and `commands.test_workspace` (`sites`) as
      appropriate.
    - Targeted App Vitest files (`commands.test_files_app`), including the
      guards test and your new tests. Run `commands.test_app` (about 7.5 min,
      alone) only when you changed shared App code broadly.
    - `commands.typecheck_app` (6 GB heap via
      NODE_OPTIONS=--max-old-space-size=6144; the turbo route OOMs). Then, never
      at the same time, `commands.lint_app_files` on every changed App file (no
      new errors; the 59 menu errors are pre-existing). Admin:
      `npx turbo run typecheck --filter=admin` and `commands.lint_workspace`
      with `admin`.
    - `commands.lint_oxc`, `commands.lingui_check`, and the relevant Playwright
      spec (step 6).
    - `commands.clean_generated`, review the staged diff, then commit.

## Example Handoff

```json
{
	"salientSummary": "Built the host-stand timeline (tables x time) with drag to move or reassign, resize to change duration, click-to-book on empty cells, an unassigned lane and a pacing strip, polling the day feed every 10 s with ETags and pausing during drags; guards, component and Playwright tests pass and agent-browser checks on acme and riyadh-grill (including ?lng=ar) matched every expected behavior.",
	"whatWasImplemented": "Route apps/app/app/routes/_app+/$orgSlug_+/reservations+/timeline.tsx (loader: requireReservationsAccess(read:reservation, book scope) then flags and location facts only). Components in apps/app/app/components/reservations/timeline/: TimelineGrid (virtualized rows, 15-minute columns), BookingBlock (pointer and keyboard drag via the repo's existing drag-and-drop library; Space to pick up, arrows to move, Enter to drop, Escape to cancel, live-region announcements), UnassignedLane, PacingStrip. Dropping on another table opens a choice: Assign, or Assign and lock; the PATCH sends expectedVersion and on 409 RSV_VERSION_CONFLICT reloads the day and shows 'This reservation changed. Your move was not saved.' Resize updates durationMinutes. Clicking an empty cell opens the booking sheet prefilled with table and time. Auto-rearranged soft bookings returned by the API are highlighted with a 'Moved by system' badge for 30 s. All strings extracted with Arabic translations; RTL mirrors the toolbar and labels but keeps the time axis left-to-right.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd apps/app && CI=true npx vitest run app/components/reservations/timeline app/utils/reservations/reservations-guards.test.ts",
				"exitCode": 0,
				"observation": "3 files, 38 tests passed (guards test now covers timeline loader and action)."
			},
			{
				"command": "cd apps/app && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck",
				"exitCode": 0,
				"observation": "Clean in 74 s."
			},
			{
				"command": "cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npx eslint app/routes/_app+/\\$orgSlug_+/reservations+/timeline.tsx app/components/reservations/timeline",
				"exitCode": 0,
				"observation": "0 errors, 0 warnings in changed files."
			},
			{
				"command": "npm run lingui:extract -w app && npm run lingui:check",
				"exitCode": 0,
				"observation": "14 new messages, Arabic filled, check passes."
			},
			{
				"command": "npm run build -w app && cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/reservations-host-stand.test.ts --workers=1 --reporter=line --retries=0 --repeat-each=3",
				"exitCode": 0,
				"observation": "Build 112 s; 5 tests x 3 repeats passed (drag move, lock, resize, conflict reload, keyboard move)."
			},
			{
				"command": "npm run lint:oxc",
				"exitCode": 0,
				"observation": "0 errors."
			}
		],
		"interactiveChecks": [
			{
				"action": "agent-browser: logged in as kody, set reservations.enabled true for acme, opened /acme/reservations/timeline for the seeded date",
				"observed": "Grid shows 14 tables, 9 bookings and 2 in the unassigned lane; pacing strip shows 24/30 covers at 19:00 in amber. No console errors."
			},
			{
				"action": "Dragged the 19:00 party of 4 from T3 to T7 and chose 'Assign and lock'",
				"observed": "Block moved; lock icon shown; network shows PATCH http://localhost:3007/operator/reservations/book/reservations/<id> with Bearer token and expectedVersion 3 -> 200; the next poll returned 304."
			},
			{
				"action": "Edited the same reservation in a second session, then dragged it in the first",
				"observed": "409 handled: day reloaded and the conflict message appeared; the booking stayed where the second session put it."
			},
			{
				"action": "Keyboard: focused a block, Space, ArrowDown x2, Enter",
				"observed": "Moved two tables down; screen-reader live region announced 'Moved to table T9, 19:00'."
			},
			{
				"action": "Opened /riyadh-grill/reservations/timeline?lng=ar",
				"observed": "Calls go to http://localhost:3009; interface mirrored, time axis and table numbers unchanged left-to-right."
			},
			{
				"action": "Set reservations.enabled false for acme and reloaded /acme/reservations/timeline",
				"observed": "404 page; Reservations sidebar group hidden."
			},
			{
				"action": "Inspected the loader response /acme/reservations/timeline.data",
				"observed": "Contains flags, location ids and time zone only; no guest names or phones."
			}
		]
	},
	"tests": {
		"added": [
			{
				"file": "apps/app/app/components/reservations/timeline/timeline-grid.test.tsx",
				"cases": [
					{
						"name": "drop on another table offers assign and lock",
						"description": "Choosing lock sends locked: true with expectedVersion."
					},
					{
						"name": "conflict reloads the day and explains",
						"description": "A 409 triggers a refetch and renders the conflict message."
					},
					{
						"name": "keyboard move announces the new position",
						"description": "Space/Arrow/Enter moves the block and updates the live region."
					}
				]
			},
			{
				"file": "apps/app/tests/e2e/reservations-host-stand.test.ts",
				"cases": [
					{
						"name": "host moves a booking to another table",
						"description": "Stubbed tenant-api receives the PATCH and the grid re-renders."
					},
					{
						"name": "resize changes the duration",
						"description": "Dragging the block edge sends the new durationMinutes."
					}
				]
			}
		]
	},
	"discoveredIssues": [
		{
			"severity": "low",
			"description": "The existing toast component truncates Arabic messages longer than 60 characters at 1280 px width.",
			"suggestedFix": "Allow two lines in the toast description (affects the whole App; out of scope here)."
		}
	]
}
```

## When to Return to Orchestrator

- A tenant-api route or response field the screen needs does not exist yet or
  differs from `architecture.md`.
- The design needs a third-party UI dependency that is not already in the repo.
- The App dev server cannot reach a healthy state within 20 minutes, or
  Playwright cannot run within the resource limits.
- A product decision is missing (for example what a host should see in a state
  the contract does not describe).
