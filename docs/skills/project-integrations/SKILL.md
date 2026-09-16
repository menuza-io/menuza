---
name: project-integrations
description:
  Guide OAuth integrations, encrypted connection tokens, provider adapters,
  channels, callbacks, retries, and integration tests in this project.
---

# Project integrations

## When to use this skill

Use this skill when adding or changing GitHub, Google, Jira, Linear, GitLab,
ClickUp, Notion, Asana, Trello, Slack, or another external integration, or when
changing OAuth callbacks, connection storage, channels, or note delivery.

## Use the provider abstraction

`@repo/integrations` defines the provider contract and shared OAuth manager.
Provider implementations live under
`packages/integrations/src/providers/<provider>/` and should expose the common
capabilities: authorization, callback/token handling, connection validation,
channel discovery, and posting when supported.

Keep provider-specific API quirks inside the adapter. Call sites should use
common connection/provider types and avoid branching on provider internals
unless a provider-specific capability is genuinely required.

## OAuth and token security

- Generate callback state through the shared OAuth manager.
- Validate HMAC-signed state with timing-safe comparison, expiry, provider, and
  organization/user binding, plus required PKCE values.
- Exchange authorization codes server-side; never put client secrets in the
  browser or mobile bundle.
- Encrypt stored access/refresh tokens with `INTEGRATION_ENCRYPTION_KEY`.
  Decrypt only for the one upstream call that needs them; never return or log
  raw tokens.
- Validate redirect URIs and provider responses with typed/Zod parsing.
- Revoke/delete encrypted credentials when a connection is removed or revoked.

## Connection and channel model

A connection belongs to a user/organization and maps an internal note/action to
an external channel (repository, project, board, list, or equivalent). Validate
that the current operator owns the connection and has the organization
permission before listing channels or posting. Revalidate a connection before
using stale metadata, and handle revoked scopes/tokens as a recoverable
disconnect state.

Do not treat an external channel ID or repository name from the browser as
authorization. Resolve it from the stored, authorized connection and constrain
provider requests to that selected resource.

## Reliability and tests

Bound upstream timeouts, honor provider rate limits, classify retryable versus
permanent failures, and avoid duplicate posts when a request is retried. Use
provider-specific fixtures/MSW handlers under `packages/integrations/tests`;
include malformed callbacks, bad state, encryption failures, revoked tokens,
empty channels, and upstream errors.

Add OAuth client IDs/redirect URIs to the correct App env schema and update CSP
or callback route configuration only when required. Integration setup must not
change operator sessions, tenant customer auth, or regional PII boundaries.

## References

- [Integrations package guide](../../../packages/integrations/src/README.md)
- [Integration encryption](../../../packages/integrations/src/encryption.ts)
- [OAuth manager](../../../packages/integrations/src/oauth-manager.ts)
- [Provider tests](../../../packages/integrations/tests)
