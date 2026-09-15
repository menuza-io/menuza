# Tenant Android app (`apps/android`)

A **branded customer app** for a tenant (org) on this platform — the Android
sibling of [`apps/ios`](../ios). It reuses the same public contracts as
`apps/sites` and `apps/tenant-api`:

| What                                               | Where it comes from                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Branding (name, icon, theme tokens, announcements) | `GET {APP_URL}/resources/sites?slug=…\|host=…` — the same KV-cached payload Sites SSR uses |
| Sign in                                            | `POST {TENANT_API}/auth/send-code` + `/auth/verify` (phone OTP, regional node)             |
| Profile                                            | `GET {TENANT_API}/auth/me`, `POST {TENANT_API}/auth/profile`                               |
| Session                                            | Access token (15 min) + rotating refresh token, encrypted with the **Android Keystore**    |

Scope is intentionally small: a branded shell, phone-OTP login, and the customer
profile. CMS pages, blocks, and shop stay on the org's website.

## Why this stack (size first)

The goal is the **smallest possible download per tenant**, so the app is written
against the Android **framework only**: Kotlin, `android.widget` views built in
code, `HttpURLConnection`, `org.json`, `BitmapFactory`, and `AES/GCM` from the
Keystore. There is no AndroidX, no Compose, no OkHttp, no serialization library,
no image loader, no DI, no coroutines.

Measured with identical tooling (AGP 8.13.2, Kotlin 2.2.21, R8 full mode,
resource shrinking, `minSdk 26`, unsigned release), on this repo's code:

| Variant                                                                       | Release APK | Play download¹ |
| ----------------------------------------------------------------------------- | ----------- | -------------- |
| **This app** (branding + OTP + profile + 6 locales + Keystore)                | **92 KB**   | **~82 KB**     |
| Framework-only "hello" app (the floor for any native app)                     | 16 KB       | —              |
| …plus OkHttp 5 + kotlinx-serialization + Coil 2 (typical network/image stack) | 417 KB      | —              |
| …plus Jetpack Compose + Material 3 (trivial one-screen UI)                    | 777 KB      | —              |

¹ per-device size from the AAB via `bundletool get-size total` — the number a
customer actually downloads from Play.

The comparison rows are _minimal_ apps built with the same Gradle/AGP/Kotlin/R8
settings: one screen, no navigation, no real features. Compose is measured on
BOM `2025.09.00`, which is the newest line that still works with AGP 8.13 (the
current one requires AGP 9.1 + `compileSdk 37`, i.e. a toolchain migration this
app does not need).

For scale: a Flutter release APK starts around 8 MB and a React Native one
around 10 MB, and a Compose app with the usual library set lands in the low
single-digit MB. The same feature set here is under 0.1 MB, which is roughly
**50–100× smaller**, and it is the difference between "install over 3G without
thinking" and "wait for Wi-Fi".

What that costs, and the rules that keep it:

- **No Compose.** SwiftUI ships with iOS; Compose does not ship with Android, so
  it is ~700 KB of runtime in every download. The UI is ~7 screens, so
  programmatic framework views (`ui/components/ThemedControls.kt`) are enough.
  Revisit if the app grows a real navigation graph and long lists.
- **No networking/serialization libraries.** `HttpURLConnection` + `org.json`
  are in the OS. The API surface is 7 endpoints.
- **No image library.** One 36 dp brand icon is fetched with `BitmapFactory` and
  cached in an `LruCache` (`platform/ImageLoader.kt`).
- **No token storage dependency.** `androidx.security:security-crypto` is
  deprecated and ~300 KB; `platform/KeystoreTokenStorage.kt` does AES-GCM with a
  Keystore key in ~60 lines.
- **No coroutines.** Blocking core calls run on a 2-thread executor that posts
  back to the main thread (`platform/TaskRunner.kt`).
- **`kotlin/**` stdlib builtins are excluded** from packaging. They are only
  read by `kotlin-reflect`, which is not in the release dex; if a
  reflection-based library is ever added, drop that exclusion in
  `app/build.gradle.kts`.
- **Locales are limited** to the six the org sites ship
  (`resourceConfigurations`), so no locale resources are dead weight. AAB
  language splits are turned **off** (`bundle.language.enableSplit = false`)
  because the app can switch language at runtime, so every download carries all
  six locales (a few KB of strings).

`size-budget.json` + `npm run android:size -w android` fail loudly when a change
blows the budget.

### Does a Gradle app belong in this Turborepo?

Yes, the same way the Swift app does: Turbo only runs the package scripts in
`package.json`, and this app deliberately declares **no `build` / `test` /
`typecheck` scripts** so `turbo run build|test|typecheck` never tries to run
Gradle on a machine without the Android SDK. Android tasks are opt-in:

```bash
npm run android:test -w android     # JVM unit tests (core + session)
npm run android:build -w android    # debug APK
npm run android:apk -w android      # release APK (R8 + shrinking)
npm run android:bundle -w android   # release AAB for Play
npm run android:size -w android     # size report vs size-budget.json
```

## Two build modes (read this first)

|                | Un-branded (**default**)                                   | White-label (per tenant)                             |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Tenant binding | none — the build has no `site.slug`/`site.host`            | baked into the binary from `tenants/<slug>.json`     |
| First launch   | asks for the site address, then loads that tenant's brand  | goes straight to the tenant's branding and sign-in   |
| Store listing  | one app shared by every tenant                             | one app per tenant                                   |
| Used for       | local development, and the platform's own multi-tenant app | a tenant that wants its own branded app on the store |

```bash
npm run android:tenant -w android -- --tenant acme   # writes app/tenant.properties + icons
npm run android:build -w android                     # no "connect to your site" screen
```

The binding also decides tenant-api's origin check: a white-label build sends
`site.origin` as the `Origin` header, which is how the server knows which
tenant's customers the app may authenticate (see
[docs/play-store-release.md](docs/play-store-release.md)).

## Layout

```
apps/android/
├── settings.gradle.kts / build.gradle.kts   # AGP 8.13 + Kotlin 2.2, no version catalog
├── gradle.properties                        # android.useAndroidX=false
├── app/
│   ├── build.gradle.kts                     # tenant.properties → resValues, R8 + shrinking
│   ├── proguard-rules.pro
│   ├── tenant.properties                    # generated (gitignored)
│   └── src/
│       ├── main/kotlin/com/epicstartup/tenant/
│       │   ├── core/                        # platform-independent half (JVM-testable)
│       │   │   ├── config/                  # TenantConfiguration (env → URLs, data region)
│       │   │   ├── localization/            # SiteLocale + AppLanguage negotiation (i18n/RTL)
│       │   │   ├── model/                   # PublicOrganization, theme, announcements, profile
│       │   │   ├── net/                     # TenantApiClient, HttpTransport, ApiException
│       │   │   ├── session/                 # CustomerSession, TokenStorage
│       │   │   ├── support/                 # phone, JWT claims, site address, org.json helpers
│       │   │   └── theme/                   # oklch/rgb/hsl → sRGB, theme tokens
│       │   ├── platform/                    # Android adapters: Keystore, config, TaskRunner, images
│       │   └── ui/                          # Activity, state machine, components, screens
│       ├── main/res/                        # 6 locales, themes, adaptive launcher icon
│       └── test/kotlin/                     # JVM unit tests (mirrors apps/ios TenantKitTests)
├── tenants/<slug>.json                      # per-tenant build config (bundle id, name, site, version)
├── scripts/                                 # tenant config + icon generator, tenant lister, gradle wrapper, size report
├── fastlane/                                # Play upload lanes
├── docs/play-store-release.md               # publishing runbook
└── size-budget.json                         # enforced size ceiling
```

The `core` half is plain Kotlin + `org.json`, so it runs on the JVM: `core`
never imports `android.*`, and the only bridge is `RgbaColor.toArgb()`.

## Run it locally

```bash
# Unit tests (any OS, no emulator)
npm run android:test -w android
```

Then, to actually run the app on an emulator or device:

**1. Start the dev servers** (repo root):

```bash
npm run dev      # app :3001, tenant-api :3007 (US) + :3009 (KSA), sites :3008
```

**2. Create and _publish_ an organization.** The app can only sign in customers
of a published org, because publishing is what provisions that org's regional
tenant SQLite. In the App (http://localhost:3001, seeded operator `kody` /
`KodyLovesYou!2026`): pick an organization (or create one) → **Website** → turn
the **Organization site** switch on. Note the **slug** — it is the first path
segment (`/acme/website`) and it is what you type into the app. Skipping this
step makes `send-code` answer
`404 {"error":"Organization not found or DB not provisioned"}`.

**3. Start an emulator** (or plug in a phone with USB debugging on):

```bash
emulator -list-avds
emulator -avd <name> &
# or: Android Studio → Device Manager → ▶
```

**4. Build, install and launch the app:**

```bash
npm run android:run -w android
```

Android Studio users can just open `apps/android` and press ▶ — the npm script
is the CLI equivalent (Gradle's `installDebug` only installs; `android:run` also
starts the Activity and prints what to do next).

**5. In the app:** the un-branded debug build asks for a site address on first
launch — type the org's **slug** (e.g. `acme`) and press **Connect**. Then enter
a phone number (any plausible number works locally, e.g. `+15550000000`) and
read the 6-digit code from the terminal running `npm run dev`:

```
tenant-api:dev: [SMS MOCK] To: +15550000000 | Message: Your verification code is: 123456
```

SMS is mocked locally (no Twilio credentials), so the code is always in that log
line. A new number lands on the "Your name" screen, then the profile screen.

A white-label build skips the connect step:
`npm run android:tenant -w android -- --tenant ci` bakes in `site.slug`, so the
app opens straight into that tenant's branding.

### Physical device

The debug defaults point at `10.0.2.2`, which only exists inside an emulator. On
a real phone, forward the ports and build against loopback:

```bash
adb reverse tcp:3001 tcp:3001
adb reverse tcp:3007 tcp:3007
npm run android:run -w android -- -PdevHost=localhost
```

### If it does not work

| Symptom                                          | Cause                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| "Network error" on connect or sign in            | dev servers are not running, or the device cannot reach the host (3001/3007 must be listening) |
| Connect says "We couldn't find that site"        | wrong slug, or the org's site is not published                                                 |
| Sign in says "Organization not found or DB not…" | step 2 was skipped (the org's website was never published)                                     |
| The code never arrives                           | read the `[SMS MOCK]` line in the dev server output — local SMS is mocked                      |
| The request is blocked as cleartext              | endpoints must be loopback or `10.0.2.2` (see `res/xml/network_security_config.xml`)           |

`scripts/gradle.sh` finds the SDK via `ANDROID_HOME` / `ANDROID_SDK_ROOT`,
`local.properties`, or the usual install locations, and explains what to install
if none is present. Requirements: JDK 17+, Android SDK platform 36 +
build-tools 36.

## Pointing the app at a tenant

`app/tenant.properties` (generated) overrides every build default:

```properties
applicationId=com.acmecoffee.app
appName=Acme Coffee
useTls=true
appBaseUrl=app.epic-startup.com
brandDomain=epic-startup.com
tenantApiUs=tenant-us.epic-startup.com
tenantApiKsa=tenant-ksa.epic-startup.com
siteSlug=acme
siteOrigin=https://acme.epic-startup.com
iconBackground=#0F172A
```

Without it the app is un-branded: release builds target production, debug builds
target the local dev servers, and the customer connects their own site on first
launch.

A published tenant also needs `site.origin` (or `site.host`, from which the
generator derives the origin — `https://<host>`, or `http://` for a local
build): tenant-api resolves the org from the `Origin` header the app sends on
sign-in, and answers `404` without one, so `generate-tenant.mjs` fails the build
when neither is set.

## i18n

The app ships the same content locales as the org sites — `en`, `ar`, `es`,
`fr`, `de`, `zh` (`app/src/main/res/values-<locale>/strings.xml`).
`AppLanguage.resolve` picks the UI language in this order:

1. the customer's explicit choice (Profile → Language),
2. the device's preferred languages when translated,
3. the locale the org negotiated for this request (so an Arabic-only tenant gets
   Arabic chrome on an untranslated phone),
4. English.

`ar` switches the whole app to RTL: the Activity is rebuilt with a
`Configuration` whose layout direction is RTL, and every layout uses
`start`/`end` gravity and margins, so the mirroring is automatic.

## Tenant data residency

The app follows the platform rule: customer PII only ever lives in the regional
tenant-api (`us` or `ksa`) chosen from `organization.dataRegion`. Branding comes
from the US control-plane App payload, which contains no customer data, and the
customer's session is stored on the device (Keystore), never on the control
plane.

Because a native app has no browser `Origin`, `send-code`/`verify` are bound to
the tenant by sending the tenant's public site origin (`site.origin`) as the
`Origin` header for https origins — the exact origin↔org rule Sites satisfies
with its `Host` header. Local `http` development omits it and uses the body
`slug`/`host` binding that tenant-api allows outside production. No tenant-api
change was needed for native clients.

See `docs/tenant-data-residency.md` for the canonical rules.
