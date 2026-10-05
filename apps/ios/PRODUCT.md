# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the iOS customer app's truth.

## Platform

ios

## Users

End customers of a tenant organization, on iPhone and iPad. They connect to the
organization's site (or arrive pre-bound in a white-label build), sign in with
their phone number and an SMS code, optionally set a name, and manage their
profile and language.

## Product Purpose

The native customer companion, deliberately small: branded shell, phone-OTP
sign-in (the same flow as the storefront's login and verify), and profile.
Published pages, blocks, and the shop stay on the organization's website by
design.

## Positioning

Two SKUs from one codebase: an un-branded app that asks for the site address and
serves every organization, and white-label per-organization builds generated
from per-tenant config. The app consumes the same published branding payload the
storefront renders, so the organization's brand arrives as data.

## Operating Context

SwiftUI app plus a Foundation-only shared Swift package (testable on Linux); the
Xcode project is generated from a manifest, not committed. App Store pipeline
through lanes and per-tenant release flags; the scripts are opt-in so non-macOS
CI stays green. Six locales with a four-step resolution order (explicit choice,
device language, organization-negotiated locale, English).

## Capabilities and Constraints

Screens (as shipped): loading, site-unavailable, connect-site, login, verify,
complete-name, profile (with language choice). Themed controls from the
organization's theme.

Constraints: session tokens in the Keychain (short-lived access plus rotating
refresh). Customer PII only ever moves to the organization's regional API; the
branding payload comes from the control plane and carries no customer data.
Native apps have no browser Origin, so white-label builds send the site origin
as a header on auth calls. Arabic flips the entire layout right-to-left and
localizes number and date formatting. The template's identity is renamed per
brand on setup (bundle ids, config prefixes, Keychain service names).
