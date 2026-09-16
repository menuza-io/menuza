---
name: project-security
description:
  Guide input validation, XSS, CSP, rate limits, secrets, sessions, audit
  logging, and regional PII protection in this project.
---

# Project security

## When to use this skill

Use this skill when handling untrusted input, adding an endpoint or form,
changing cookies/auth, configuring CSP or headers, adding secrets, logging
security events, or touching tenant customer data.

## Request security order

For a protected route, fail fast: validate the request origin/host where
relevant, authenticate, resolve the organization, check authorization, parse and
validate input with Zod, then perform the side effect. Add endpoint-specific
rate limits before expensive work. Do not rely on a UI guard or client-side
validation.

Use the existing helpers in `@repo/security`, `@repo/common`, `@repo/auth`, and
the app/tenant-api route patterns. Keep error responses useful to legitimate
callers without revealing passwords, tokens, PII, database details, or whether a
protected record exists.

## Input, output, and HTML

- Validate every body, query, path parameter, header-derived value, webhook, and
  JSON payload with Zod or an existing shared schema.
- Normalize email/phone/slug values only according to the existing contract.
- React escapes text by default. Never put user-generated HTML into
  `dangerouslySetInnerHTML`; when trusted rich HTML must render, use the shared
  DOMPurify-based sanitization path (`SanitizedHtml`/content sanitization).
- Escape values in audit logs, notifications, system messages, and email
  templates. Do not log credentials or unnecessary customer PII.
- Validate uploaded file size/type/content and ownership server-side.

## Cookies and credentials

Operator sessions use the shared signed cookie storage: HttpOnly, Secure in
production, SameSite Lax, correct path/domain, and a validated `SESSION_SECRET`.
Keep session records minimal and expire/revoke them on logout, bans, password
changes, and other existing security events.

Tenant customer tokens are intentionally different: the browser stores regional
access/refresh JWTs in `localStorage` because Sites must not proxy KSA PII via
US cookies or SSR. Never “fix” this by adding a Sites BFF, Sites auth cookie, or
tenant JWT verification to Sites. Keep refresh tokens hashed with
`AUTH_HMAC_SECRET`, and keep App and tenant-api `JWT_SECRET` values separate.

## CSP, headers, and browser boundaries

Preserve the existing CSP/Helmet and security-header configuration. When adding
an external script, frame, image, font, or connect target, update the narrowest
appropriate allowlist and add a test when possible. Do not weaken CSP globally
to make a feature work. Health, downloads, private JSON, and streaming routes
need deliberate `Cache-Control` values; private or sensitive data should not be
shared by a browser/CDN.

## Abuse prevention

Use the existing layered controls:

- Honeypot checks on public forms.
- Turnstile on configured published tenant forms; server-side verification uses
  `TURNSTILE_SECRET_KEY` and allowed hostnames.
- Endpoint-appropriate rate limits, including stricter limits for login,
  password reset, OTP, translation, MCP OAuth, and public form submission.
- Origin resolution and published-only checks for tenant-site operations.
- Audit logging for security-sensitive operator actions, with integrity
  protection where configured.

Do not return different login/OTP outcomes that enumerate accounts or phone
numbers. Do not replace the tenant-api’s Origin-to-org binding with a client-
chosen organization ID.

## Secrets and regions

Read the owning app/package `.env.schema` and [secrets docs](../../secrets.md)
for canonical names. Validate required secrets at startup, keep production
secrets out of source/control-plane rows unless the existing encryption path is
used, and never print secret values.

For webhooks, verify the provider signature against the raw body before JSON
parsing and before database work. For outbound URLs, use the existing SSRF/URL
validation helpers and allowlists; never fetch a client-supplied URL directly.
For CORS, derive allowed origins from configured hosts/org resolution, not from
`Access-Control-Allow-Origin: *` on credentialed requests.

Customer phone/name/email and form submissions stay in the matching regional
tenant SQLite database. No App/Admin/Sites server, US cache, or shared control-
plane table may proxy or persist KSA customer PII.

For public-site-specific host binding, CSP, cache, forms, and shop behavior,
read [project-public-sites](../project-public-sites/SKILL.md). For MCP OAuth,
hashed tokens, and tool authorization, read
[project-mcp](../project-mcp/SKILL.md).

## References

- [Security docs](../../security.md)
- [Secrets](../../secrets.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [Content sanitization](../../../apps/app/app/utils/content-sanitization.server.ts)
- [Security package](../../../packages/security/index.ts)
- [MCP skill](../project-mcp/SKILL.md)
