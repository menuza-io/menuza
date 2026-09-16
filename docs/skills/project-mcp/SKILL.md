---
name: project-mcp
description:
  Guide Model Context Protocol OAuth, PKCE, client registration, hashed tokens,
  rate limits, and organization-scoped tools in this project.
---

# Project MCP

## When to use this skill

Use this skill when changing MCP discovery/metadata, OAuth authorization, client
registration, token exchange/refresh, tool invocation, API keys, scopes, rate
limits, or organization-scoped MCP data access.

## Code map

- MCP OAuth/resource metadata routes live under `apps/app/app/routes/mcp+` and
  the well-known routes.
- OAuth/token storage and authorization-code handling live in
  `apps/app/app/utils/mcp/oauth.server.ts`.
- Tool registration and organization-scoped execution live in
  `apps/app/app/utils/mcp/tools.server.ts` and `server.server.ts`.
- PKCE/types/token generation helpers are exported by `@repo/mcp`.
- MCP authorization, access-token, refresh-token, client, and API-key rows live
  in the control-plane database.

## OAuth invariants

The flow is OAuth 2.0 with short-lived authorization codes and PKCE support:

- authorization codes expire after 10 minutes and are single-use;
- access tokens expire after 1 hour and refresh tokens after 30 days;
- raw access/refresh tokens are returned only once and stored as SHA-256 hashes;
- state binds the request to the user, organization, client, and redirect URI;
- use `S256` PKCE for new clients and verify the code verifier at exchange;
- redirect URIs are restricted to registered clients, localhost callbacks, or
  the explicitly allowed MCP custom schemes.

Use `@repo/mcp` helpers or the existing server utility. Never put raw tokens in
database rows, logs, URLs, audit details, browser storage, or tool results.
Revoke the authorization and associated tokens together when access is removed.

## Tool authorization

Every tool invocation must derive the organization/user from the verified MCP
access token and enforce the same organization permission/ownership rules as the
App UI. Never accept `organizationId`, user IDs, note IDs, or channel IDs from
tool arguments as a substitute for authorization. Validate tool arguments with a
strict schema, scope reads/writes to the token’s organization, and avoid
returning fields that the tool caller does not need.

MCP tools are a server-side capability surface, not a trusted internal caller.
Apply the existing permission checks, audit important mutations, and preserve
safe error messages that do not reveal cross-organization records.

## Rate limits and protocol behavior

Keep separate limits for authorization, token, and tool-invocation paths. Return
the project’s rate-limit response with `Retry-After` when exhausted and audit
abuse without logging credentials. Keep metadata, bearer handling, content type,
and no-cache headers compatible with the current MCP client protocol.

Validate client registration and redirect URI normalization before storing a
client. Do not widen accepted custom schemes or allow arbitrary public redirect
hosts without a security review and tests.

## Testing checklist

Test discovery metadata, registration, authorization approval/denial, state and
PKCE failures, redirect open-redirect attempts, code replay/expiry, token hash
validation, refresh/revocation, rate-limit isolation by user/IP/token, tool
cross-organization denial, and audit behavior. Use the existing MCP route and
integration tests; keep tokens and test records cleaned up.

## References

- [API documentation](../../apis.md)
- [MCP package](../../../packages/mcp/index.ts)
- [MCP OAuth service](../../../apps/app/app/utils/mcp/oauth.server.ts)
- [MCP tools](../../../apps/app/app/utils/mcp/tools.server.ts)
- [MCP rate-limit tests](../../../apps/app/app/routes/mcp+/rate-limit-integration.test.ts)
