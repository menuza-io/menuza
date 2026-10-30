# Tenant customer app (`apps/customer`)

A **branded customer app** for one organization's guests, built with Expo and
React Native for iOS and Android. It reuses the same public contracts as
`apps/sites` and `apps/tenant-api`. The operator app is the separate
`apps/mobile`.

| What                                               | Where it comes from                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Branding (name, icon, theme tokens, announcements) | `GET {APP_URL}/resources/sites?slug=…\|host=…`, the same cached payload Sites SSR uses                     |
| Sign in                                            | `POST {TENANT_API}/auth/send-code` and `/auth/verify` (phone OTP, regional node)                           |
| Profile                                            | `GET {TENANT_API}/auth/me`, `POST {TENANT_API}/auth/profile` (name and email; phone fixed)                 |
| Table booking                                      | The public `/reservations/*` routes ([contract](../../docs/reservations-contract.md))                      |
| Loyalty Rewards wallet                             | The customer `/loyalty/*` routes ([docs](../../docs/loyalty.md))                                           |
| Session                                            | Access token (15 min) and rotating refresh token in `expo-secure-store`, this device only (not in backups) |

CMS pages, blocks, the menu and checkout stay on the organization's website. The
wallet links to the website to order; there is no in-app cart.

## Two build modes

|                | Un-branded (default)                                      | White-label (per tenant)                           |
| -------------- | --------------------------------------------------------- | -------------------------------------------------- |
| Tenant binding | none                                                      | `tenants/<slug>.json`, read by `app.config.ts`     |
| First launch   | asks for the site address, then loads that tenant's brand | goes straight to the tenant's branding and sign-in |
| Store listing  | one app shared by every tenant                            | one app per tenant                                 |

```bash
npm run dev -w customer                                   # un-branded, Expo SDK 58; scan with current Expo Go
CUSTOMER_TENANT=acme npx expo start                       # white-label, from apps/customer
npm run tenant -w customer -- --tenant acme               # fetch the tenant's icons
CUSTOMER_TENANT=acme CUSTOMER_ENV=production npx expo prebuild
```

**Physical device (Expo Go on your phone):** “Connect to your site” loads
branding from App at `/resources/sites`. Dev builds default to `localhost:3001`,
which on a phone means the phone itself, not your Mac. With **`npm run dev`**
running on your machine, restart the customer app after Metro connects: in
`__DEV__` it rewrites those loopback URLs to the same host Metro uses
(`debuggerHost`, usually your Mac’s Wi‑Fi IP). App must accept connections on
that IP—start the stack with:

```bash
npm run dev:lan
npm run dev -w customer
```

(`npm run dev:lan` is the same as `DEV_LAN=1 npm run dev`; Turbo forwards `DEV_LAN` to App.)
If connect still fails, set your Mac’s Wi‑Fi IP explicitly when starting Metro:

```bash
CUSTOMER_DEV_HOST=192.168.1.101 npm run dev -w customer
```

Then enter **`acme`** (org slug). Simulator/emulator can use plain `npm run dev`.

`CUSTOMER_ENV=production` points the un-branded build at the production hosts.
`CUSTOMER_BUILD_NUMBER` sets the iOS build number and Android version code. No
secrets live in tenant files.

A native app has no browser `Origin`. A white-label build sends the tenant's
public site origin (`site.origin`, https) as the `Origin` header, which is how
tenant-api knows whose customers the app may sign in. Local http development
sends the `slug`/`host` binding instead, which tenant-api accepts outside
production. Booking and loyalty calls also send `X-Client: ios | android`; the
server records channel `native`.

## Release

Store builds are **not wired up yet**. The previous native iOS and Android apps
(`apps/ios`, `apps/android`) shipped through Fastlane workflows; those were
removed with them, and this app has no `eas.json`, release workflow or release
doc. Shared CI only runs this workspace's `build` (`expo export`), `typecheck`
and `test` (Jest) scripts through Turbo. Nothing signs, uploads or submits a
build.

Shipping a store build needs:

- an EAS Build project or a CI workflow that runs `expo prebuild` (or EAS) per
  tenant,
- a per-tenant matrix taken from `tenants/*.json`, running
  `scripts/generate-tenant.mjs` for each tenant's icons before the build,
- store credentials (App Store Connect API key, Google Play service account)
  kept as CI or EAS secrets, never in tenant files.

## Layout

| Path                     | What                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `app/`                   | Expo Router routes: the tabs (reservations, rewards, profile)        |
| `components/ui/`         | The UI kit; colors come from the tenant theme (`useThemePalette`)    |
| `components/<area>/`     | Screens for auth, shell, profile, reservations and loyalty           |
| `lib/api`, `lib/session` | HTTP transport, endpoints, token refresh and secure storage          |
| `lib/app`, `lib/state`   | The app store (site, session, profile, language) and its React hooks |
| `lib/theme`              | Published site theme to native colors and fonts (OKLCH, hex, rgb)    |
| `lib/reservations`       | Booking client, models, booking flow, store and manage-token storage |
| `lib/loyalty`            | Loyalty client, wallet view, store and the website order link        |
| `lib/i18n`, `locales/`   | Lingui setup, language choice, and the six catalogs                  |
| `test/`                  | The render harness and contract fixture loaders                      |

## Tests

```bash
npm run test -w customer        # Jest, no simulator; runs in normal CI
npm run typecheck -w customer
npm run lint -w customer
```

The reservations and loyalty tests decode `packages/*/contract-fixtures` in
place. Re-record them with `npm run fixtures:reservations -w tenant-api` or
`npm run fixtures:loyalty -w tenant-api`; the contract tests fail on drift.

## Payments and links

Deposits and card guarantees open `payment.payUrl` in an in-app browser
(`expo-web-browser`: Safari View Controller on iOS, a Custom Tab on Android).
When the app returns to the foreground it asks
`GET /reservations/manage/payment`, and only that answer confirms the booking.
Pay shows only while the payment is still open; a payment under review, refunded
or failed ends with Done. The booking id of a payment in progress (never the pay
URL) is kept with the manage tokens, so after the app is killed the next launch,
and the booking's detail screen, keep polling until the status is final. There
are no deep links. A booking attempt that fails on the network is retried with
the same `Idempotency-Key`. Tokens are never logged or put in a URL.

## i18n

The app ships the same content locales as the organization sites: `en`, `ar`,
`de`, `es`, `fr` and `zh`. The language is, in order, the customer's choice
(Profile, Language), the device's preferred languages, the locale the
organization negotiated, then English. Arabic lays each screen tree out right to
left without a restart. After changing strings run
`npm run lingui:extract -w customer`, fill every `msgstr`, and run
`node scripts/check-lingui.mjs`.

## Tenant data residency

Customer PII only lives in the regional tenant-api (`us` or `ksa`) chosen from
the organization's `dataRegion`. Branding comes from the US control-plane App
payload, which carries no customer data. See
[docs/tenant-data-residency.md](../../docs/tenant-data-residency.md).
