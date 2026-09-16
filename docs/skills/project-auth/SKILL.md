---
name: project-auth
description:
  Guide authentication, sessions, OAuth, passkeys, 2FA, and regional customer
  auth in this multi-app project.
---

# Project authentication

## When to use this skill

Use this skill when implementing or changing operator login, signup, logout,
email verification, password reset, OAuth/SSO, passkeys, TOTP, sessions, or
customer phone authentication on tenant sites.

## First identify the auth boundary

There are two deliberately separate systems:

| Actor     | Apps                     | Storage and token shape                                                                         |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| Operators | `apps/app`, `apps/admin` | US control-plane SQLite; signed HttpOnly session cookie via `@repo/auth`                        |
| Customers | `apps/sites`             | Regional per-org SQLite behind `apps/tenant-api`; access/refresh JWTs in browser `localStorage` |

Do not move customer phone, name, email, or tokens into the control plane. Sites
must call the matching regional tenant-api directly; there is no Sites auth BFF.
Read [tenant data residency](../../tenant-data-residency.md) before changing
tenant auth, cookies, or PII flows.

## Operator authentication

Use the shared package rather than implementing session logic in an app:

```typescript
import { requireAnonymous, requireUserId } from '@repo/auth'

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	return { userId }
}
```

- `requireUserId(request)` redirects unauthenticated users to `/login` and
  preserves the return location.
- `getUserId(request)` returns an ID or `null` when a route can be public.
- `requireAnonymous(request)` protects login/signup-only pages.
- `logout({ request })` destroys the cookie session and removes the database
  session.
- Use `@repo/auth` for password hashing, provider signup/login, passkeys,
  verification records, TOTP, backup codes, and impersonation behavior.
- Organization OIDC/SSO has its own package and configuration flow; read
  [project-sso](../project-sso/SKILL.md) before changing SSO callbacks or IdP
  secrets.

Operator sessions contain a session ID, not roles, permissions, passwords, or a
full user record. The cookie is signed, `httpOnly`, `secure` in production,
`sameSite: 'lax'`, and scoped through the shared cookie-domain helpers. Keep
`SESSION_SECRET` configured and validated; never create a second session format
in an app route.

## Auth flow conventions

- Validate credentials and form data with Zod before database work.
- Authenticate and authorize near the beginning of a loader/action.
- Use `BASE_URL` for callback URLs and public operator origins.
- Provider strategies live in `packages/auth/src/providers/`; existing provider
  routes are under `apps/app/app/routes/_auth+` and `api+`.
- Passkey changes must preserve challenge, origin, RP ID, counter, and user
  binding checks. Follow the existing settings manager and tests.
- TOTP and email verification use the shared verification model and utilities;
  do not store secrets in route code or client state.
- Password hashes use bcrypt cost 12. Do not lower the cost factor.

## Customer phone authentication

Customer flows are browser-to-tenant-api calls:

1. Sites inject the org’s regional API URL in `SiteLayout.astro`.
2. `apps/sites/src/lib/client-auth.ts` sends phone OTP, verifies it, refreshes,
   and logs out through the regional API.
3. `apps/tenant-api` resolves the organization from the request `Origin` and
   slug/custom host, checks `DATA_REGION`, and writes the per-org SQLite DB.
4. Tokens remain in `localStorage`; they are never Sites cookies or SSR data.

Do not add `apps/sites/src/pages/api/auth/`, give Sites a JWT secret, accept a
client-chosen org ID for auth, or proxy KSA PII through a US server. Access
tokens last 15 minutes and refresh tokens last 30 days; refresh tokens are
stored hashed with `AUTH_HMAC_SECRET`.

## References

- [Authentication docs](../../authentication.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [Sessions ADR](../../decisions/007-sessions.md)
- [Passkeys ADR](../../decisions/039-passkeys.md)
- [TOTP ADR](../../decisions/014-totp.md)
- [SSO skill](../project-sso/SKILL.md)
