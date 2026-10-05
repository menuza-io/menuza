# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the operator mobile companion's truth.

## Platform

adaptive

## Users

Operators managing their organizations from a phone. Not end customers: the
customer apps are separate native applications with a different auth family.

## Product Purpose

The operator app's mobile companion: sign in (password or OAuth, with
verification), finish onboarding, switch and create organizations, and manage
profile and security settings from a dashboard.

## Positioning

A deliberately thin companion: the web operator app remains the complete
surface, and this app says so (several security settings are explicitly marked
as coming soon rather than half-working).

## Operating Context

Expo with file-based routes; styling shares the design tokens (Tailwind-style
token classes); `npm run dev:mobile`. The backend is the operator app's auth and
organization API routes. JWT access with automatic refresh; tokens in the
platform secure store. Deep links through the app scheme and the product domain.

## Capabilities and Constraints

Screens (as shipped): landing, welcome, sign-in, sign-up, onboarding,
verify-code, verify-email, forgot-password, OAuth callback; dashboard tabs (Home
with quick actions and pull-to-refresh, Organizations with create and default
switch, Settings with profile and security). Shared UI kit: screen, button,
card, inputs, OTP inputs, social button, loading and error overlays, success
animation, toasts.

Constraints: one shared design language across iOS and Android; per-OS
differences are technical (keyboard avoidance, status bar), not visual. English
and Arabic catalogs with right-to-left readiness; accessibility roles, labels,
and polite live regions; haptic feedback on success and error.

## Accessibility & Inclusion

Accessibility props on interactive elements, polite live regions for async
state, and right-to-left-ready locale catalogs.
