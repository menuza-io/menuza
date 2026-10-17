---
name: docs-worker
description:
  Writes and updates the Reservations documentation (operator guide and runbook,
  API contract, plan, ADR 048, repo AGENTS.md sections and env var lists, and
  related docs for permissions, scheduled jobs, data residency, phone-agent
  verticals, tenant-api and staffing), verifying every documented path, route,
  flag, permission, env var and command against the code.
---

# Docs worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- Read the code to verify every claim; `rg` for routes, env vars, flags and
  permissions; run cheap documented commands (for example the seed script or a
  curl against the local tenant-api) to confirm they work as written.
- Prettier for Markdown formatting (lint-staged formats staged `.md` files).
- References: `architecture.md` (docs list, env vars, kill switches, flags,
  permissions, routes), the staffing docs as models (`docs/staffing.md`,
  `docs/staffing-plan.md`, `docs/decisions/047-staffing-data-residency.md`),
  `docs/tenant-data-residency.md`, repo `AGENTS.md`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, and the docs section of `architecture.md`. List each
   document to create or update and what it must cover.
2. **Gather facts from the code, not from plans.** For every route, flag,
   permission, env var, kill switch, command, file path and default you will
   document, find it in the source and note where. If the code and
   `architecture.md` disagree, document the code and report the disagreement.
3. **Write the docs** in the repo's voice and structure (mirror the staffing
   docs): operator guide with runbook (kill switches, incident steps, deploy
   order: tenant-api first), contract document (routes, request and response
   shapes, error codes, capability tokens, `X-Client`, payment status poll),
   plan, ADR, and the updates to existing docs and the repo `AGENTS.md` (a
   Reservations section and the new env vars, following the Staff module
   section).
4. **Check every reference.** Confirm each file path you mention exists
   (`test -e`), each command you show runs (or is clearly marked as
   production-only), and each internal link resolves.
5. **Programmatic verification (approved worker scoping), then commit:**
   - `npx prettier --check <changed docs>` (or `--write` then review).
   - `commands.lingui_check` (should be unaffected) and `commands.lint_oxc` if
     you touched any code sample files.
   - `commands.clean_generated`, review the staged diff, then commit
     (`docs(reservations): ...`).

## Example Handoff

```json
{
	"salientSummary": "Wrote docs/reservations.md (operator guide and runbook), docs/reservations-contract.md and ADR 048, and added the Reservations section and env vars to the repo AGENTS.md; every route, flag, permission and env var was checked against the code and all 63 referenced paths exist.",
	"whatWasImplemented": "docs/reservations.md: setup walkthrough (flags, permissions and presets, location settings, floor plan, services), daily use (book, timeline, floor, waitlist, guestbook), messages, payments and platform fee, integrations, and a runbook (RESERVATIONS_PUBLIC_ENABLED, RESERVATIONS_EMAIL_ENABLED, RESERVATIONS_SMS_ENABLED, RESERVATIONS_TICK_INTERVAL_SECONDS; deploy tenant-api first; region-switch guard). docs/reservations-contract.md: every public and customer route with shapes and error codes. docs/decisions/048-reservations-data-residency.md. Repo AGENTS.md: Reservations module section mirroring the Staff module section, and the new env vars in the Environment Variables list.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "rg -o '`(apps|packages|docs)/[^`]+`' docs/reservations*.md docs/decisions/048-reservations-data-residency.md | tr -d '`' | cut -d: -f2 | sort -u | while read p; do test -e \"$p\" || echo MISSING $p; done",
				"exitCode": 0,
				"observation": "63 paths checked, none missing."
			},
			{
				"command": "rg -n 'RESERVATIONS_[A-Z_]+' apps packages --type ts -o | sort -u",
				"exitCode": 0,
				"observation": "4 env vars in code, all documented with defaults matching the code."
			},
			{
				"command": "npm run seed:reservations -w tenant-api -- acme",
				"exitCode": 0,
				"observation": "Runs as documented; idempotent on a second run."
			},
			{
				"command": "npx prettier --check docs/reservations.md docs/reservations-contract.md docs/decisions/048-reservations-data-residency.md AGENTS.md",
				"exitCode": 0,
				"observation": "All formatted."
			}
		],
		"interactiveChecks": []
	},
	"tests": { "added": [] },
	"discoveredIssues": [
		{
			"severity": "low",
			"description": "docs/scheduled-jobs.md still describes the staff tick as the only org alarm module; the reservations module now shares lib/org-alarm.ts. Left the staffing paragraph as is because it is outside this feature's doc list.",
			"suggestedFix": "Add one sentence about shared org-alarm modules to docs/scheduled-jobs.md in the next docs feature."
		}
	]
}
```

## When to Return to Orchestrator

- Code and design disagree on something user-facing (a route, flag, permission
  or default) and it is unclear which is intended.
- A documented command fails, or a feature the docs must describe does not exist
  yet.
