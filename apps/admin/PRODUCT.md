# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds admin-console truth.

## Platform

web

## Users

Platform staff only, authenticated with the platform admin role. Every admin
route is gated server-side; tenant operators and end customers have no access
here.

## Product Purpose

The internal platform console: oversight of the deployed platform and all tenant
organizations. Staff manage users (including bans and support impersonation),
configure per-organization SSO and audit retention, run platform-wide marketing,
and operate launch-phase tooling.

## Positioning

Staff-only by construction, and support impersonation is a first-class flow:
impersonating a user switches into the operator app under a visible banner with
a one-click stop.

## Operating Context

Same stack as the operator app (React Router 8 SSR on Cloudflare Workers with D1
and KV); `npm run dev` includes it (port 3005) behind the local HTTPS proxy.

## Capabilities and Constraints

Sidebar surface (route names as shipped):

- Dashboard: platform metrics (organizations, users, sessions, subscription
  stats, recent activity).
- Users (detail, ban, impersonate) and Waitlist (launch-phase signups and
  referrals).
- Organizations: tenant detail with SSO configuration, SSO users, and audit-log
  retention.
- Marketing: Overview, Broadcasts, Automations (platform-wide campaigns and
  journeys).
- Reports (saved reports) and Roles (including system roles).
- Audit Logs (HMAC-integrity viewer with export) and GDPR Requests (data-subject
  queue with per-user export).
- Feature Flags, IP Addresses, Cache (LRU and SQLite entry inspection),
  Feedback.

Constraints: control-plane data only; no customer PII surface. The operator
session is shared with the operator app on the brand domain. English and Arabic
catalogs with right-to-left layouts.

## Accessibility & Inclusion

Radix-based shared primitives, reduced-motion transitions, right-to-left layout,
and light/dark/system themes without a flash of the wrong theme.
