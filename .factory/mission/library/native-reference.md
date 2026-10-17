# Native apps reference (iOS TenantKit and Android) for reservations

**What belongs here:** how the existing iOS and Android tenant apps are built
(layout, seams, navigation, session, networking, tests, budget), what
reservations add to each, what can be validated on this Linux machine, and
native gotchas, verified against the repo.

**What does NOT belong here:** the native design and server readiness (see
`architecture.md` section 15, public routes in 7.3), toolchain install and env
exports (see `library/environment.md`), command strings (see `services.yaml`
`commands.android_*` and `commands.ios_*`).

Paths are relative to `/home/factory-user/repos/menuza`.

## 1. Decisions (one line each; see architecture.md section 15)

- Native apps call the same public `/reservations/*` routes as Sites, with
  `Origin`, `X-Client: ios | android` (channel `native`) and the customer access
  token. See 15.1.
- Booking from native requires phone-OTP sign-in; the verified token stands in
  for Turnstile on `/holds`, `/requests`, `/waitlist/join`, `/notify-me` and
  supplies the phone (no phone field).
- Public routes are GET and POST only (Android cannot send PATCH).
- Deposits open `payment.payUrl` in the system browser; on resume the app polls
  `GET /reservations/manage/payment`. No deep links.
- Contract fixtures are recorded from the local tenant-api and parsed by both
  apps' tests plus a tenant-api contract test.
- The shared logic is a pure `BookingFlow` state machine with the same shape on
  both platforms. SwiftUI and Android views stay thin.
- The research's "leave native out" option and its proposed `/booking/*` route
  names are superseded by architecture.md 7.3.

## 2. iOS (`apps/ios`)

### 2.1 Layout

```
apps/ios/
  Package.swift                       swift-tools 5.9, swiftLanguageVersions [.v5]; targets TenantKit + TenantKitTests only
  project.yml                         XcodeGen: iOS app EpicTenantApp (iOS 17), sources Sources/TenantApp, local package TenantKit
  Sources/TenantKit/                  Foundation only (builds and tests on Linux)
    Configuration/TenantConfiguration.swift   tenant-api base URL by organization.dataRegion
    Networking/HTTPTransport.swift            transport seam: send(URLRequest) async throws -> (Data, HTTPURLResponse)
    Networking/TenantAPIClient.swift          App /resources/sites, tenant-api /auth/*; sets Origin at :157-158
    Session/CustomerSession.swift             actor; authorized { token in ... } at :78; single-flight refresh
    Session/TokenStorage.swift                Keychain when canImport(Security), else in memory
    Models/PublicSiteModels.swift, Support/*, Theme/*, Localization/SiteLocale.swift
  Sources/TenantApp/                  SwiftUI, compiled only by Xcode (not a SwiftPM target)
    AppState.swift                    phases loading | needsSite | ready | failed; auth sub-states
    Views/RootView.swift, AuthViews.swift, ProfileView.swift
    Components/BrandHeader.swift, ThemedControls.swift; Theme/ThemePalette.swift
    Localization/Localization.swift; Resources/{en,ar,de,es,fr,zh}.lproj, Assets.xcassets, Info.plist
  Tests/TenantKitTests/               XCTest: CustomerSession, TenantAPIClient, Support, RGBAColor, SiteTheme, SiteLocale, TestSupport (fake transport)
  scripts/generate-tenant.mjs         tenants/<slug>.json -> Config/Generated/Tenant.xcconfig + AppIcon
```

- npm scripts (`apps/ios/package.json`): `ios:build` (`swift build`), `ios:test`
  (`swift test`), `ios:generate` (XcodeGen), `ios:xcode:build`, `ios:sim` (macOS
  only).
- CI: `.github/workflows/ios.yml` runs `swift test` on `macos-26`. On this
  machine Swift 6.4.1 builds TenantKit and passes all 72 tests with no code
  changes.
- `#if canImport(FoundationNetworking)` guards are already in
  `TenantAPIClient.swift`, `HTTPTransport.swift`, `TenantConfiguration.swift`
  and the tests. New networking files need the same guard.

### 2.2 What reservations add

| Piece                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReservationsClient` methods on the existing client, through `HTTPTransport` and `CustomerSession.authorized`; `Origin` and `X-Client: ios` on every call                                                                                                                                                          | `Sources/TenantKit/Reservations/ReservationsClient.swift`                                                                                                                                                 |
| `Decodable` models for config, availability, hold, book, manage, payment status, waitlist                                                                                                                                                                                                                          | `Sources/TenantKit/Reservations/ReservationModels.swift`                                                                                                                                                  |
| Pure `BookingFlow` state machine (search -> slot -> hold -> details -> payment -> confirmed), hold countdown from `expiresAt` and the server `now` offset, alternatives, modify and cancel eligibility, error mapping (`slot_unavailable` 409, `hold_expired` 410, `policy_required` 422, `rate_limited` 429)      | `Sources/TenantKit/Reservations/BookingFlow.swift`                                                                                                                                                        |
| Fixture tests                                                                                                                                                                                                                                                                                                      | `Tests/TenantKitTests/` with fixtures in `Tests/TenantKitTests/Fixtures/Reservations/` (add `resources: [.copy("Fixtures")]` to the test target in `Package.swift`, or embed strings like existing tests) |
| SwiftUI screens: home (Book a table, My reservations), location picker, search (party stepper, date strip, time chips, alternatives), details, review with hold countdown, deposit in the system browser with a poll on return (`scenePhase`), confirmation, detail with modify, cancel and running late, waitlist | `Sources/TenantApp/Reservations/`                                                                                                                                                                         |
| Navigation: a `NavigationStack` inside the signed-in branch of `RootView`                                                                                                                                                                                                                                          | `Sources/TenantApp/Views/RootView.swift`                                                                                                                                                                  |
| Strings in six `.lproj` files; manage tokens in the Keychain                                                                                                                                                                                                                                                       | `Resources/*.lproj`, `TokenStorage` pattern                                                                                                                                                               |

## 3. Android (`apps/android`)

### 3.1 Layout

```
apps/android/
  build.gradle.kts, settings.gradle.kts, gradle.properties   AGP 8.13.2, Kotlin 2.2.21, Gradle 8.14.5; android.useAndroidX=false
  size-budget.json                    APK app-release-unsigned.apk <= 160000 B; AAB app-release.aab <= 220000 B
  scripts/gradle.sh                   finds JAVA_HOME and the SDK (scripts/android-sdk.sh), then ./gradlew
  scripts/size-report.mjs             prints sizes and the 8 largest APK entries; exit 1 when over budget or missing
  scripts/generate-tenant.mjs         writes app/tenant.properties (gitignored); CI uses --tenant ci --no-api
  app/src/main/kotlin/com/epicstartup/tenant/
    core/      plain Kotlin + org.json, JVM-testable, never imports android.*
      config/TenantConfiguration.kt, localization/SiteLocale.kt, model/PublicSiteModels.kt
      net/HttpTransport.kt            HttpURLConnection, connection.requestMethod = request.method (:44)
      net/TenantApiClient.kt          jsonHeaders(withBindingOrigin) adds Origin (:199-205)
      session/CustomerSession.kt      authorized(operation) (:109), single refresh, 401 retry, generation guard
      session/TokenStorage.kt, support/{Json,JwtPayload,PhoneNumber,SiteAddress,IconDecode}.kt, theme/*
    platform/  KeystoreTokenStorage.kt (AES-GCM key in Keystore, ciphertext in private prefs), AndroidTenantConfiguration.kt,
               AppPreferences.kt, ImageLoader.kt, TaskRunner.kt (2-thread executor, no coroutines)
    ui/        MainActivity.kt (render() :147, screenKey() :186, openUrl :139-143), AppState.kt,
               components/{ThemedControls,Views}.kt, screens/{Screens,ProfileScreen}.kt, ThemePalette.kt
  app/src/main/res/values{,-ar,-de,-es,-fr,-zh}/strings.xml   39 strings each today
  app/src/test/kotlin/com/epicstartup/tenant/core/            CustomerSessionTests, SupportTests, TenantApiClientTests, ThemeTests, TestSupport
```

- npm scripts (`apps/android/package.json`): `android:test`
  (`testDebugUnitTest`), `android:build` (`assembleDebug`), `android:lint`
  (`lintDebug`), `android:apk`, `android:bundle`, `android:size`.
- No runtime dependencies. Test dependencies: JUnit 4.13.2, real `org.json`,
  `kotlin("test")`. There is no Robolectric and there are no instrumented tests;
  `platform/` and `ui/` are untested.
- Navigation: `MainActivity.render()` computes a string `screenKey()`
  (`loading`, `connect`, `failed:...`, `login`, `verify`, `name`, `profile`) and
  swaps one `FrameLayout` child. Back uses `onBackInvokedCallback` on API 33+
  and `onBackPressed` below.
- `openUrl` allows only `http`/`https` and starts `ACTION_VIEW`. The manifest
  has only the launcher intent filter and only the `INTERNET` permission.
- Baseline (measured during readiness): release APK 88,676 bytes of 160,000; AAB
  145,554 of 220,000; 77 unit tests pass. The README's "about 92 KB APK, 139 KB
  AAB" figures are outdated.

### 3.2 What reservations add

| Piece                                                                                                                                                                                           | Where                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ReservationsClient` on `TenantApiClient` (POST only for mutations, `Origin`, `X-Client: android`), models with `fromJson`, the same `BookingFlow`, fixture tests                               | `core/reservations/` and `app/src/test/kotlin/.../core/reservations/`, fixtures in `app/src/test/resources/reservations/` |
| Screens, framework views only: keys `res:home`, `res:location`, `res:search`, `res:details`, `res:review`, `res:confirmed`, `res:detail:<id>`, `res:waitlist`; a small back stack in `AppState` | `ui/reservations/`, `ui/AppState.kt`, `ui/MainActivity.kt`                                                                |
| Time chips as `TextView`s in a wrapping `LinearLayout` (no RecyclerView); `java.time`; framework `DatePickerDialog`                                                                             | `ui/reservations/`                                                                                                        |
| Payment through `MainActivity.openUrl`, poll in `onResume`                                                                                                                                      | `ui/MainActivity.kt`                                                                                                      |
| Manage tokens in the Keystore-backed storage                                                                                                                                                    | `platform/KeystoreTokenStorage.kt` pattern                                                                                |
| Strings in six locales, RTL for Arabic                                                                                                                                                          | `res/values*/strings.xml`                                                                                                 |
| Budget measured on every iteration; raise `size-budget.json` only with a reason in its `$comment`, in the same commit                                                                           | `size-budget.json`, `scripts/size-report.mjs`                                                                             |

Byte-budget tactics: reuse `ThemedControls`; no new images or vector assets;
keep strings tight (60 to 80 new strings times six locales is a few KB); no
coroutines, no date library, no JSON library. The current app is about 4,250
lines of Kotlin and costs about 70 KB above the framework floor, so a feature of
similar size uses most of the headroom (about 71 KB APK, 74 KB AAB).

## 4. Server readiness (lands in `online-booking`, finished in `native-apps`)

- Origin binding: both apps send `Origin` only for `https` site origins
  (`SiteAddress.authOriginHeader` on iOS and Android). Locally the site origin
  is not https, so the apps fall back to `slug`/`host` binding, which public
  reservation routes accept **outside production only** (architecture.md 7.3).
  Production never accepts a client slug.
- Today `Origin` is attached only to `send-code` and `verify`
  (`withBindingOrigin = true` at `TenantApiClient.kt:67, 85`). Reservation calls
  must attach it too.
- Customer JWT: `Authorization: Bearer`, audience `tenant-api`; an invalid or
  cross-organization token is rejected, not ignored. Capability tokens travel in
  `X-Reservation-Token`, so both can coexist.
- `X-Client: ios | android` sets channel `native`.
- Deadline responses carry `expiresAt` and the server `now`; compute the
  countdown from the offset, never from the device clock alone.
- Payment: `payment.payUrl` =
  `<siteOrigin>/reserve/pay#r=<id>&t=<paymentToken>`; open it in the system
  browser; poll `GET /reservations/manage/payment`
  (`{ paymentStatus, reservationStatus, now }`) on resume.
- `GET /reservations/mine` (customer JWT) lists bookings with derived manage
  tokens, so an app can recover tokens after reinstall.

## 5. Contract fixtures

- Recorder: `apps/tenant-api/scripts/record-reservations-fixtures.ts` (npm
  script `fixtures:reservations` in `apps/tenant-api/package.json`) calls the
  local tenant-api (seeded `acme`) and writes canonical JSON to
  `packages/reservations/contract-fixtures/*.json`, then copies it to
  `apps/ios/Tests/TenantKitTests/Fixtures/Reservations/` and
  `apps/android/app/src/test/resources/reservations/`.
- Contract test: `apps/tenant-api/src/routes/reservations-contract.test.ts`
  parses every canonical fixture with the public Zod schemas from
  `@repo/reservations` and checks the native copies are byte-identical.
- Record deterministic data (fixed seed, stable ids where possible) so
  re-recording does not churn the fixtures. Never record real guest data; use
  the seeded demo guests.

## 6. Validation on this machine

| Check                                                        | Possible           | Command (see `services.yaml`)                             |
| ------------------------------------------------------------ | ------------------ | --------------------------------------------------------- |
| Android JVM unit tests                                       | yes                | `commands.android_test`                                   |
| Android compile of `ui/` and `platform/`                     | yes                | `commands.android_build`                                  |
| Android lint (`NewApi` above minSdk 26, RTL, hardcoded text) | yes, not run in CI | `commands.android_lint`                                   |
| Android release build and byte budget                        | yes                | `commands.android_size` (generates the `ci` tenant first) |
| Android emulator, Keystore, UI rendering                     | no (no `/dev/kvm`) | user checks on device                                     |
| iOS TenantKit build and tests                                | yes                | `commands.ios_build`, `commands.ios_test`                 |
| SwiftUI views, Xcode project, simulator, Keychain            | no (macOS only)    | macOS CI `ios.yml`, user checks on device                 |
| tenant-api contract test                                     | yes                | tenant-api Vitest                                         |

- Stop the Gradle daemon afterwards (`commands.android_stop_gradle`); it holds
  about 2 GB, and App typecheck or ESLint can then run out of memory.
- Milestone gate order puts Android (tests, build, size) before iOS
  (`swift build`, `swift test`); see architecture.md 16.4.

## 7. Gotchas

1. `HttpURLConnection` throws `ProtocolException` for `PATCH`. Every public
   mutation is POST (`/manage/modify`, `/manage/cancel`, `/manage/confirm`,
   `/manage/late`, `/holds/release`, `/waitlist/status/leave`). Add a request
   shape test that asserts no PATCH on Android.
2. SwiftUI code cannot be compiled here. Keep views thin, copy the existing
   `AuthViews.swift` / `ProfileView.swift` patterns, and put all logic in
   TenantKit where `swift test` covers it.
3. Linux corelibs Foundation differs from Apple Foundation in `Locale`, number
   formatting, `JSONSerialization` key ordering and `URLComponents` encoding.
   Compare decoded values in tests, not serialized strings.
4. `Bundle.module` fixtures need a `resources:` entry on the test target;
   without it the fixture files are not found on either platform.
5. `core/` on Android must never import `android.*`; JVM tests depend on it.
6. Android has no coroutines; background work goes through
   `platform/TaskRunner.kt` and results are posted to the main thread.
7. `android.useAndroidX=false` makes adding AndroidX awkward but does not forbid
   it. Only convention and the byte budget enforce "framework only".
8. `app/tenant.properties` is gitignored and written by
   `generate-tenant.mjs --tenant ci --no-api`; do not commit it.
9. The release size check needs the `ci` tenant generated first, or
   `size-report.mjs` reports MISSING and fails.
10. Booking requires sign-in on native, so the phone comes from the OTP
    identity. Never add a phone field to native booking.
11. Never store manage tokens in plain preferences or `UserDefaults`; use the
    Keystore and Keychain storage classes.
12. Neither app has deep links. Do not add URL schemes, App Links or associated
    domains for the payment return; poll on resume instead.
