# Tenant iOS app (`apps/ios`)

A **branded customer app** for a tenant (org) on this platform. It reuses the
same public contracts as `apps/sites` and `apps/tenant-api`:

| What                                               | Where it comes from                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Branding (name, icon, theme tokens, announcements) | `GET {APP_URL}/resources/sites?slug=…\|host=…` — the same KV-cached payload Sites SSR uses |
| Sign in                                            | `POST {TENANT_API}/auth/send-code` + `/auth/verify` (phone OTP, regional node)             |
| Profile                                            | `GET {TENANT_API}/auth/me`, `POST {TENANT_API}/auth/profile`                               |
| Session                                            | Access token (15 min) + rotating refresh token, stored in the **Keychain**                 |

Scope is intentionally small: a branded shell, phone-OTP login, and the customer
profile. CMS pages, blocks, and shop stay on the org's website.

## Two build modes (read this first)

|                | Un-branded (**default**)                                   | White-label (per tenant)                             |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| Tenant binding | none — `EPIC_SITE_SLUG` / `EPIC_SITE_HOST` are empty       | baked into the binary from `tenants/<slug>.json`     |
| First launch   | asks for the site address, then loads that tenant's brand  | goes straight to the tenant's branding and sign-in   |
| Store listing  | one app shared by every tenant                             | one app per tenant                                   |
| Used for       | local development, and the platform's own multi-tenant app | a tenant that wants its own branded app on the store |

`npm run ios:sim` builds the **un-branded** app, which is why it asks for a site
address on first launch. To build the branded app — where the tenant is already
known and nothing is asked — generate a tenant config first:

```bash
npm run ios:tenant -w ios -- --tenant acme   # writes Config/Generated/Tenant.xcconfig
npm run ios:sim -w ios                       # no "connect to your site" screen
```

The binding also decides tenant-api's origin check: a white-label build sends
`EPIC_SITE_ORIGIN` as the `Origin` header, which is how the server knows which
tenant's customers the app may authenticate (see
[docs/app-store-release.md](docs/app-store-release.md)).

## Does Turbo support a Swift app?

Turbo does not need to understand Swift — it runs the package scripts declared
in `package.json`. This app therefore participates in the monorepo the same way
the Expo app does:

```bash
npm run ios:test  -w ios   # swift test   (macOS and Linux)
npm run ios:build -w ios   # swift build  (macOS and Linux)
npm run ios:generate -w ios        # xcodegen generate  (macOS)
npm run ios:xcode:build -w ios     # xcodebuild         (macOS + Xcode)
```

Two deliberate choices keep CI green:

1. **No `build` / `test` / `typecheck` scripts.**
   `turbo run build|test|typecheck` would otherwise try to run Swift on Linux CI
   runners, where Xcode does not exist. iOS tasks are opt-in via the `ios:*`
   scripts.
2. **Xcode project is generated, not committed.** `project.yml` (XcodeGen) is
   the source of truth, so the repo has no binary `.xcodeproj` to merge.

## Releasing to the App Store / TestFlight

`apps/ios` is set up to ship a **branded app per tenant** (white-label) or one
un-branded app where customers connect their own site:

```bash
npm run ios:tenants -w ios                        # list tenant configs
npm run ios:tenant -w ios -- --tenant acme        # write Config/Generated + app icon
gh workflow run ios.yml -f tenant=acme -f lane=beta     # TestFlight
gh workflow run ios.yml -f tenant=acme -f lane=release  # App Store upload
```

- Per-tenant builds are described by `tenants/<slug>.json` (bundle id, app name,
  site binding, version) — no secrets in the repo; App Store Connect keys live
  in a GitHub environment named `tenant-<slug>`.
- The app icon is pulled from the tenant's published site icon; theme, colours,
  announcements, and the in-app name keep coming from the API at runtime, so
  most tenant changes never need a store release.
- The **🍎 iOS** workflow runs TenantKit tests plus a simulator build on every
  PR, and the release lanes on manual dispatch (`macos-26`, Xcode 26 — Apple's
  current minimum for uploads).

Full runbook, including Apple account ownership and the Guideline 4.3 (spam)
implications of white-label apps:
**[docs/app-store-release.md](docs/app-store-release.md)**.

## Layout

```
apps/ios/
├── Package.swift              # TenantKit (Foundation only) + tests
├── project.yml                # XcodeGen spec for the iOS app target
├── Config/Debug.xcconfig      # local dev endpoints (includes the tenant file last)
├── Config/Release.xcconfig    # production endpoints (includes the tenant file last)
├── Config/Shared.xcconfig     # identity + version defaults
├── tenants/<slug>.json        # per-tenant build config (bundle id, name, site, version)
├── scripts/                   # tenant config + app icon generator, tenant lister
├── fastlane/                  # TestFlight / App Store lanes
├── docs/app-store-release.md  # publishing runbook (accounts, 4.3 risk, versioning)
├── Sources/
│   ├── TenantKit/             # platform-independent core (Linux-testable)
│   │   ├── Configuration/     # TenantConfiguration (env → URLs, data region)
│   │   ├── Localization/      # SiteLocale + AppLanguage negotiation (i18n/RTL)
│   │   ├── Models/            # PublicOrganization, theme, announcements, profile
│   │   ├── Networking/        # TenantAPIClient, HTTPTransport, APIError
│   │   ├── Session/           # CustomerSession, Keychain TokenStorage
│   │   ├── Support/           # phone, JWT claims, site address parsing
│   │   └── Theme/             # oklch/rgb/hsl → sRGB, theme tokens
│   └── TenantApp/             # SwiftUI app (Xcode only)
│       ├── AppState.swift     # branding + auth + profile state machine
│       ├── Theme/             # SiteTheme → SwiftUI palette
│       ├── Components/        # themed cards, fields, buttons, brand header
│       ├── Views/             # root, connect, login, verify, name, profile
│       └── Resources/         # Info.plist + en/ar/de/es/fr/zh .lproj strings
└── Tests/TenantKitTests/      # unit tests, runnable on Linux (`npm run ios:test -w ios`)
```

## Running it

```bash
# Core package (works on macOS and Linux)
npm run ios:test -w ios

# iOS app (macOS + Xcode + XcodeGen)
brew install xcodegen
npm run ios:open -w ios     # generate the project and open it in Xcode (then ⌘R)
npm run ios:sim -w ios      # or: build, boot the simulator, install, and launch
```

`npm run ios:sim` is the CLI equivalent of ⌘R — note that `xcodebuild build`
alone only compiles, it never installs or launches the app. It accepts a device
name (`npm run ios:sim -w ios -- "iPhone 17"`) and falls back to the first
available iPhone if the requested one is not installed.

Local development expects the usual dev servers: App on `:3001` and tenant-api
on `:3007` (US) / `:3009` (KSA), as configured by `Config/Debug.xcconfig`.

## Pointing the app at a tenant

`Config/Debug.xcconfig` ships local defaults; `Config/Release.xcconfig` ships
production hosts. A white-label build sets the tenant's binding (normally
through `tenants/<slug>.json` — see the release section above):

```
EPIC_USE_TLS = YES
EPIC_APP_BASE_URL = app.epic-startup.com
EPIC_TENANT_API_US_BASE_URL = tenant-us.epic-startup.com
EPIC_TENANT_API_KSA_BASE_URL = tenant-ksa.epic-startup.com
EPIC_BRAND_DOMAIN = epic-startup.com
EPIC_SITE_SLUG = acme
EPIC_SITE_ORIGIN = https:/$()/acme.epic-startup.com   # `//` starts a comment in xcconfig
```

Leave `EPIC_SITE_SLUG`/`EPIC_SITE_HOST` empty and the app asks the customer for
their site address on first launch instead.

## i18n

The app ships the same content locales as the org sites — `en`, `ar`, `es`,
`fr`, `de`, `zh`
(`Sources/TenantApp/Resources/<locale>.lproj/Localizable.strings`).
`AppLanguage.resolve` picks the UI language in this order:

1. the customer's explicit choice (Profile → Language),
2. the device's preferred languages when translated,
3. the locale the org negotiated for this request (so an Arabic-only tenant gets
   Arabic chrome on an untranslated phone),
4. English.

`ar` also switches the whole app to RTL (`layoutDirection`) and localizes number
and date formatting through the `Locale` environment value.

## Tenant data residency

The app follows the platform rule: customer PII only ever lives in the regional
tenant-api (`us` or `ksa`) chosen from `organization.dataRegion`. Branding comes
from the US control-plane App payload, which contains no customer data.

Because a native app has no browser `Origin`, `send-code`/`verify` are bound to
the tenant by sending the tenant's public site origin (`EPIC_SITE_ORIGIN`) as
the `Origin` header for https origins — the exact origin↔org rule Sites
satisfies with its `Host` header. Local `http` development omits it and uses the
body `slug`/`host` binding that tenant-api allows outside production. No
tenant-api change was needed for native clients.
