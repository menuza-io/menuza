# Platform marketing email

Admin **platform marketing** (broadcasts to tenant operators) and App
**transactional email** (password reset, invites, notifications) share one
delivery switch. App **tenant marketing** (customer PII) always sends from
regional tenant-api via OCI.

| Surface                           | Audience        | Provider switch                                |
| --------------------------------- | --------------- | ---------------------------------------------- |
| App transactional + notifications | Operators       | `EMAIL_PROVIDER` on **App**                    |
| Admin `/marketing` campaigns      | Operators       | `EMAIL_PROVIDER` on **Admin** (same OCI creds) |
| App `/marketing`                  | Customers (PII) | Always OCI on **tenant-api** (unchanged)       |

## Switching providers

Set on **App** (and **Admin** if you use platform marketing):

```bash
EMAIL_PROVIDER=oci   # default: resend

# OCI Email Delivery (same vars as tenant-api)
OCI_TENANCY_OCID=
OCI_USER_OCID=
OCI_FINGERPRINT=
OCI_PRIVATE_KEY=
OCI_REGION=us-ashburn-1
OCI_EMAIL_COMPARTMENT_ID=
OCI_EMAIL_SENDER_EMAIL=
OCI_EMAIL_SENDER_NAME=Epic Startup
OCI_EMAIL_LOG_OCID=          # required for open/click metrics on OCI
```

With `EMAIL_PROVIDER=oci`, `sendEmail()` in `@repo/email` routes to OCI
automatically. No code changes. Resend tags on platform campaigns are converted
to OCI correlation headers.

**Local dev / E2E:** with `MOCKS=true`, OCI sends are intercepted by MSW (same
fixture files as Resend via `readEmail()` in `@repo/test-utils/mocks`).

With `EMAIL_PROVIDER=resend` (default), behavior is unchanged: Resend API +
`RESEND_API_KEY`. Platform open/click tracking uses Resend webhooks on App
(`RESEND_WEBHOOK_SECRET`).

## Correlation IDs (`@repo/config/marketing-email`)

Tag and header names are derived from `brand.slug` in `packages/config/brand.ts`
so forks white-label in one place.

With the default slug `epic-startup`:

| Purpose            | Resend tag                 | OCI / SMTP header            |
| ------------------ | -------------------------- | ---------------------------- |
| Scope (`platform`) | `epic_startup_scope`       | —                            |
| Message id         | `epic_startup_message_id`  | `X-Epic-Startup-Message-Id`  |
| Campaign id        | `epic_startup_campaign_id` | `X-Epic-Startup-Campaign-Id` |
| Org id             | —                          | `X-Epic-Startup-Org-Id`      |
| Journey id         | —                          | `X-Epic-Startup-Journey-Id`  |
| Customer id        | —                          | `X-Epic-Startup-Customer-Id` |

Helpers live in `packages/config/marketing-email.ts`:

- `getMarketingEmailTags()` / `getMarketingEmailHeaders()`
- `buildPlatformMarketingResendTags()`
- `buildTenantMarketingEmailHeaders()`
- `getMarketingEmailTagValue()` / `getMarketingEmailHeaderValue()` (current +
  legacy)

**Legacy names** (`epic_scope`, `epic_message_id`, `X-Epic-Org-Id`, etc.) are
still accepted on webhook and OCI log ingest for emails sent before a slug
rename.

## Resend webhooks (when `EMAIL_PROVIDER=resend`)

Platform broadcasts tag each outbound message so webhooks can update open/click
state without mixing in transactional mail.

**Webhook endpoint:** `{BASE_URL}/api/resend/webhook` (App, not Admin)

**Resend Dashboard:** subscribe to `email.opened` and `email.clicked` → copy
signing secret to `RESEND_WEBHOOK_SECRET` on App.

## OCI engagement (when `EMAIL_PROVIDER=oci`)

Platform marketing open/click sync runs when Admin loads marketing metrics or
campaign detail (`platform-oci-engagement-sync.server.ts`). It queries OCI
Logging (`OCI_EMAIL_LOG_OCID`) and updates `PlatformMarketingMessage` by message
id header — same tables and Admin UI as Resend webhooks.

Tenant customer email engagement is unchanged: regional tenant-api +
`POST /api/marketing/sync-engagement`.

## OCI engagement (tenant marketing)

Tenant customer email is sent from **tenant-api** only (regional boundary).
Headers are set in `apps/tenant-api/src/lib/tenant-email.ts` via
`buildTenantMarketingEmailHeaders()` from `@repo/config/marketing-email`.

Engagement sync runs on marketing metrics load and hourly via jobs-cron →
`POST /api/marketing/sync-engagement` on each regional tenant-api node.

## Why split providers by default

- **Tenant PII** must send from regional OCI nodes (KSA/US residency).
- **Platform operators** live in the US control-plane DB; Resend is the default
  for low-volume operator mail.
- **`EMAIL_PROVIDER=oci`** lets you consolidate App/Admin onto OCI when ready
  without touching tenant-api.

## Block-based HTML emails (broadcasts + automations)

Marketing email bodies can be designed from blocks — heading, body text,
paragraph text, image, and button — in the App (`/marketing`) and Admin
(`/marketing`) UIs, replacing the plain-text-only composer.

- **Blocks** — `packages/common/src/email-blocks.ts` defines the block types,
  their Zod schemas/defaults, and starter templates. The block array is the
  source of truth: `marketing_campaigns.content_blocks`,
  `PlatformMarketingCampaign.contentBlocks`, and automation node `data.blocks`.
  Buttons support a **Width** of `auto` (hugs the label) or `full` (spans the
  email content width, label centred). Alignment applies to `auto` only.
- **Branding** — `packages/common/src/email-theme.ts` turns an org's website
  theme (`Organization.siteTheme`), logo, and name into email-safe literals.
  `oklch()` tokens are converted to hex because email clients do not support CSS
  variables or `oklch`. Tenant emails use the org's branding; platform emails
  use the platform brand.
- **Renderer** — `@repo/email/marketing` holds the isomorphic React Email
  components (brand header, blocks, footer with unsubscribe text + copyright).
  `renderMarketingEmail()` in `@repo/marketing/server/email-render` returns
  `{ html, text }`.
- **Design-time rendering** — the App/Admin route action renders the blocks when
  the broadcast or automation is saved and stores the HTML (`content_html` /
  node `bodyHtml`). The regional send paths (tenant-api, jobs-cron, platform
  dispatch) only interpolate merge tags into that stored HTML, so no React runs
  in the send path. Substituted values are HTML-escaped via
  `interpolateMergeTagsHtml` so customer PII cannot inject markup.
- **Editor preview** — the editor debounces a POST of the blocks to the current
  route's action (`intent: 'email_preview'`) and renders the returned HTML in a
  sandboxed iframe. This keeps `react-email`/`react-dom/server` out of the
  browser bundle while previewing exactly what will be delivered.
- **Explicit save (automations)** — in the automation email node the designer
  opens **full screen** and edits a local draft (`EmailDesignOverlay`). Nothing
  reaches the journey until **Save**, which persists the journey via the
  canvas's normal save. Closing with pending changes asks for confirmation. The
  broadcast composer keeps its inline designer and always saves with the
  campaign.
- **AI assistant** — the automation editor mounts the app's `GlobalAIToggle`, so
  the assistant is reachable (⌘/) exactly as in the page and form editors. It
  currently has navigation-only capabilities there; AI-driven journey/email
  editing is not wired up yet (see below).
- **Merge tags** — `{{name}}`, `{{firstName}}`, `{{lastName}}`, `{{email}}`,
  `{{phone}}`, `{{organizationName}}`, supported in block text, button labels,
  and subjects.

### Merge tag chips and fallbacks

In the email designer and the automation email-node inspector, merge tags render
as inline chips rather than raw `{{token}}` text. Clicking a chip opens a **Swap
variable** popover that lists the available tags (with sample values), lets you
pick a different tag, and sets a **fallback** used when the recipient has no
value for that field.

- Catalog + token parsing: `packages/common/src/merge-tags.ts`
- Chip editor: `MergeTagField` in `@repo/marketing`
  (`packages/marketing/src/components/email/merge-tag-field.tsx`)
- Stored syntax stays plain text: `{{firstName}}`, or `{{firstName|there}}` with
  a fallback. The chip is only a rendering of that text, so nothing downstream
  needs to understand chips.

Fallbacks resolve in both interpolators (`@repo/marketing` and
`packages/tenant-db/src/types/journey.ts`) with the same precedence: **customer
value → explicit fallback → built-in default**. For an unknown tag, the fallback
is used when present; otherwise the token is left verbatim. In HTML output the
substituted value _and_ the fallback are escaped.

### Unsubscribe follow-up

The current email footer is informational only; it must not be treated as a
functional opt-out action. Before enabling that action, implement a
recipient-specific, signed unsubscribe URL and a regional preference endpoint
that records the opt-out in the customer's tenant database. The send path must
insert the URL after the message is associated with its recipient, and the
endpoint must verify the token without routing tenant customer PII through the
App or Sites control plane. Platform-operator marketing needs an equivalent
US-control-plane preference flow.

Not yet implemented (follow-ups): a working unsubscribe flow, per-locale email
content, and AI tools that read or edit the journey/email design. The AI
assistant is reachable in the automation editor but its server-side tools
(`packages/ai/src/route-handlers/chat.ts`) are still website-editor only.
