# Shipping a tenant app to Google Play

This is the runbook for putting a tenant's branded Android app on Google Play
and for shipping updates to apps that are already live.

Two things drive every decision here:

1. **The binary barely changes per tenant.** Name, icon, theme, announcements,
   and the profile screen all come from the KV-backed `/resources/sites` payload
   at runtime. A tenant build only differs by _application id, app name, icon,
   site binding, and version numbers_ — all generated from
   `tenants/<slug>.json`.
2. **Google decides when a release ships.** Uploads are instant, but a
   production release needs review (usually hours to a few days), and a
   brand-new account may first need a closed test (see below).

## What needs a new build vs. what does not

| Change                                             | New build? | Why                                           |
| -------------------------------------------------- | ---------- | --------------------------------------------- |
| Theme, colours, fonts, radius                      | No         | Fetched from `/resources/sites` (KV, 60s TTL) |
| Announcements, org name shown in-app               | No         | Same payload                                  |
| Site icon shown _inside_ the app                   | No         | Same payload                                  |
| App name on the launcher, app icon, application id | Yes        | Baked into the binary                         |
| App code (screens, auth, i18n)                     | Yes        | Binary                                        |
| Store listing text, screenshots, price             | No         | Play Console, not the binary                  |

So a tenant's day-to-day changes never touch the store. You release when _app
code_ changes, and you can release to every tenant at once with one workflow
run.

## Before the first submission (per tenant)

1. **Google Play developer account** — the tenant enrolls ($25 one-time) and
   grants you access with the _Release to production_ (or Admin) permission.
   **Use the tenant's own account**, not the platform's: Play's _Repetitive
   Content_ policy treats near-identical apps published by one developer as
   spam, and a shared account makes every tenant app look like one developer's
   submission. Separate accounts are how white-label platforms (gym, restaurant,
   bank apps) stay listed.
   - Note: **personal** accounts created after Nov 2023 must run a closed test
     with at least 12 testers who opted in for 14 continuous days before they
     can apply for production access. **Organization** accounts are exempt — for
     a tenant company, register as an organization.
2. **Application id** — agree on `com.<tenant>.app` and put it in
   `tenants/<slug>.json`. It can never change after the first upload.
3. **Play App Signing** — accept it (it is the default for new apps). Google
   holds the _app signing key_; you only manage an **upload key**. That means a
   lost upload key can be reset through Play Console instead of forcing a new
   app listing.
4. **Upload keystore** — generate one per tenant and keep it backed up (a
   password manager or the tenant's secret store):
   ```bash
   keytool -genkeypair -v -keystore acme-upload.jks -alias acme-upload \
     -keyalg RSA -keysize 4096 -validity 10000
   base64 -w0 acme-upload.jks   # → PLAY_KEYSTORE_BASE64 (macOS: base64 -i file)
   ```
5. **Play service account** — Play Console → Setup → API access → create (or
   link) a Google Cloud project → create a service account → grant it access in
   Play Console → download the JSON key. Store it, base64-encoded, as
   `PLAY_SERVICE_ACCOUNT_JSON` in a **GitHub environment named
   `tenant-<slug>`**, together with:

   | Secret / variable           | Value                                                            |
   | --------------------------- | ---------------------------------------------------------------- |
   | `PLAY_SERVICE_ACCOUNT_JSON` | the service account JSON key, base64-encoded                     |
   | `PLAY_KEYSTORE_BASE64`      | the upload keystore, base64-encoded                              |
   | `PLAY_KEYSTORE_PASSWORD`    | keystore password                                                |
   | `PLAY_KEY_ALIAS`            | key alias (`acme-upload`)                                        |
   | `PLAY_KEY_PASSWORD`         | key password                                                     |
   | `PLAY_PACKAGE_NAME`         | application id (`com.acmecoffee.app`) — a variable, not a secret |

6. **Store listing** (manual, per tenant, in Play Console): app name, short and
   full description, category, contact details, **privacy policy URL**,
   screenshots (phone + 7" and 10" tablet), feature graphic, and the store icon
   (512×512). Screenshots must show the tenant's own branding.
7. **Data safety form** — declare what the app handles. For this app that is the
   customer's **phone number**, **name**, and (optional) **email**, collected
   for account management and app functionality, **not shared** with third
   parties, encrypted in transit, and deletable on request (the tenant's site is
   where deletion is honoured). The tenant is the developer of record, so they
   own this declaration.
8. **Content rating** questionnaire (the app has no ads, no user-generated
   content, no news).
9. **Closed testing** — publish to an internal or closed track first. By
   default, `npm run android:beta` / `gh workflow run android.yml -f lane=beta`
   targets the `internal` testing track. To target the closed testing track
   (`alpha`), pass `-f track=alpha` (or set `PLAY_TRACK=alpha`). The `release`
   lane targets `production`.

## Adding a tenant to the repo

```bash
cp apps/android/tenants/acme.json apps/android/tenants/<slug>.json
# edit: slug, displayName, bundleId, site.slug/host + origin, environment,
#       and optionally iconBackground
```

Set `"release": true` when the tenant is ready for the release workflow; without
it the config is build-only (used for dry runs and CI) and the workflow refuses
to release it.

The app icon is pulled from the tenant's published site icon automatically (a
108 dp adaptive-icon foreground, composed with ImageMagick, on the tenant's
`iconBackground`). Upload a site icon in the App first, otherwise the committed
placeholder icon is used.

## Cutting a release

Everything runs from the **🤖 Android** workflow:

```bash
# Internal testing build for one tenant
gh workflow run android.yml -f tenant=acme -f lane=beta

# Production upload (a draft release in Play Console unless you pass
# -f release_status=completed)
gh workflow run android.yml -f tenant=acme -f lane=release

# Same for every tenant marked "release": true
gh workflow run android.yml -f tenant=all -f lane=beta
```

What the workflow does:

1. `./gradlew testDebugUnitTest` — the core/session unit tests.
2. `./gradlew assembleRelease bundleRelease` — R8 + resource shrinking, then the
   size report (a change that blows `size-budget.json` fails the job).
3. Per tenant: write `app/tenant.properties` + icons from `tenants/<slug>.json`,
   write the keystore from the environment secrets, then
   `bundle exec fastlane android beta|release` (`supply` uploads the AAB).
4. Upload the AAB and the R8 mapping file as workflow artifacts.

Locally (needs JDK 17 + Android SDK 36 + `bundle install`):

```bash
npm run android:tenant -w android -- --tenant acme --build-number 42
npm run android:bundle -w android
npm run android:size -w android
```

## Versioning

| Setting       | Source                                   | Rule                                                                                          |
| ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `versionName` | `tenants/<slug>.json`                    | User-visible; bump deliberately (`1.0.0` → `1.0.1`)                                           |
| `versionCode` | `((RUN_NUMBER - 1) * 100 + RUN_ATTEMPT)` | Must increase for **every** upload; attempt-aware so retries yield a strictly increasing code |

Play rejects an upload whose `versionCode` was already used for that application
id, even if the previous one was only on an internal track.

## Target API level

Play requires new apps and updates to target an API level that is no more than
one year older than the latest Android release (checked every 31 August). This
app targets **API 36** and compiles against SDK 36.

That deadline is the one place where having zero dependencies pays off twice: an
app is usually forced to raise `compileSdk` because a _library_ requires it (the
current Compose line already requires AGP 9 + SDK 37). With no libraries, the
toolchain only moves when Google's target-level rule moves.

## Size

The AAB is ~139 KB and a device downloads ~73 KB. That is worth stating in the
store listing: "under 1 MB" is a selling point in markets where data is metered.
If a future feature needs a dependency, `npm run android:size -w android` and
`size-budget.json` are the guard rails — see the README's "Why this stack".
