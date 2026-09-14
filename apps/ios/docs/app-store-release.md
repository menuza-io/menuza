# Shipping a tenant app to the App Store

This is the runbook for putting a tenant's branded app on the App Store and for
shipping updates to apps that are already live.

Two things drive every decision here:

1. **The binary barely changes per tenant.** Name, icon, theme, announcements,
   and the profile screen all come from the KV-backed `/resources/sites` payload
   at runtime. A tenant build only differs by _bundle id, app name, icon, site
   binding, and version numbers_ — all generated from `tenants/<slug>.json`.
2. **Apple decides when a release ships.** Uploads are instant, but going live
   needs App Review (usually < 48h, sometimes days). Nothing in this pipeline
   can make that faster.

## What needs a new build vs. what does not

| Change                                           | New build? | Why                                           |
| ------------------------------------------------ | ---------- | --------------------------------------------- |
| Theme, colours, fonts, radius                    | No         | Fetched from `/resources/sites` (KV, 60s TTL) |
| Announcements, org name shown in-app             | No         | Same payload                                  |
| Site icon shown _inside_ the app                 | No         | Same payload                                  |
| App name on the home screen, app icon, bundle id | Yes        | Baked into the binary                         |
| App code (screens, auth, i18n)                   | Yes        | Binary                                        |
| Store listing text, screenshots, price           | No         | App Store Connect, not the binary             |

So a tenant's day-to-day changes never touch the store. You release when _app
code_ changes, and you release to every tenant at once with one workflow run.

## Before the first submission (per tenant)

1. **Apple Developer Program** — the tenant enrolls ($99/yr) and adds you as
   Admin or App Manager. **Use the tenant's own account**, not the platform's:
   Apple's Guideline 4.3 (spam) explicitly calls out "publishing white-label
   apps under your own Developer Account" and "submitting several similar apps
   across multiple accounts" as spam signals. Separate accounts make each app a
   different developer's submission, which is how white-label platforms (gym,
   restaurant, credit-union apps) stay in the store.
2. **Bundle id** — agree on `com.<tenant>.app` and put it in
   `tenants/<slug>.json`. It can never change after the first upload.
3. **App Store Connect API key** — App Store Connect → Users and Access →
   Integrations → App Store Connect API → generate a key with **App Manager**
   (Admin if you want the pipeline to create the app record). Store it in a
   **GitHub environment named `tenant-<slug>`** as:
   - `ASC_KEY_ID` — the key's Key ID
   - `ASC_ISSUER_ID` — the issuer id
   - `ASC_KEY_CONTENT` — the `.p8` file, base64-encoded
     (`base64 -i AuthKey_XXX.p8 | pbcopy`)
4. **App record** — either create the app in App Store Connect by hand, or run
   the setup lane once (needs the API key in the environment):
   ```bash
   cd apps/ios && bundle install
   bundle exec fastlane ios setup_app
   ```
5. **Store metadata** (manual, per tenant, in App Store Connect): name,
   subtitle, category, description, keywords, support/privacy URLs, screenshots
   for the required device sizes, age rating, and **App Privacy details**.
   Screenshots must show the tenant's own branding — reviewers compare them
   against the app.
6. **DSA trader status** — required to distribute in the EU; the tenant supplies
   their trader details in App Store Connect.
7. **Review notes** — explain what makes this app distinct: the tenant's own
   customers, own content, own branding. Reviewers ask under 4.3.

## Adding a tenant to the repo

```bash
cp apps/ios/tenants/acme.json apps/ios/tenants/<slug>.json
# edit: slug, displayName, bundleId, appleTeamId, site.slug/host + origin, environment
```

Set `"release": true` when the tenant is ready for the release workflow; without
it the config is build-only (used for dry runs and CI).

The app icon is pulled from the tenant's published site icon automatically.
Upload one in the App (site settings) first, otherwise the committed placeholder
icon is used.

## Cutting a release

Everything runs from the **🍎 iOS** workflow:

```bash
# TestFlight build for one tenant
gh workflow run ios.yml -f tenant=acme -f lane=beta

# App Store upload (binary only; submit manually in App Store Connect)
gh workflow run ios.yml -f tenant=acme -f lane=release

# Same for every tenant marked "release": true
gh workflow run ios.yml -f tenant=all -f lane=beta
```

What the workflow does:

1. `swift test` — TenantKit unit tests.
2. `xcodebuild` a **simulator** build of the app target (the only place the
   SwiftUI code is compiled, since Xcode is macOS-only).
3. Per tenant: generate `Config/Generated/Tenant.xcconfig` + app icon, run
   XcodeGen, then `fastlane ios beta|release` with the tenant's API key. Release
   builds start from `Config/Release.xcconfig` (production hosts, TLS on) and
   the tenant file is included last, so it wins over both defaults.
4. Upload the `.ipa` and dSYMs as workflow artifacts.

Locally (needs macOS + Xcode 26 + `bundle install`):

```bash
cd apps/ios
npm run ios:tenant -w ios -- --tenant acme --build-number 42
npm run ios:generate -w ios
open EpicTenantApp.xcodeproj          # or: npm run ios:sim -w ios
```

## Versioning

| Setting                   | Source                | Rule                                                |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `MARKETING_VERSION`       | `tenants/<slug>.json` | Bump deliberately for a user-visible release        |
| `CURRENT_PROJECT_VERSION` | `github.run_number`   | Must increase for every upload to App Store Connect |

Because the build number comes from the run number, re-running the same commit
still produces a fresh, uploadable build.

## Toolchain requirements

Apple has rejected uploads built with older SDKs since **April 28, 2026**: new
submissions must be built with **Xcode 26 / the iOS 26 SDK**. The workflow pins
`macos-26`, which ships Xcode 26.x by default. If a release fails with
`ITMS-90725` (SDK version), check `xcodebuild -version` in the run and update
the runner label or `DEVELOPER_DIR`.

## Ownership models

| Model                            | Who owns the listing | Cost              | 4.3 risk | Notes                                                                                                    |
| -------------------------------- | -------------------- | ----------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| **Tenant account (recommended)** | Tenant               | $99/yr per tenant | Low      | Each app ships under its own developer; secrets live in the tenant's GitHub environment                  |
| Platform account                 | You                  | $99/yr total      | **High** | Apple treats many similar apps from one account as spam; account-level risk                              |
| Single multi-tenant app          | You                  | $99/yr total      | None     | One listing for all tenants; customers connect their site in-app (this is the default, un-branded build) |

If a tenant refuses to enroll, the honest options are the single multi-tenant
app or a PWA — not publishing their brand from the platform account, which risks
the whole developer account.

## Known gaps (deliberate)

- **Store metadata is manual.** `fastlane` only uploads the binary
  (`skip_metadata: true`); metadata, screenshots, and submission are deliberate
  steps in App Store Connect. Automate later with `fastlane deliver` once each
  tenant's metadata is stable.
- **No push notifications.** Adding them needs per-tenant APNs keys and the push
  entitlement — a separate decision.
- **No Google Play.** Same model would apply (`fastlane supply` + a service
  account per tenant).
- **App icon is a placeholder** until a tenant's site icon is published; the
  platform's own build has no designed icon yet.
- **Apple requires in-app account deletion** (Guideline 5.1.1(v)) for apps that
  let users create accounts. The app signs customers in with phone OTP, so a
  "Delete account" action is required before the first submission — tenant-api
  does not expose that endpoint yet.
