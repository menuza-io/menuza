---
name: project-mobile
description:
  Guide Expo operator mobile, white-label iOS/Android tenant apps, secure
  sessions, regional API use, native testing, and release tooling in this
  project.
---

# Project mobile clients

## When to use this skill

Use this skill when changing `apps/mobile`, `apps/ios`, `apps/android`, native
authentication, tenant branding/configuration, deep links, native storage,
mobile localization, or mobile build/release automation.

## Distinguish the three clients

- `apps/mobile` is the Expo/React Native operator client with Expo Router, App
  auth APIs, `expo-secure-store`, React Hook Form, and Lingui.
- `apps/ios` is a small native white-label tenant customer app. Its reusable
  `TenantKit` layer is platform-independent and Linux-testable; the SwiftUI
  shell lives in `Sources/TenantApp`.
- `apps/android` is the size-constrained native white-label tenant customer app.
  It uses Kotlin framework Views, `HttpURLConnection`, `org.json`, Android
  Keystore AES-GCM, and no AndroidX/Compose/OkHttp/coroutines.

Do not import an operator App session model into the tenant iOS/Android apps.
Native tenant apps use the same customer phone-OTP/regional tenant-api contract
as Sites, with device-secure token storage: Keychain on iOS and Keystore on
Android.

## Tenant client boundary

Branding comes from the public App payload; customer auth/profile traffic goes
to the org’s regional tenant-api. A native client has no browser Origin, so
HTTPS white-label builds send the configured public site origin as the Origin
header. Local HTTP development follows the documented slug/host binding.

Keep access tokens short-lived and refresh through the tenant API. Store refresh
credentials only in the platform secure store, clear them on logout/invalid
refresh, and never put tenant secrets or a JWT signing secret in a mobile
bundle. The US control plane must not receive customer PII from a native app.

## Expo conventions

Use Expo Router route groups (`app/(auth)`, `app/(dashboard)`), the existing
auth reducer/context, API clients, error categorizer, secure-storage/session
manager, and shared `@repo/validation`/`@repo/types` contracts. Keep API errors
actionable and distinguish validation, auth expiry, offline, retryable, and
server failures. Do not duplicate server business rules in the client.

When adding a screen, cover loading, retry, keyboard/safe-area behavior,
offline/failure state, accessibility labels, and both narrow and large device
layouts. Keep secrets out of logs and telemetry.

## Native constraints and commands

The iOS and Android packages intentionally expose opt-in scripts so normal Turbo
build/test/typecheck stays green without Xcode or the Android SDK:

```sh
npm run ios:test -w ios
npm run ios:sim -w ios
npm run android:test -w android
npm run android:run -w android
npm run android:size -w android
```

For tenant builds, use `npm run ios:tenant -w ios -- ...` or
`npm run android:tenant -w android -- --tenant <slug>` and review generated
config/icons before a release. Preserve Android’s `size-budget.json`, its
framework-only dependency constraint, and the iOS `TenantKit`/`TenantApp`
separation.

## Localization and release

Use Lingui in Expo and the six tenant locales (`en`, `ar`, `de`, `es`, `fr`,
`zh`) in the native apps. Arabic must switch layout direction and locale-aware
dates/numbers. Test deep links, TLS/cleartext rules, emulator host mapping,
tenant binding, version/bundle identifiers, and store metadata before release.

## References

- [Expo app](../../../apps/mobile/README.md)
- [iOS tenant app](../../../apps/ios/README.md)
- [Android tenant app](../../../apps/android/README.md)
- [Tenant data skill](../project-tenant-data/SKILL.md)
