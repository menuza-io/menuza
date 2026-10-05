# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context (user families, residency, security baseline,
principles) lives in the repository-root `PRODUCT.md`; this file holds
operator-app truth.

## Platform

web

## Users

Business operators: the staff of each organization, with seeded roles (admin,
member, viewer, guest) plus custom roles and per-permission access. Platform
staff occasionally appear through impersonation (with a visible banner and a
stop-impersonation escape). End customers never use this app; their surface is
the storefront and the native customer apps.

## Product Purpose

The operator application: the primary product surface and the most complete UI
in the template. An organization runs its whole business here: build and
publish its website, run the shop, manage customers and the message mailbox,
market with broadcasts and automations, collaborate in team chat, read reports,
and administer members, roles, integrations, and billing.

## Positioning

The only place the two data planes meet. This app provisions the regional
customer databases and displays regional customer data, but the data itself
moves browser-to-regional-API: its own servers never hold customer PII, and the
control-plane database stays customer-free by design.

## Operating Context

- React Router 8 SSR on Cloudflare Workers with D1, KV, and one Durable Object
  per organization for team chat; `npm run dev:app` (port 3001) behind the local
  HTTPS proxy.
- Hosts the authenticated job routes the cron worker calls, site publishing and
  branding-payload endpoints, media and video-source routes, and the
  per-organization MCP server.

## Capabilities and Constraints

Sidebar surface (route names as shipped):

- Dashboard, Reports (saved reports with charts and export), Notes (card,
  kanban, and table views with statuses and comments), Media library.
- Customers (regional customer list) and Mailbox (review of incoming messages
  from website forms and customer feedback, with unread counts, replies, and AI
  draft assistance).
- Marketing: Overview, Broadcasts, Automations (journeys with runs; the email
  designer is a full-screen overlay with an explicit save).
- Website: General Settings, Pages, Forms, Analytics, Branding, Announcements,
  Redirects.
- Settings: General, Members, Roles and access, Chat channels,
  Integrations, Shop, MCP Server, Notifications, Billing.
- Account level: organization list and switcher, Profile, Security.
- Auth surface: login, signup, email verification, two-factor (TOTP and backup
  codes), passkeys, OAuth providers, per-organization SSO, forgot/reset
  password, invites, waitlist and referral links.
- Onboarding checklist, trial upgrade card, feature updates feed, feedback
  modal, global AI panel, and a command menu with a search hotkey.

Constraints:

- Operator sessions live in the control plane (bcrypt cost 12, TOTP, passkeys,
  per-org SSO, honeypot CSRF); mobile and programmatic clients use JWT access
  plus refresh.
- Customers and Mailbox read regional data only through short-lived scoped
  operator tokens calling the regional API from the browser.
- Rate limiting: tiered limits plus database-backed sliding windows on the
  sensitive routes.
- Design system rule: theme tokens, existing variants, and the shared `cn()`
  utility only; the ESLint contracts restrict restyling components.

## Accessibility & Inclusion

Radix-based shared primitives, reduced-motion transitions, right-to-left sidebar
and layout via the direction provider (English and Arabic catalogs), and
light/dark/system themes without a flash of the wrong theme.

## Evidence on Hand

- Guides: `docs/permissions.md`, `docs/mailbox.md`, `docs/team-chat.md`,
  `docs/platform-marketing-email.md`, `docs/launch-checklist.md`.
