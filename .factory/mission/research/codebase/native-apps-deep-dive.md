# Native apps (iOS + Android) feasibility deep-dive for reservations

Repo: `/Users/zama/menuza`. Everything below was read-only; no toolchain was
installed. Machine: Ubuntu 24.04.4 x64, 4 CPUs, 7.9 GB RAM, 30 GB free on `/`,
**passwordless sudo available** (`sudo -n true` succeeds), no Docker/Podman, no
Swift, no JDK, no Gradle, no Android SDK, no `/dev/kvm`. `curl` and `unzip`
exist.

---

## 1. iOS (`apps/ios`)

### Package.swift

- `swift-tools-version: 5.9`, `swiftLanguageVersions: [.v5]`.
- Platforms: `.iOS(.v17)`, `.macOS(.v14)` (these only constrain Apple builds;
  Linux ignores them).
- Product: `.library(name: "TenantKit")`. Targets: `TenantKit`
  (`Sources/TenantKit`) and `TenantKitTests` (`Tests/TenantKitTests`). No
  external dependencies.
- **The SwiftUI app (`Sources/TenantApp`) is not a SwiftPM target.** XcodeGen
  (`project.yml`) compiles it as the `EpicTenantApp` iOS application, and the
  app uses TenantKit as a local package. So `swift build` / `swift test` only
  ever see Foundation code. There is no need for `--target`.

### Apple-only vs Foundation-only

- `Sources/TenantApp/*` (AppState, EpicTenantApp, RootView, AuthViews,
  ProfileView, BrandHeader, ThemedControls, ThemePalette, Localization) imports
  SwiftUI. These files are Apple-only and not part of the package.
- `Sources/TenantKit/*` imports only `Foundation`. Some files add guarded
  imports:
  - `#if canImport(FoundationNetworking) import FoundationNetworking`:
    `TenantAPIClient.swift`, `HTTPTransport.swift`, `TenantConfiguration.swift`.
    The tests `TestSupport.swift` and `TenantAPIClientTests.swift` use the same
    guard.
  - `#if canImport(Security)`: `TokenStorage.swift` (KeychainTokenStorage).
    `TokenStorageFactory.makeDefault()` falls back to `InMemoryTokenStorage` on
    Linux.
- No UIKit, AuthenticationServices, Combine, or os_log imports appear in
  TenantKit.
- **Yes, FoundationNetworking is needed on Linux for
  `URLSession`/`URLRequest`**, and the code already guards the import.

### Features, screens, navigation

- `AppState` (`@MainActor ObservableObject`) has the phases
  `loading | needsSite | ready | failed`. When the phase is `ready`, the screen
  is chosen from the auth state: login, then verify (OTP), then name, then
  profile. `RootView` switches on the phase. There is no `NavigationStack` route
  graph and no tab bar; the app is a small state machine.
- The screens are Connect site (un-branded builds only), Loading/Unavailable,
  Phone login, OTP verify, Name, and Profile (name/email/language, sign out).
- Six locales are shipped as `.lproj` files (about 39 strings each). Arabic
  switches the layout to RTL.

### tenant-api / App calls (`TenantAPIClient.swift`)

- `GET {APP}/resources/sites?slug|host&lng` returns branding
  (`PublicOrganization`).
- `POST {TENANT_API}/auth/send-code` and `/auth/verify`. The body carries
  `slug`/`host`. For https origins the request also sends the `Origin` header
  set to `EPIC_SITE_ORIGIN`, which is how tenant-api resolves the org.
- `POST /auth/refresh` with `{refreshToken, orgId}`, `POST /auth/logout`.
- `GET /auth/me` and `POST /auth/profile` with `Authorization: Bearer <access>`.
- The tenant-api base URL is chosen by `organization.dataRegion` (us/ksa) in
  `TenantConfiguration`.
- `CustomerSession` (an `actor`):
  - The access token lasts 15 minutes and the refresh token rotates.
  - `authorized { token in ... }` retries once after a 401. A single in-flight
    refresh task prevents replay revocation, and a session-generation counter
    guards against sign-out races.
  - A 401 or 403 during refresh clears the session. Transient errors keep it.
  - Tokens are stored through `TokenStorage`: the Keychain on iOS, in memory on
    Linux.
- Networking layer: the `HTTPTransport` protocol
  (`send(URLRequest) async throws -> (Data, HTTPURLResponse)`) is the seam. The
  default is `URLSessionTransport`; tests inject a fake. `APIError.from` parses
  `{error, error_description, message}`. Responses are decoded with
  `JSONDecoder`.

### Tests (`Tests/TenantKitTests`, 72 XCTest methods)

- CustomerSessionTests (15): refresh, single-flight, sign-out races.
- TenantAPIClientTests (12): request shape, headers, binding, error mapping.
- SupportTests (16): phone, JWT, site address.
- RGBAColorTests (14) and SiteThemeTests (8): oklch/hsl conversion and theme
  tokens.
- SiteLocaleTests (7).
- The tests use XCTest and Foundation with a fake transport and in-memory
  storage. None needs an Apple framework.
- **Caveat:** CI runs `swift test` only on `macos-26`
  (`.github/workflows/ios.yml`). The Ubuntu job there only lists tenants. The
  "Linux-testable" claim is therefore not verified in CI.

### Tenant config generation and the Xcode project

- `scripts/generate-tenant.mjs` (Node) turns `tenants/<slug>.json` into
  `Config/Generated/Tenant.xcconfig` and the 1024 px `AppIcon` (resized from the
  published site icon; flags `--no-icon` and `--no-api`). It does not touch
  Swift.
- `project.yml` (XcodeGen) defines one iOS app target, `EpicTenantApp`:
  deployment target iOS 17, `SWIFT_VERSION 5.0`, minimal strict concurrency,
  sources `Sources/TenantApp`, the local package dependency TenantKit, and
  xcconfig files for Debug/Release. The generated `.xcodeproj` is not committed.
- External URLs: only the SwiftUI `Link(destination:)` for announcement links
  (`BrandHeader.swift:74`). There are no `CFBundleURLTypes`, associated domains,
  or deep-link handling.

---

## 2. Android (`apps/android`)

### Gradle setup

- Gradle wrapper **8.14.5** (`gradle-wrapper.properties`, sha256-pinned).
- AGP **8.13.2** and Kotlin Android plugin **2.2.21** (root `build.gradle.kts`).
  There is no version catalog.
- `compileSdk 36`, `minSdk 26`, `targetSdk 36`. Java/Kotlin target 17. **The
  build requires JDK 17+.**
- One module, `:app`. `gradle.properties` sets `android.useAndroidX=false`,
  nonTransitiveRClass, `-Xmx2048m`, parallel builds, and the build cache.
- Release builds use R8 (`isMinifyEnabled`), `isShrinkResources`,
  `localeFilters` (en ar de es fr zh), AAB language splits off, and packaging
  excludes (`/kotlin/**`, META-INF files).
- Endpoints are `resValue`s that come from `app/tenant.properties`, which
  `scripts/generate-tenant.mjs` writes. Debug builds without a tenant use
  `10.0.2.2:3001/3007/3009`, which can be overridden with `-PdevHost`.
- Lint config: `checkReleaseBuilds=false`, `ViewConstructor` disabled.
- Runtime dependencies: **none**. Test dependencies: `junit 4.13.2`,
  `org.json:json:20260814` (the real implementation, not the android.jar stub),
  and `kotlin("test")`.

### How the framework-only rule is enforced

- **By convention and by the size budget only.** There is no
  dependency-allowlist test, and no lint rule bans `androidx.*`.
- `android.useAndroidX=false` makes adding an AndroidX dependency awkward but
  does not forbid it.
- The README and code comments state the rules: no AndroidX, Compose, OkHttp,
  serialization library, image loader, DI, or coroutines, and `core` never
  imports `android.*`.
- `size-budget.json`: release APK `app-release-unsigned.apk` ≤ **160,000 B**;
  release AAB ≤ **220,000 B**.
- `scripts/size-report.mjs` prints the artifact sizes and the 8 largest entries
  in the APK, then sets exit code 1 if an artifact is over budget or MISSING. CI
  (`android.yml`, ubuntu-24.04, Temurin 17) runs the `ci` tenant generation,
  `testDebugUnitTest`, `assembleRelease bundleRelease`, and then
  `size-report.mjs`. **CI does not run lint.**
- Current sizes (from the README and `docs/play-store-release.md`): release APK
  about **92 KB**, AAB about **139 KB**, per-device download about 73–82 KB.
- **Headroom:** about **68 KB on the APK** (160 − 92) and about **81 KB on the
  AAB** (220 − 139).

### Code layout, features, screens

- `core/` is plain Kotlin plus org.json and is JVM-testable:
  `config/TenantConfiguration`, `localization/SiteLocale`,
  `model/PublicSiteModels`, `net/HttpTransport` + `TenantApiClient`,
  `session/CustomerSession` + `TokenStorage`, `support/` (Json helpers,
  JwtPayload, PhoneNumber, SiteAddress, IconDecode), and `theme/`.
- `platform/` holds the Android adapters: `KeystoreTokenStorage`,
  `AndroidTenantConfiguration`, `AppPreferences`, `ImageLoader` (BitmapFactory
  with an LruCache), and `TaskRunner` (a 2-thread executor that posts results to
  the main thread; there are no coroutines).
- `ui/` contains `MainActivity`, the `AppState` state machine
  (`Loading | NeedsSite | Ready | Failed`), `components/ThemedControls` and
  `Views` (programmatic `android.widget` views), and `screens/Screens.kt` +
  `ProfileScreen.kt`.
- Navigation: `MainActivity.render()` computes a string `screenKey()`
  (`loading`, `connect`, `failed:…`, `login`, `verify`, `name`, `profile`) and
  swaps a single `FrameLayout` child. Back is handled by `onBackInvokedCallback`
  on API 33+ and by `onBackPressed` on older versions.
- The screens are the same as on iOS. Kotlin is about 4,250 lines in total.
- External URLs: `MainActivity.openUrl` (`MainActivity.kt:139-143`) allows only
  http/https and calls `startActivity(Intent(ACTION_VIEW, uri))`. The manifest
  has only the launcher intent-filter (no deep links), and the app requests only
  the `INTERNET` permission.

### Networking, JSON, session

- `HttpUrlConnectionTransport`: blocking `HttpURLConnection`, no redirects, no
  caches, fixed-length body, and `errorStream` read when the status is ≥400. The
  `ApiRequest`/`ApiResponse` data classes form the seam.
- **`HttpURLConnection` does not support the `PATCH` method** (it throws a
  `ProtocolException`). Reservation modify/cancel endpoints should therefore
  accept `POST` (or `PUT`/`DELETE`), not only `PATCH`.
- JSON: `org.json` with helpers in `core/support/Json.kt` (`stringOrNull`,
  `rawStringOrNull`, `booleanOrNull`, …) and hand-written `fromJson` functions.
- `CustomerSession` mirrors iOS: one refresh shared by all callers, a retry
  after a 401, and a generation guard.
- `KeystoreTokenStorage`: an AES-GCM key held in the Android Keystore. The
  ciphertext lives in private SharedPreferences, which are excluded from backup.
  The class is about 60 lines.

### Unit tests (`app/src/test/kotlin/.../core`, JVM-only, about 77 tests)

- CustomerSessionTests (15), SupportTests (26), TenantApiClientTests (21),
  ThemeTests (15), plus a `TestSupport` fake transport and helpers
  (`jsonResponse`, `makeAccessToken`, …).
- There is no Robolectric and there are no instrumented tests. The `platform/`
  and `ui/` code has no tests.

### `scripts/gradle.sh`

- It fails with install hints if there is no `java` on PATH and no `JAVA_HOME`.
- It sources `scripts/android-sdk.sh` to find the SDK through
  `ANDROID_HOME`/`ANDROID_SDK_ROOT`, then `local.properties`, then the usual
  locations (Android Studio and `~/android-sdk` from the orb setup). If no SDK
  is found it prints
  `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`.
- Otherwise it runs `exec ./gradlew "$@"`, which downloads the Gradle 8.14.5
  distribution on first use.

---

## 3. `.agents/setup` Android toolchain (lines 80–161)

- **JDK:** if `javac -version` reports a major version below 17, it runs
  `sudo apt-get update -qq && sudo apt-get install -y -qq openjdk-17-jdk-headless`
  (Ubuntu OpenJDK 17 from the apt mirrors). It then resolves `JAVA_HOME` to
  `/usr/lib/jvm/java-17-openjdk-amd64`, exits 1 if no JDK 17+ is found, and
  appends `JAVA_HOME`/`PATH` to `~/.bash_profile`.
- **SDK root:** `${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/android-sdk}}`. No
  sudo is needed for this step.
- **cmdline-tools:** if `sdkmanager` is missing, it downloads
  `https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip`,
  unzips it into `$SDK/cmdline-tools/latest`, and appends `ANDROID_SDK_ROOT`,
  `ANDROID_HOME`, and `PATH` to `~/.bash_profile`.
- It runs `yes | sdkmanager --licenses`, then
  `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`.
- **sudo:** needed only for the apt JDK install. This machine has passwordless
  sudo, so the setup works unattended.
- **Approximate downloads:**

  | Component                                | Download    | Installed   |
  | ---------------------------------------- | ----------- | ----------- |
  | openjdk-17-jdk-headless and dependencies | ~45 MB      | ~230 MB     |
  | cmdline-tools                            | ~150 MB     | —           |
  | platform-tools                           | ~7 MB       | —           |
  | android-36 platform                      | ~65 MB      | —           |
  | build-tools 36.0.0                       | ~60 MB      | —           |
  | **SDK total**                            | **~280 MB** | **~700 MB** |

  On the first `./gradlew` run there is also the Gradle 8.14.5 distribution
  (~135 MB) and the AGP, Kotlin, R8, and lint artifacts in `~/.gradle` (~0.5–0.8
  GB). **Total: roughly 1–1.3 GB downloaded and 2–3 GB on disk.** 30 GB is free.

- **Time estimate:** about 5–10 minutes to install, and about 4–8 minutes for
  the first full build on 4 CPUs. Incremental `testDebugUnitTest` runs take well
  under a minute. The `-Xmx2048m` Gradle heap fits comfortably in 7.9 GB RAM.

---

## 4. Swift on Linux feasibility

- **Matching toolchain:** tools-version 5.9 means any Swift ≥ 5.9 works.
  Official swift.org builds for Ubuntu 24.04 exist from 5.10.1 and for 6.0, 6.1,
  and 6.2. The recommendation is **Swift 6.1 or 6.2** (language mode stays v5
  because of `swiftLanguageVersions: [.v5]`), which also gives the most complete
  FoundationNetworking async support. CI on macos-26 uses Xcode 26, which ships
  Swift 6.2, so 6.2 gives the closest parity.
- **Size:** the tarball is about 0.9–1 GB compressed and about 3 GB extracted.
  - Install options: the `swiftly` installer (no sudo, user-local) or the
    tarball plus a GPG check. Neither needs Docker.
  - System dependencies through apt (sudo):
    `binutils git gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libgcc-13-dev libncurses-dev libpython3-dev libsqlite3-0 libstdc++-13-dev libxml2-dev libz3-dev pkg-config tzdata zlib1g-dev unzip`.
  - Install time is about 5–10 minutes, mostly download.
- **What would run:** `swift build` and `swift test` in `apps/ios`. Both are
  already scoped to TenantKit only, because TenantApp is not a package target,
  so no `--target` is needed (`swift build --target TenantKit` also works).
  XCTest ships with the Linux toolchain.
- **Likely failures or risks**, because the code has never been compiled on
  Linux in CI:
  - Corelibs Foundation behaviour differences. These include `Locale`/ICU
    behaviour in `SiteLocale` tests, number formatting, `JSONSerialization` key
    ordering (tests that compare serialized bodies), `URLComponents`
    percent-encoding edge cases, and `Bundle.main.infoDictionary` being nil
    (only `TenantConfiguration.from(infoDictionary:)` touches it, and it is
    optional).
  - Swift 6 compilers report more `Sendable` diagnostics, but these are warnings
    in v5 mode.
  - `@unchecked Sendable` and `NSLock` are fine.
  - Anything SwiftUI cannot be compiled on Linux. This covers all of
    `Sources/TenantApp`, the Xcode project, asset catalogs, `.lproj` resources,
    and the Info.plist.
- **Verdict:** TenantKit (models, client, session, booking logic) can very
  likely be built and unit-tested here. Fixing the first Linux compile is
  possibly a small effort, which would itself be a useful outcome (Linux CI for
  TenantKit). **Nothing in the SwiftUI layer can be compiled or type-checked
  here.**

---

## 5. Realistic validation on this machine

### Android (after `.agents/setup`-equivalent install)

| Check                                                  | Possible here? | Notes                                                                                                                                                                                           |
| ------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `testDebugUnitTest`                                    | Yes            | JVM-only core tests. This is the main signal.                                                                                                                                                   |
| `assembleDebug`                                        | Yes            | Compiles all Kotlin, including `ui/` and `platform/`, against android.jar. This catches type and API errors in the screens.                                                                     |
| `assembleRelease bundleRelease` plus `size-report.mjs` | Yes            | Requires running `generate-tenant.mjs --tenant ci --no-api` first, like CI (ImageMagick is needed unless icon steps are skipped; CI installs it with apt). Gives exact byte budget enforcement. |
| `lintDebug`                                            | Yes            | Not run in CI, but useful: it catches `NewApi` above minSdk 26, RTL, and hardcoded text.                                                                                                        |
| `bundletool get-size`                                  | Optional       | bundletool jar, about 30 MB.                                                                                                                                                                    |
| Run on an emulator                                     | **No**         | No `/dev/kvm`. A software-only emulator is impractically slow and arm images do not run.                                                                                                        |
| UI rendering, Keystore, real HTTP from a device        | **No**         | Robolectric could cover some of it but would add a large test dependency (test-only, so no shipping bytes); it is not in the repo today.                                                        |

### iOS (after a Swift toolchain install)

| Check                                                                                                             | Possible here?                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `swift build` and `swift test` for TenantKit and new booking logic                                                | Yes                                                        |
| SwiftUI views, Xcode project, simulator, Keychain, `openURL`/`ASWebAuthenticationSession`, localization resources | **No** (needs macOS CI `ios.yml` `test` job on `macos-26`) |

### Best achievable strategy

1. Put all booking logic in the platform-neutral layer, with the same shape on
   both platforms. Add `ReservationsClient` methods to `TenantAPIClient` /
   `TenantApiClient`, models with `Decodable` / `fromJson`, and a pure
   `BookingFlow` state machine (search → slot select → hold → confirm,
   hold-expiry countdown math, alternatives, modify/cancel eligibility, error
   mapping for 409 slot taken, 410 hold expired, 422 policy, and 429). Route all
   authenticated calls through `CustomerSession.authorized`.
2. Use contract fixtures captured from a real local tenant-api. Run
   `npm run dev:tenant-api` (US :3007) plus the App against a seeded, published
   org, and hit the new public booking endpoints with curl to record JSON
   responses. Store them in one shared directory (for example
   `apps/native-fixtures/reservations/*.json`, or copied into each test
   resources folder).
   - Swift: `Bundle.module` resources need a `resources:` entry in
     Package.swift. Alternatively, embed the fixtures as string literals like
     the existing tests do.
   - Kotlin: `src/test/resources`.
   - Both platforms' unit tests parse the same fixtures.
   - A tenant-api Vitest contract test should assert that the responses still
     match those fixtures (snapshot or Zod schema), so server changes break the
     native contract loudly.
3. Run transport-level request-shape tests (method, path, headers, Origin
   binding, Bearer token, no PATCH on Android), as the existing
   `TenantApiClientTests` already do.
4. Compile-check the Android UI with `assembleDebug` plus `lintDebug`, and
   enforce bytes with `assembleRelease` plus `size-report.mjs`.
5. iOS SwiftUI correctness is only verifiable in the macOS CI job (simulator
   compile). Keep the SwiftUI views thin and close to the existing patterns to
   lower the risk of compile failures that cannot be checked locally. Optionally
   add a Linux `swift test` job to `ios.yml` once it passes here.
6. Manual device QA (emulator, phone, TestFlight) remains a required follow-up
   off this machine.

---

## 6. Proposed reservations feature (both apps)

### Server-side prerequisites (none exist yet)

- tenant-api has **no customer reservation routes**. `packages/tenant-db` has
  only `restaurant_order_reservations`, which is an order/slot capacity table,
  not table bookings. The native apps need the new public booking API to be
  designed with native clients in mind:
  - **Org binding:** resolve the org exactly like auth and orders do
    (`resolveOrganizationForBrowserAuth(Origin, {slug, host})`). Native apps
    send `Origin` set to the site origin on https, plus `slug`/`host`. Today's
    client sends the Origin header only on send-code/verify, so the client must
    also add it to the booking calls.
  - **Turnstile:** public `POST /orders` requires a Turnstile token whenever
    `TURNSTILE_SECRET_KEY` is set (`orders.ts:159-169`), and native apps cannot
    produce one without a WebView. For bookings, either require the customer
    token (phone OTP is already verified and rate-limited) and skip Turnstile
    when a valid customer Bearer token is present, or add App Attest / Play
    Integrity later. A WebView would also cost Android bytes and break the
    framework-only stance.
  - **HTTP verbs:** avoid PATCH-only endpoints, because `HttpURLConnection`
    cannot send PATCH. Use `POST /reservations/:id/modify`, `/cancel`, and
    `/late`.
  - Responses should include `holdExpiresAt` as an ISO timestamp, and the
    server's `now` so a skewed device clock does not break the countdown.
  - Provide a hosted checkout URL, plus a polling endpoint for deposit status.

### Endpoints the apps would call (proposed names)

| Method | Path                                                                                                                                | Auth     |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------- |
| GET    | `/booking/config?slug=` (locations, party size min/max, booking window, seating areas, occasions, deposit policy, waitlist enabled) | public   |
| GET    | `/booking/availability?location=&date=&party=&seating=` (slots plus alternatives on nearby times/dates)                             | public   |
| POST   | `/booking/holds` with `{location, slotStart, party, seating}` returns `{holdId, holdExpiresAt, depositRequired, checkoutUrl?}`      | customer |
| POST   | `/booking/holds/:id/confirm` with `{notes, occasion}`                                                                               | customer |
| GET    | `/reservations/me` and `/reservations/:id`                                                                                          | customer |
| POST   | `/reservations/:id/modify`, `/cancel`, `/late` with `{minutes}`                                                                     | customer |
| POST   | `/waitlist` and `/waitlist/:id/leave`                                                                                               | customer |
| GET    | `/booking/holds/:id/payment` (poll after returning from checkout)                                                                   | customer |

- **Auth model:** browsing availability is public, so a slot can be shown before
  sign-in. Holding, booking, and managing **require the customer access token**;
  the native apps have no guest booking. This matches the apps' signed-in shell,
  and the phone number comes from the verified OTP identity, so no phone field
  is needed. The token is sent as `Authorization: Bearer`, refreshed through
  `CustomerSession.authorized`, and the server checks that the token's org
  matches the resolved org (the `optionalCustomerId` pattern from `orders.ts`).

### Screens (same flow on both platforms)

1. **Reservations home**, a new entry from Profile: a "Book a table" button and
   a "My reservations" list showing upcoming and past items with status chips.
2. **Location picker**, shown only when there is more than one location.
3. **Search:** party size stepper, date strip, and time preference, followed by
   **slot chips**. When a time is full, alternative chips appear for the same
   day and nearby days. The customer can pick a seating preference
   (any/indoor/outdoor/bar) when configured.
4. **Details:** occasion (from the configured list) and notes with a length
   limit.
5. **Review and confirm:** a summary with a **hold countdown** derived from
   `holdExpiresAt` and the server time offset. On expiry the screen returns to
   search with a message.
6. **Deposit or card guarantee** (when required): open `checkoutUrl` in the
   system browser.
   - iOS uses `openURL` today; `ASWebAuthenticationSession` with a callback is
     better and can live in TenantApp.
   - Android uses `MainActivity.openUrl`, which only allows http/https
     `ACTION_VIEW` intents.
   - Neither app has deep links or URL schemes, so the simplest return path is
     to poll the payment-status endpoint when the app resumes (`onResume` /
     `scenePhase`). App Links or Universal Links would need manifest,
     entitlement, and `apple-app-site-association` work later.
7. **Confirmation:** the reservation code and details. Add-to-calendar is
   optional; on Android use `Intent.ACTION_INSERT` with no library, and on iOS
   EventKit would add a permission, so defer it.
8. **Reservation detail:** modify (re-runs the search prefilled), cancel (shows
   the policy and a confirmation), and "running late" (+10/+15/+20 minutes),
   each gated by server-sent flags such as `canModify`, `canCancel`, and
   `cancelDeadline`.
9. **Waitlist** (when enabled and no slots fit): join with party size and quoted
   wait, show status, leave.

Navigation fits the existing patterns:

- Android: add screen keys (`res:home`, `res:search`, `res:review`,
  `res:detail:<id>`, …) and a small back stack in `AppState`.
- iOS: add a `NavigationStack` inside the signed-in branch of `RootView`.

### Staying within the Android byte budget

- Headroom is about 68 KB APK and about 81 KB AAB. The current app (about 4.2k
  lines of Kotlin, 7 screens, 39 strings × 6 locales) costs about 76 KB above
  the 16 KB framework floor, so a feature of roughly the same size would consume
  most of the headroom.
- Keep the APK in budget:
  - Reuse `ThemedControls`; slot chips can be `TextView`s in a wrapping
    `LinearLayout`, with no RecyclerView.
  - Use `java.time` (API 26+ is in the framework) for dates. Do not add a date
    library.
  - Use a framework `DatePicker`/`DatePickerDialog` or a custom date strip.
  - Use `org.json` models and do not add coroutines.
  - Keep strings tight (about 60–80 new strings × 6 locales is a few KB
    compressed).
  - Add no images or vector assets beyond what is necessary.
- Measure with `assembleRelease` plus `size-report.mjs` on every iteration. If
  the feature exceeds the budget, raise `size-budget.json` in the same PR with a
  justification, as its `$comment` requires.
- iOS has no byte budget but should mirror the Android structure.
