# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds the regional data node's truth.

## Platform

web

## Users

Four callers, no human users of its own: end customers' browsers and the native
customer apps (direct callers, never proxied through the storefront); the
control-plane apps (provisioning); operators acting on regional data through
scoped operator routes; and the cron worker (system calls).

## Product Purpose

The regional customer-data node: phone-OTP identity, per-organization SQLite,
customer profiles, orders and saved payment methods, public form intake, and
marketing journey execution, all inside the organization's data region.

## Positioning

One codebase, two production runtimes: Durable Objects for the US node, and an
OCI VM with block-volume per-organization databases for each additional region.
It is the platform's PII boundary; everything else in the platform is designed
around never crossing it.

## Operating Context

Two local nodes (one per data region) on separate ports, both started by
`npm run dev`. The organization is resolved from the request's origin or host on
the brand domain (subdomain to organization slug, with a reserved-subdomain
blocklist), from custom domains, or from body parameters outside production; an
organization must be active, published, and provisioned in this region. Health
endpoints report status and region.

## Capabilities and Constraints

- Auth: send-code (per-IP, per-phone, and global SMS caps), verify (fires
  journey triggers), rotating refresh with revocation on reuse, logout, profile,
  me. Short-lived access tokens with a 30-day refresh.
- Shop: order history and saved payment methods.
- Forms: public form definitions and submissions with Turnstile verification and
  strict per-form rate limits.
- Operator routes (short-lived scoped tokens): customers, marketing campaigns
  and metrics, forms and submissions, journeys (with publish, pause, runs), and
  mailbox (unread counts, read state, AI draft replies constrained to this
  region's AI endpoint).
- System routes (internal token): provision and deprovision per-organization
  databases, engagement sync, journey step execution, evaluation, and
  completion.

Constraints: secrets are validated at startup, and the internal and operator
tokens are distinct. Customer tokens are deliberately not HttpOnly cookies. CORS
is allow-listed for analytics origins. Per-organization SQLite never lives on
the control plane, and a region change wipes the database.

## Accessibility & Inclusion

Phone-number-first identity (no email requirement) keeps the customer account
reachable for markets where a phone number is the primary identity.
