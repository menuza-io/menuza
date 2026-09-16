---
name: project-sso
description:
  Guide organization OIDC/SSO configuration, discovery, ID-token validation,
  provisioning, encryption, and health checks in this project.
---

# Project SSO

## When to use this skill

Use this skill when changing organization SSO setup, OIDC login/callbacks,
provider discovery, JWKS validation, SSO users/sessions, enforcement, health
checks, or encrypted identity-provider configuration.

## Code boundaries

- Admin owns configuration and platform-level SSO administration under
  `apps/admin/app/routes/_admin+/organizations+/$organizationId_+/sso.*`.
- App owns the operator login/callback experience under
  `apps/app/app/routes/_auth+/auth.sso.$organizationSlug*` and enforcement.
- `@repo/sso` owns reusable OIDC discovery, ID-token validation, bounded caches,
  connection pooling, retries, and health-check primitives.
- Database rows hold encrypted provider secrets/configuration through the
  existing service. Never expose client secrets or raw tokens to React props,
  logs, audit metadata, or API responses.

## OIDC flow

Preserve the provider-bound flow:

1. Resolve the organization and confirm SSO is enabled for it.
2. Load/decrypt the org configuration on the server.
3. Discover endpoints from the normalized issuer when configured; use the
   package cache/retry/connection-pool behavior.
4. Generate signed state and use the configured redirect URI/PKCE behavior.
5. Exchange the callback code server-side.
6. Validate the ID token signature against JWKS, issuer, audience, expiry, and
   the flow’s state/nonce requirements.
7. Map the identity to an existing/provisioned organization user according to
   policy, then create the normal operator session.

Do not accept an unverified email/subject from the browser, skip issuer/audience
checks for convenience, or use a tenant customer JWT as an operator SSO token.
Return generic callback errors to users and log only safe diagnostic context.

## Configuration and operations

`SSO_ENABLED` gates the feature. `SSO_ENCRYPTION_KEY` protects IdP secrets and
must be configured/validated in the runtimes that read SSO configuration. Use
the Admin connection-test action and health checker rather than printing
credentials or manually mutating rows.

Config changes must invalidate the org’s SSO cache and be audit logged. Health
checks should cover discovery, token/JWKS reachability, configuration validity,
cache state, and connection-pool state without an unbounded retry storm.

## Testing checklist

Cover issuer normalization/discovery, malformed or expired ID tokens, bad
signatures/audience/issuer, state/PKCE failures, disabled SSO, unauthorized
organization users, provisioning policy, logout, cache invalidation, and safe
error/audit behavior. Use existing SSO unit and App/Admin route tests; do not
call live identity providers in CI.

## References

- [SSO configuration](../../sso-configuration-guide.md)
- [SSO deployment](../../sso-deployment-guide.md)
- [SSO troubleshooting](../../sso-troubleshooting-guide.md)
- [SSO package](../../../packages/sso/index.ts)
- [App SSO route](../../../apps/app/app/routes/_auth+/auth.sso.$organizationSlug.ts)
