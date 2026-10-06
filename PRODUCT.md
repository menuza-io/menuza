# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The template's direct user is a founder or small team who clones it as the
starting point for a new multi-tenant SaaS product, one startup idea at a time.
Everything is built so a clone is branded and shipped rather than rewritten.

Once deployed, a branded clone serves three user families, and every product
decision must respect the split:

- **Operators**: staff of each tenant organization. They sign in to the operator
  app (web, plus a mobile companion) with email and password, OAuth, SSO,
  two-factor, or passkeys, and run the business: website, catalog, orders,
  customers, marketing, team chat, reports, members and roles, billing.
- **End customers**: the customers of each tenant organization. They never use
  the operator app. They use the organization's published website, its shop and
  ordering flows, and the native customer apps, signing in with phone-number OTP
  only.
- **Platform staff**: the operator of the deployed platform. They use the admin
  console to oversee tenants, users, SSO, audit logs, GDPR requests, feature
  flags, and platform-wide marketing.

## Product Purpose

A production-ready, full-stack, multi-tenant SaaS template. Its job is to take a
startup idea from clone to launched product without rebuilding the platform
layer: authentication, organizations and permissions, website building and
publishing, storefronts, scheduled drops, ordering and payments, customer
identity, marketing, scheduled jobs, and admin tooling all work out of the box,
so the founder only builds the vertical. Success means a branded clone deploys
and sells, and the template stays reusable for the next idea.

## Positioning

Regional customer-data residency as a template-grade feature. Operator and
configuration data live in a US control-plane database; customer PII lives in an
isolated per-organization SQLite database on an independently deployed regional
node, and the customer's browser calls that regional API directly. Comparable
starters put every tenant's rows in one shared database. Here, customer data is
isolated per organization and per region, and changing an organization's data
region destroys the old tenant database instead of migrating it across borders.

## Operating Context

- Monorepo: npm workspaces + Turborepo. Node 22.18.0 and npm 10.9.0, pinned with
  Volta. macOS and Linux, arm64 and x64.
- Surfaces: operator app, admin console, marketing site, tenant storefronts,
  documentation site, operator mobile companion, native customer apps (iOS and
  Android), regional customer-data API, scheduled-jobs worker, email template
  preview, database studio, browser extension.
- One command (`npm run dev`) starts every service behind a local HTTPS proxy on
  `{brand-slug}.test` hostnames, including both regional data nodes.
- Setup applies the downstream brand and renames the template's identity,
  including native app bundle ids, package ids, configuration prefixes, and
  Keychain/Keystore service names, so a fresh clone carries no trace of the
  template brand.
- Deploy targets: Cloudflare Workers with D1, KV, R2, and Durable Objects
  (operator app, admin, marketing site, storefronts, and jobs worker). The US
  tenant API runs on a Worker with one SQLite-backed Durable Object per
  organization by default, or on an OCI VM with per-organization SQLite on a
  block volume; each additional data region uses an OCI VM. Mintlify hosts the
  docs site.
- Launch lifecycle: a launch-status phase (closed beta, public beta, launched)
  gates the waitlist and upgrade UI.
- Guides and architecture decision records live in `docs/`; the tenant data
  residency guide is canonical for anything touching customer data.

## Capabilities and Constraints

Confirmed capability surface:

- Organizations with roles and permissions (seeded admin, member, viewer, guest,
  plus custom roles), member invites, and impersonation for support.
- Website builder and publishing: per-organization pages, forms, analytics,
  branding, announcements, and redirects, published to edge-cached storefronts
  on organization subdomains and custom domains.
- Catalog module: menus, categories, items, modifier groups and options,
  per-location overrides, and point-of-sale links.
- Scheduled drops: limited-order windows with inventory limits, checkout holds,
  and pickup windows per location; storefront states upcoming, live, and closed.
- Ordering and shop: storefront ordering with pickup or delivery fulfillment,
  and a single-product shop with hosted or inline card checkout.
- Customer identity: phone-number OTP for end customers, held only in the
  regional per-organization database.
- Marketing: block-based email designer rendered at design time in the
  organization's branding; broadcasts and multi-step automations executed
  regionally.
- Team chat per organization (a Durable Object per org) with direct messages,
  groups, and attachments; notes with card, kanban, and table views; media
  library with per-organization BYO S3, a storage-migration workflow, and
  on-demand video posters and clips; saved reports; a per-organization MCP
  server; notifications; integrations.
- Platform admin: tenant oversight, user management, per-organization SSO,
  HMAC-integrity audit logs, GDPR request queue, feature flags, waitlist,
  platform-wide marketing.
- Scheduled jobs: a cron worker drives audit archival, token cleanup, and GDPR
  erasure, plus hourly engagement sync on both regional nodes; form-submission
  retention is planned but is not yet registered as a cron trigger. Cloudflare
  Workflows run storage migrations and long-running marketing journeys.

Hard constraints (durable):

- Two auth families never merge. Operators use control-plane sessions (HttpOnly
  cookies). Customers use regional phone OTP with short-lived access tokens and
  rotating refresh tokens kept in browser localStorage (or the platform secure
  store on mobile), never in storefront cookies.
- Customer PII stays in its region's per-organization database. Operator apps
  never proxy it, and the storefront has no server-side auth BFF. Changing an
  organization's data region wipes the old tenant database; there is no
  cross-region migration.
- Security baseline: bcrypt cost 12, AES-256-GCM with PBKDF2 key derivation for
  secrets, tiered rate limits plus database-backed sliding windows, honeypot
  CSRF, Zod validation everywhere, audit logging.
- Internationalization: Lingui catalogs for operator apps (English and Arabic),
  locale-prefixed storefronts in six locales with right-to-left support, and
  literal-hex colors in email (email clients render neither oklch nor CSS
  variables).
- The native customer apps have a committed byte budget; the Android app stays
  framework-only to keep it.

## Brand Commitments

- The template stays unbranded in committed files: no product name, no
  template-brand name, no vertical-specific branding in design or copy
  artifacts. Files must stay generic enough to sync to the upstream template
  repository.
- Brand identity is data, not code: product names, taglines, domains, and
  support strings interpolate from the shared brand config, and setup renames
  the native identities per deployment.

## Evidence on Hand

- Repository guides and decision records in `docs/` (deployment, launch
  checklists, tenant data residency, permissions, scheduled jobs).
- Seeded local databases and Playwright end-to-end suites covering
  authentication and primary flows.
- No testimonials, customer names, benchmarks, or press exist. Future work must
  not fabricate them.

## Product Principles

1. Limit services: if it can reasonably run inside the app instance, it does.
2. Common cases only: the template ships the common path; exotic needs belong in
   docs, not in the starter.
3. Minimize setup friction: time to production is the metric; defer third-party
   signups until they are needed.
4. Adaptable, single path: teams can swap a third-party service for self-built
   and back, but there is never more than one way to do the same thing.
5. Offline development: every external service is mockable locally.

## Accessibility & Inclusion

- Right-to-left layouts are first-class (Arabic is a shipped locale, not an
  add-on); storefronts serve six locales with locale-prefixed URLs.
- Light, dark, and system themes without a flash of the wrong theme.
- Shared UI is built on accessible primitives with reduced-motion transitions.
- Regional data residency treats customers in the Saudi data region as
  first-class users rather than an afterthought.
