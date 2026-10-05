# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the Android customer app's truth.

## Platform

android

## Users

End customers of a tenant organization on Android: the same scope as the iOS app
(connect, phone-OTP sign-in, name, profile, language).

## Product Purpose

The Android sibling of the iOS customer app: the same screens, contracts, and
flows against the same regional API, at a fraction of the download size.

## Positioning

A committed byte budget as product doctrine: roughly a 92 KB release APK (about
82 KB downloaded from the store), enforced in CI. The app is deliberately
framework-only Kotlin (programmatic views, platform HTTP and JSON, Keystore
crypto; no AndroidX, Compose, OkHttp, Glide, or coroutines). If a change needs
more room, the budget file changes in the same pull request, with the reason
stated.

## Operating Context

Gradle and Kotlin; debug builds target the local proxy through the emulator's
host alias (with port reversing for physical devices); cleartext is allowed only
for loopback. Store release via app bundle with language splits disabled (the
app switches language at runtime). Opt-in scripts keep non-Android CI green.

## Capabilities and Constraints

Screens (as shipped): loading, failed, connect, login, verify, name, profile.
Core logic is pure JVM Kotlin (no Android imports), mirrored with the iOS app's
model. Themed controls mirror the storefront tokens; an announcement banner
mirrors the site's.

Constraints: session tokens in the Android Keystore (AES-GCM); the same
data-residency rules as iOS (regional API only, site origin sent as the Origin
header); process-wide state survives rotation and language switches; local SMS
is mocked in development. Six locales; Arabic rebuilds the activity
right-to-left.
