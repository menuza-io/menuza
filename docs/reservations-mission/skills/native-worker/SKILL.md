---
name: native-worker
description:
  Builds reservation booking in the native customer apps - iOS TenantKit
  (ReservationsClient, models, BookingFlow state machine) plus SwiftUI screens,
  and the same flow in the Android platform-neutral core and framework views in
  six locales - against contract fixtures recorded from the local tenant-api,
  verified with Swift and Gradle tests, builds and the Android byte budget.
---

# Native worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the
WORK PROCEDURE.

## Required Skills and Tools

- SwiftPM on Linux (`commands.ios_build`, `ios_test`): TenantKit and its XCTest
  tests build and run here; SwiftUI does not exist on Linux, so views must
  follow the repo's existing pattern for Apple-only code.
- Gradle via the `apps/android` scripts (`commands.android_test`,
  `android_build`, `android_size`, `android_lint`, `android_stop_gradle`).
  Framework views only: no AndroidX, Compose or OkHttp (the repo enforces this).
- `curl` and the local tenant-api to record contract fixtures. No emulator,
  simulator or device here: the user checks screens on devices.
- References: `architecture.md` (native section, public and customer route
  shapes, payment-status poll, `X-Client`), `docs/reservations-contract.md` once
  it exists, `library/native-reference.md` (structure, commands, byte budget,
  Linux limits), repo guide `docs/skills/project-mobile/SKILL.md`,
  `apps/android/README.md`.

## Work Procedure

1. **Understand the feature.** Read the feature, every assertion in its
   `fulfills` list, the native section of `architecture.md`, and the contract
   document or fixtures. List each request, response and error code the app
   handles, and each BookingFlow state and transition (search, alternatives,
   hold with countdown and expiry, details, review, deposit in the system
   browser with a status poll on return, confirmation, manage: modify, cancel,
   running late; waitlist).
2. **Inspect the existing apps** (`apps/ios`: Package.swift, TenantKit client,
   session, models and tests; `apps/android`: core package, networking, JSON,
   session, views, tests, size budget config) and follow their patterns exactly.
3. **Record or refresh contract fixtures** from the local tenant-api when the
   feature needs new shapes: start `tenant-api-us`, seed acme, capture real
   responses (no real guest PII; use seeded demo data), and store them where
   `architecture.md` says. The tenant-api contract test must validate them
   against the schemas.
4. **Write failing tests first:** Swift XCTest and Android JVM tests for request
   building (POST-only mutations, `Idempotency-Key`, `X-Client: native`,
   customer Bearer token instead of Turnstile), decoding of every fixture,
   error-code mapping, and the BookingFlow state machine (countdown from
   `expiresAt` and server `now`, expiry, payment poll until a final status,
   cancel and modify rules).
5. **Implement.** iOS: Foundation-only code in TenantKit (compiles on Linux);
   SwiftUI screens in the Apple-only target following the existing pattern.
   Android: logic in the platform-neutral core, screens with framework views,
   strings in all six locales with right-to-left support. Keep the Android byte
   budget: measure with `commands.android_size`; if the feature truly needs
   more, raise the budget minimally and record the reason next to the budget
   value.
6. **Write the device checklist** for the user: the screens and states to check
   on iOS and Android devices (include it in the handoff).
7. **Stop what you started** (tenant-api, the Gradle daemon). Run native builds
   one at a time with no browser sessions open.
8. **Programmatic verification (approved worker scoping), then commit:**
   - When a consolidated feature also includes backend integrations (voice
     actions, staffing forecast demand sources, marketing journeys) and final
     documentation (`docs/reservations*.md`, ADR 048, `AGENTS.md`, etc.): run
     `commands.test_tenant_api`, targeted `@repo/phone-agent` / `@repo/staffing`
     / App tests, and verify all doc checklists from `docs-worker`.
   - `commands.ios_build` and `commands.ios_test` when iOS changed.
   - `commands.android_test`, `commands.android_build`, `commands.android_size`
     (and `commands.android_lint` when views changed) when Android changed, then
     `commands.android_stop_gradle`.
   - The tenant-api contract test (`commands.test_files_tenant_api` with its
     path) when fixtures or server shapes changed.
   - `commands.clean_generated`, review the staged diff (fixtures contain only
     seeded demo data), then commit.

## Example Handoff

```json
{
	"salientSummary": "Added TenantKit ReservationsClient, Codable models and the BookingFlow state machine for iOS, plus SwiftUI search, review (hold countdown) and confirmation screens; 31 new XCTest cases pass on Linux against fixtures recorded from the local tenant-api, and the tenant-api contract test validates the fixtures.",
	"whatWasImplemented": "apps/ios/Sources/TenantKit/Reservations/: ReservationsClient (config, availability, calendar, holds, bookings, manage view/modify/cancel/late, payment status; POST-only mutations with Idempotency-Key and X-Client: native; customer Bearer token from CustomerSession), models decoding every field of docs/reservations-contract.md, BookingFlow (idle -> searching -> choosingTime -> holding(expiresAt, serverNow) -> details -> reviewing -> awaitingPayment(poll) -> confirmed | expired | failed). Countdown uses the server now offset. SwiftUI views in the Apple-only app target: ReservationsHomeView, SearchView with time chips and alternatives, ReviewView with countdown, ConfirmationView. Fixtures recorded with scripts/record-reservation-fixtures.mjs into apps/ios/Tests/TenantKitTests/Fixtures/reservations/ and mirrored for Android.",
	"whatWasLeftUndone": "",
	"verification": {
		"commandsRun": [
			{
				"command": "cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift test --filter Reservations",
				"exitCode": 1,
				"observation": "Before implementation: 31 failing as expected."
			},
			{
				"command": "cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift build && swift test",
				"exitCode": 0,
				"observation": "Build clean; 103 tests, 0 failures (72 existing + 31 new)."
			},
			{
				"command": "node scripts/record-reservation-fixtures.mjs --base http://localhost:3007 --origin http://acme.menuza.test:3008",
				"exitCode": 0,
				"observation": "Recorded 14 fixtures from seeded acme data; no real customer data."
			},
			{
				"command": "cd apps/tenant-api && CI=true npx vitest run src/routes/reservations-contract.test.ts",
				"exitCode": 0,
				"observation": "All 14 fixtures validate against the API schemas."
			}
		],
		"interactiveChecks": []
	},
	"tests": {
		"added": [
			{
				"file": "apps/ios/Tests/TenantKitTests/ReservationsClientTests.swift",
				"cases": [
					{
						"name": "testHoldSendsIdempotencyKeyAndNativeClientHeader",
						"description": "POST /reservations/holds carries Idempotency-Key, X-Client: native and the Bearer token, never a Turnstile field."
					},
					{
						"name": "testDecodesAvailabilityFixtureWithAlternatives",
						"description": "The recorded availability fixture decodes slots and alternatives."
					}
				]
			},
			{
				"file": "apps/ios/Tests/TenantKitTests/BookingFlowTests.swift",
				"cases": [
					{
						"name": "testHoldExpiresAtServerTimeNotDeviceTime",
						"description": "With the device clock 3 minutes behind, the flow expires exactly at expiresAt on the server timeline."
					},
					{
						"name": "testPaymentPollStopsOnFinalStatus",
						"description": "Polling stops after 'paid' and moves to confirmed; 'expired' moves to expired."
					}
				]
			}
		]
	},
	"discoveredIssues": [
		{
			"severity": "low",
			"description": "Device checklist for the user: iOS reservations home, search with alternatives, review countdown reaching expiry, deposit in Safari and return, confirmation, Arabic right-to-left on each screen.",
			"suggestedFix": "User verifies on a device; no code change."
		}
	]
}
```

## When to Return to Orchestrator

- A route or field the app needs is missing from the server or differs from the
  contract document.
- The Android byte budget would need a large raise (more than about 20%), or the
  feature seems to need AndroidX or another dependency.
- Swift or Gradle toolchains stop working with the `services.yaml` commands.
