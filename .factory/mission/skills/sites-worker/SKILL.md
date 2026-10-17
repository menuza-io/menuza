---
name: sites-worker
description:
  Builds guest-facing reservation pages on the restaurant website (apps/sites,
  Astro) and the matching App website-builder block - /reserve, manage,
  waitlist, experiences and profile panels - with browser-direct calls to the
  regional tenant-api, no guest data in SSR, and six locales including Arabic
  right-to-left, verified with Sites Vitest and agent-browser on acme (English)
  and riyadh-grill (Arabic, KSA).
---

# Sites worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- `agent-browser` skill: invoke it before any browser verification. Every guest
  page you build is walked in agent-browser.
- Sites Vitest (client modules, label completeness); App Vitest when you touch
  the website-builder block in the App.
- References: `architecture.md` (Sites pages, public `/reservations/*` API
  shapes, capability tokens, payments step, flags), `library/sites-patterns.md`
  (Astro structure, block rendering, tenant-api URL injection, client modules,
  locales, local host quirks), `library/opentable-reference.md` (guest flow
  conventions), `library/user-testing.md` (resolver rule, OTP sign-in), repo
  guide `docs/skills/project-public-sites/SKILL.md`,
  `docs/tenant-data-residency.md`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, the Sites and public API sections of `architecture.md`, and
   `library/sites-patterns.md`. List each page state: loading, no availability
   (with alternatives and notify-me where specified), hold countdown and expiry,
   validation errors, rate-limited, kill switch (503), uniform 404, success, and
   signed-in versus guest.
2. **Mirror the existing browser-direct pattern** (the careers apply page and
   the profile page call tenant-api from client modules). The page gets the
   regional API URL from `document.documentElement.dataset.tenantApiUrl`; the
   organization is resolved by tenant-api from `Origin`. Never call tenant-api
   from Astro SSR for guest data and never add a Sites BFF; customer tokens stay
   in `localStorage`; manage tokens travel in the URL fragment.
3. **Write failing tests first:** client-module tests (request building,
   `Idempotency-Key`, `X-Client`, POST-only mutations, error-code-to-message
   mapping, countdown from `expiresAt` and the server's `now`, fragment token
   parsing and clearing), and label-completeness tests that fail when any of the
   six locales lacks a string.
4. **Implement.** Reservations-named pages and components; accessible forms
   (labels, errors tied to fields, focus management, keyboard date and time
   selection); honeypot field; Turnstile widget only when a site key is
   configured; six locales with real translations (en, ar, es, fr, de, zh) and
   right-to-left for Arabic without mirroring times or numbers. If the feature
   includes the App website-builder block, register it so it only appears when
   the online flag is on, and render it in Sites from the published block
   config.
5. **Verify in agent-browser** (main evidence):
   - Start `tenant-api-us`, `tenant-api-ksa`, `app` and `sites` from
     `services.yaml`; seed both orgs; set `reservations.enabled` and
     `reservations.online` (and other child flags the feature needs) with
     `commands.set_org_flag`.
   - acme in English at `http://acme.menuza.test:3008/...`: walk every
     expectedBehavior as a guest and as a signed-in customer (OTP code from
     `commands.read_sms_code`).
   - riyadh-grill in Arabic with
     `--host-resolver-rules=MAP *.menuza.test [::1]`: the same flow on the KSA
     node (requests go to `http://localhost:3009`), right-to-left layout
     correct.
   - Network: every reservations call goes from the browser to tenant-api; the
     SSR HTML
     (`curl -H 'Host: acme.menuza.test:3008' http://localhost:3008/<page>`)
     contains no guest names, phones, emails or tokens. Console has no errors.
     Screenshots of each main state.
   - Close your browser sessions when done.
6. **Lingui.** `commands.lingui_extract_sites` (and `lingui_extract_app` if the
   App block changed), fill every locale, stage the `.po` files.
7. **Stop what you started.**
8. **Programmatic verification (approved worker scoping), then commit:**
   - When a consolidated feature includes `apps/tenant-api` public/operator
     routes alongside Sites and App pages: follow `backend-worker` security
     rules, add every new route to
     `apps/tenant-api/src/routes/reservations-security.test.ts`, and run
     `commands.test_tenant_api` and
     `npx turbo run typecheck --filter=tenant-api`.
   - `commands.test_workspace` with `sites`; targeted App Vitest files if the
     App block or routes changed.
   - `npx turbo run typecheck --filter=sites` (plus `commands.typecheck_app` if
     App files changed, never at the same time as App ESLint).
   - `commands.lint_workspace` with `sites`; `commands.lint_app_files` on
     changed App files; `commands.lint_oxc`; `commands.lingui_check`.
   - `commands.clean_generated`, review the staged diff, then commit.

## Example Handoff

```json
{
	"salientSummary": "Built the Sites /reserve flow (party, date, time chips with alternatives, guest details, 7-minute hold countdown, confirmation with manage link and .ics) calling tenant-api directly from the browser; Sites Vitest (214 tests) and label completeness pass, and agent-browser runs on acme (English, US node) and riyadh-grill (Arabic RTL, KSA node) completed bookings with no guest data in SSR HTML.",
	"whatWasImplemented": "apps/sites/src/pages/reserve/index.astro renders the shell only (no guest data); client module apps/sites/src/reservations/reserve-client.ts reads dataset.tenantApiUrl, calls GET /reservations/config and /reservations/availability, POST /reservations/holds (Idempotency-Key from crypto.randomUUID, X-Client: web) and POST /reservations/bookings. The countdown uses expiresAt minus the server now offset, so device clock skew does not matter; at expiry the form disables and offers 'Find another time'. Error codes map to localized messages (RSV_SLOT_UNAVAILABLE refreshes alternatives; 429 shows a retry hint; 503 shows 'Online booking is paused'). Signed-in customers get name and phone prefilled from the customer profile call. Confirmation shows the manage link (#t=<token>, fragment cleared from history after reading) and an .ics download. Strings added to all six locales; Arabic RTL verified.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd apps/sites && CI=true npx vitest run src/reservations",
				"exitCode": 1,
				"observation": "Before implementation: 19 failing as expected."
			},
			{
				"command": "CI=true npm run test -w sites",
				"exitCode": 0,
				"observation": "27 files, 214 tests passed, including reservations-labels.test.ts for en/ar/es/fr/de/zh."
			},
			{
				"command": "npx turbo run typecheck --filter=sites",
				"exitCode": 0,
				"observation": "Clean."
			},
			{
				"command": "npm run lint -w sites && npm run lint:oxc",
				"exitCode": 0,
				"observation": "0 errors."
			},
			{
				"command": "npm run lingui:extract -w sites && npm run lingui:check",
				"exitCode": 0,
				"observation": "23 new messages filled in 5 non-source locales; check passes."
			},
			{
				"command": "curl -s -H 'Host: acme.menuza.test:3008' http://localhost:3008/reserve | grep -ciE 'kody|\\+1555|@example.com'",
				"exitCode": 1,
				"observation": "0 matches: SSR HTML has no guest data."
			}
		],
		"interactiveChecks": [
			{
				"action": "agent-browser (acme, English): /reserve, party 2, tomorrow, picked 19:00 chip, filled name/phone/email, submitted",
				"observed": "Hold countdown started at 6:59; booking confirmed with manage link and .ics; network shows POST http://localhost:3007/reservations/holds 201 then /reservations/bookings 201; no console errors."
			},
			{
				"action": "Waited past the hold expiry on a second attempt",
				"observed": "Form disabled with 'Your hold expired' and a 'Find another time' button that reloads availability."
			},
			{
				"action": "Chose a fully booked 20:00",
				"observed": "'No tables at 20:00' with alternatives 19:30 and 21:15; picking 21:15 held successfully."
			},
			{
				"action": "Signed in by OTP (+15555550123) and reopened /reserve",
				"observed": "Name and phone prefilled; after booking, the profile page lists the reservation under Upcoming reservations."
			},
			{
				"action": "agent-browser (riyadh-grill, Arabic, resolver rule MAP *.menuza.test [::1]): same flow",
				"observed": "Layout right-to-left, times and party size digits unchanged; requests go to http://localhost:3009; booking confirmed."
			}
		]
	},
	"tests": {
		"added": [
			{
				"file": "apps/sites/src/reservations/reserve-client.test.ts",
				"cases": [
					{
						"name": "sends Idempotency-Key and X-Client on hold",
						"description": "POST /reservations/holds includes both headers and a JSON body; GET is never used for mutations."
					},
					{
						"name": "countdown corrects for clock skew",
						"description": "With the device clock 5 minutes fast, the countdown still shows 7:00 at hold time."
					},
					{
						"name": "reads and clears the manage token from the fragment",
						"description": "The token is taken from #t= and removed with history.replaceState."
					}
				]
			},
			{
				"file": "apps/sites/src/reservations/reservations-labels.test.ts",
				"cases": [
					{
						"name": "every reservations label exists in all six locales",
						"description": "Fails when en, ar, es, fr, de or zh lacks a key or has an empty value."
					}
				]
			}
		]
	},
	"discoveredIssues": []
}
```

## When to Return to Orchestrator

- A public tenant-api route or field the page needs does not exist yet or
  differs from `architecture.md`.
- Showing something the contract requires would need guest data in SSR or a
  Sites-side proxy.
- Sites cannot resolve an organization locally (host quirks beyond
  `library/user-testing.md`).
- Translations cannot be produced for a locale with reasonable confidence (ask
  before shipping placeholder text).
