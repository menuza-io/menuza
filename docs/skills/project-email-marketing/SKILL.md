---
name: project-email-marketing
description:
  Guide transactional email, platform campaigns, tenant marketing, block-based
  email design, merge tags, and engagement tracking in this project.
---

# Project email and marketing

## When to use this skill

Use this skill when changing email delivery, templates, broadcasts, campaigns,
automation/journey email nodes, merge tags, branding, unsubscribe behavior,
Resend/OCI engagement, or tenant customer email.

## Keep audiences and providers separate

| Surface                               | Audience         | Runtime/provider                                  |
| ------------------------------------- | ---------------- | ------------------------------------------------- |
| `@repo/email` transactional           | operators/users  | App/Admin; `EMAIL_PROVIDER` selects Resend or OCI |
| Admin `/marketing` platform campaigns | tenant operators | US control plane; Resend or OCI                   |
| App `/marketing` tenant campaigns     | tenant customers | matching regional tenant-api; OCI only            |

Customer email contains PII and must be sent from the regional tenant-api. Do
not route KSA customer messages through App, Admin, jobs-cron, or a Sites BFF.
Platform/operator mail may use the control plane.

## Sending and environment

`sendEmail()` in `@repo/email` owns the provider switch. Keep provider-specific
credentials in the runtime that sends the message and validate them through the
existing env schemas. Local/E2E `MOCKS=true` uses the existing MSW fixtures; do
not call real providers from tests.

Provider engagement behavior differs:

- Resend platform messages are correlated by tags and handled at App
  `/api/resend/webhook` after signature verification.
- OCI platform metrics are synchronized from OCI Logging by the marketing
  package when metrics are loaded.
- Tenant engagement sync runs on the regional tenant-api at
  `POST /api/marketing/sync-engagement`, including the hourly jobs-cron fanout
  to both configured regional URLs.

Use `@repo/config/marketing-email` helpers for correlation tags/headers. Do not
hard-code the brand slug into provider tags, and do not log message bodies,
tokens, or recipient PII unnecessarily.

## Block-based HTML is rendered at design time

The source of truth is the validated block array from
`packages/common/src/email-blocks.ts` (heading, body/paragraph text, image,
button). `@repo/marketing` and `@repo/email/marketing` render `{ html, text }`
with `renderMarketingEmail()`.

When saving a broadcast or automation email node:

1. Parse and validate blocks with the shared schema.
2. Resolve branding through `email-theme.ts` (email-safe hex literals, not CSS
   variables or `oklch()`).
3. Render and persist `content_html`/`bodyHtml` plus the source blocks according
   to the owning schema.
4. At send time, only interpolate merge tags into stored HTML/text; do not run
   React rendering in tenant-api or jobs-cron.

`EmailDesignOverlay` has a local draft and an explicit Save. Closing with
unsaved changes must discard or confirm rather than silently changing a journey.
Preview requests should stay server-side in the sandboxed iframe flow so React
Email does not enter the browser bundle.

## Merge tags and safety

Stored syntax is plain text such as `{{firstName}}` or `{{firstName|there}}`.
The chip editor is only a UI representation. Current fallback precedence is
customer value, explicit fallback, then built-in default; unknown tags remain
verbatim unless a fallback exists.

Use the shared interpolators and HTML-escape both substituted values and
fallbacks. Never treat merge-tag values as trusted markup, URLs, SQL, or
template code. When adding a tag, update the catalog, chip editor, HTML/text
interpolators, schemas, and tests together.

## Unsubscribe boundary

The current footer is informational, not a working opt-out action. Do not add a
link that looks functional without implementing a recipient-specific signed
token and a preference endpoint in the correct data plane. Tenant preferences
must be stored regionally; platform operator preferences belong in the control
plane. Avoid putting an unsubscribe token or PII into an App/Sites proxy.

## References

- [Platform marketing email](../../platform-marketing-email.md)
- [Email docs](../../email.md)
- [Email blocks](../../../packages/common/src/email-blocks.ts)
- [Email renderer](../../../packages/marketing/src/server/email-render.server.ts)
- [Jobs/engagement sync](../project-jobs-observability/SKILL.md)
