---
name: project-mobile
description:
  Guide the Expo operator app, the white-label Expo customer app, secure
  sessions, regional API use, mobile testing, and release tooling in this
  project.
---

# Project mobile clients

## When to use this skill

Use this skill when changing `apps/mobile` or `apps/customer`, mobile
authentication, tenant branding/configuration, deep links, secure storage,
mobile localization, or mobile build/release automation.

## Distinguish the two clients

- `apps/mobile` is the Expo/React Native operator client with Expo Router, App
  auth APIs, `expo-secure-store`, React Hook Form, and Lingui.
- `apps/customer` is the Expo/React Native white-label tenant customer app:
  branded shell, connect-to-site or a bound tenant, phone OTP, profile and
  language, table booking, and the Loyalty Rewards wallet. Platform-free logic
  (API clients, stores, session, theme) lives in `lib/` and is tested with Jest
  without a simulator; screens live in `app/` and `components/`.

Do not import an operator App session model into the customer app. It uses the
same customer phone-OTP/regional tenant-api contract as Sites, with the session
in `expo-secure-store` (Keychain on iOS, Keystore on Android) and excluded from
device backups.

## Tenant client boundary

Branding comes from the public App payload (`/resources/sites`, the
organization's published `theme`); customer auth/profile, booking and loyalty
traffic goes to the org’s regional tenant-api. A native client has no browser
Origin, so HTTPS white-label builds send the configured public site origin as
the Origin header. Local HTTP development follows the documented slug/host
binding.

Keep access tokens short-lived and refresh through the tenant API. Store refresh
credentials only in the platform secure store, clear them on logout/invalid
refresh, and never put tenant secrets or a JWT signing secret in a mobile
bundle. The US control plane must not receive customer PII from a mobile app.

## Expo conventions

Operator app: use Expo Router route groups (`app/(auth)`, `app/(dashboard)`),
the existing auth reducer/context, API clients, error categorizer,
secure-storage/session manager, and shared `@repo/validation`/`@repo/types`
contracts.

Customer app: use the UI kit in `components/ui` (colors come from the tenant
theme through `useThemePalette`), the app store hooks (`useAppStore`,
`useLoyalty`, `useReservations`), and the domain packages (`@repo/loyalty`,
`@repo/reservations`, `@repo/zoned-time`) instead of re-implementing rules.
Contract tests read `packages/*/contract-fixtures` in place.

Keep API errors actionable and distinguish validation, auth expiry, offline,
retryable, and server failures. When adding a screen, cover loading, retry,
keyboard/safe-area behavior, offline/failure and empty states, accessibility
labels and roles, right-to-left layout, and both narrow and large devices. Keep
secrets out of logs and telemetry.

## Commands

```sh
npm run test -w customer        # Jest (normal CI runs it)
npm run typecheck -w customer
npm run lint -w customer
npm run lingui:extract -w customer
npm run tenant -w customer -- --tenant <slug>   # white-label icons
CUSTOMER_TENANT=<slug> npx expo prebuild        # white-label native project
```

Simulator and device builds need Xcode or the Android SDK. Review the generated
config and icons before a release.

## Localization and release

Use Lingui in both Expo apps. The customer app ships the six tenant locales
(`en`, `ar`, `de`, `es`, `fr`, `zh`); Arabic switches layout direction per
screen tree, and dates/numbers are locale-aware. Test deep links, TLS/cleartext
rules, emulator host mapping, tenant binding, version/bundle identifiers, and
store metadata before release.

## References

- [Operator app](../../../apps/mobile/README.md)
- [Customer app](../../../apps/customer/README.md)
- [Tenant data skill](../project-tenant-data/SKILL.md)
