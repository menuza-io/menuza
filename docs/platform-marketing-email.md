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
  and subjects. `{{couponCode}}` shows the message's coupon (a shared code or a
  single-use code per recipient) in tenant broadcasts and automation steps; see
  "Coupons in marketing messages" in [discounts-plan.md](./discounts-plan.md).

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

A fallback is unescaped once and escaped again, so a double-encoded fallback
such as `&amp;lt;script&amp;gt;` stays text. Escaping does not make a URL safe,
so in a URL attribute (`href`, `src`, and the like) the attribute is emptied
unless the interpolated value is a relative URL or uses `http`, `https`,
`mailto` or `tel` (`replaceMergeTokensInHtml` in
`packages/common/src/merge-tags.ts`). The check decodes the attribute once and
drops tabs, newlines and control characters first, as a browser does, so
`JavaScript:` or `java&#x09;script:` is refused too.

### Unsubscribe follow-up

The current email footer is informational only; it must not be treated as a
functional opt-out action. Before enabling that action, implement a
recipient-specific, signed unsubscribe URL and a regional preference endpoint
that records the opt-out in the customer's tenant database. The send path must
insert the URL after the message is associated with its recipient, and the
endpoint must verify the token without routing tenant customer PII through the
App or Sites control plane. Platform-operator marketing needs an equivalent
US-control-plane preference flow.

Not yet implemented (follow-ups): per-locale email content, and AI tools that
read or edit the journey/email design. The AI assistant is reachable in the
automation editor but its server-side tools
(`packages/ai/src/route-handlers/chat.ts`) are still website-editor only.

## Broadcast consent

Customer broadcasts (App > Marketing > Campaigns) only go to customers with an
active row in the regional `customer_subscriptions` table for the campaign's
channel (`email` or `sms`) and topic (`marketing`). A customer row, a verified
phone or an order is not consent. Texts also need a verified phone. Emails need
an address its owner confirmed (double opt-in): a customer's
`PUT /subscriptions/:topic/:channel` for `email` stays pending and sends a
signed confirmation link (the answer says `confirmationSent`; a failed send is
logged without the address and the next request resends at once, otherwise a
repeat request resends at most every 3 minutes per address, counted from the
last link actually sent); the subscription counts only while
`confirmed_email_hash` matches the customer's current address, so a changed
address has to be confirmed again. A customer may claim the sources `profile`,
`signup` or `checkout`; `operator`, `import` and `form` are for trusted server
code (`operator` and `import` count as confirmed for the address on file).
Opting out keeps the row with `unsubscribed_at` set.

Every broadcast email carries a signed unsubscribe link (HMAC with
`AUTH_HMAC_SECRET`, no login) in the body and as `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. The tenant-api
endpoints are `GET|POST /subscriptions/unsubscribe?token=` and
`GET|POST /subscriptions/confirm?token=`: GET only shows a button, POST acts and
is idempotent, so a mail scanner opening links changes nothing. Links point at
`TENANT_API_URL`, which is required in production (the Node entry refuses to
start without it; the Cloudflare Worker keeps serving instead, so health, login
and provisioning are unaffected). A send is skipped and logged when it is
missing, and a broadcast with no origin is marked `Failed` before any
per-recipient work. "Production" is anything but an explicit
`NODE_ENV=development|test`, so an unset `NODE_ENV` counts as production. The
request origin is never used, except for local development hosts when the
variable is unset in development or test.

**Rollout order:** set `TENANT_API_URL` on the node (Worker `vars` of that
environment or the dashboard; `apps/tenant-api/wrangler.jsonc` deliberately does
not declare an empty value, which would overwrite it on deploy), then deploy.
Without it consent emails are skipped, not the whole node.

Journey (automation) email steps carry the same link, body footer and headers,
test sends from the editor included. The topic is `reservations` for a
reservation-triggered journey and `marketing` for every other one, so after
unsubscribing the next email step of any such journey is skipped as
`no_consent`. Without a trusted origin (no `TENANT_API_URL` in production) the
step is skipped as `no_unsubscribe_origin`, before a coupon is minted, and
nothing is sent; the run's timeline names the reason, and the node's `/health`
answers `"emailLinks":"not_configured"` so deploy checks catch it. The editor's
preview shows an "Unsubscribe" placeholder where the signed link goes. Journey
text steps do not carry an opt-out yet.

To backfill consent a business already holds (for example an existing mailing
list), insert rows with `source = 'import'` through `setCustomerSubscription()`
in `apps/tenant-api/src/services/marketing-audience.ts`. Only import people who
agreed to receive marketing.

Broadcasts are sent by the regional tick, which only claims them: each claimed
campaign sends in the background (`waitUntil` where the runtime offers one,
otherwise an un-awaited promise), so a large campaign does not hold the staff
tick or other organizations; a send that dies with its isolate is resumed once
its lease goes stale. On the Durable Object runtime the organization's alarm
wakes at the next scheduled `scheduledAt`, and while a campaign is `Processing`
it wakes when its lease could go stale (to resume a throttled or interrupted
send). Creating a campaign and the hourly tick arm it, so a scheduled broadcast
does not wait for the hourly cron.

Only `Scheduled` campaigns are sent on their `scheduledAt`; a `Draft` never is.
Older releases saved scheduled broadcasts as `Draft` and never sent them: tenant
migration `0019_legacy_scheduled_drafts` moves those still ahead to `Scheduled`,
so they **really send** email and SMS at their time. Past ones stay `Draft`
(never sent) for the operator to reschedule. "Ahead" is judged when each
organization's database migrates. An unexpected error during a send (a database
or storage failure) leaves the campaign `Processing`, and the tick resumes it
once its lease goes stale. After `BROADCAST_MAX_FAILURES` (6) failed attempts in
a row, about an hour, the campaign is marked `Failed`; a batch that goes out
resets the count (`dispatch_failures`, tenant migration 0020).

## Journey consent

Journeys (App > Marketing > Automations) are marketing, so every email and SMS
step uses the broadcast consent rules above (`hasMarketingConsent` in
`apps/tenant-api/src/services/marketing-audience.ts`): an active `marketing`
subscription for the step's channel, a verified phone for texts, and a confirmed
address for email. There is no transactional exemption. A customer without
consent skips that step and the journey goes on. The step execution is recorded
as `skipped` with `executionDetails.skipReason = 'no_consent'` (and the channel)
and a readable `errorMessage`, which the run timeline in the App shows; the
system route `POST /api/journeys/execute-step` answers `reason: 'no_consent'`.

What this means when you design a journey:

- A text right after `phone_verified` (the editor's default trigger) is skipped
  for nearly everyone: the customer cannot hold an SMS subscription before the
  request that verified the phone, which is the one that fires the trigger. Put
  a delay first (a customer who subscribes to texts meanwhile then gets it), or
  start the journey from a `custom_event` your code sends after the customer
  subscribes.
- An email after `profile_completed` is skipped until the customer follows the
  confirmation link (double opt-in), unless consent was recorded with the
  `operator` or `import` source.
- Messages a customer must get whatever their marketing choice (receipts,
  sign-in codes) are not journeys; send them from the code path that needs them.

## Migration archives

Two migrations remove duplicate rows before they add the unique indexes that
stop two dispatchers sending twice. Each copies the rows it removes to an
archive table first, so the deletion can be undone:

- Control plane, `packages/database/drizzle/0027_concurrency_guards.sql`:
  duplicate `PlatformMarketingMessage` rows per campaign and user. The kept row
  is the most engaged one (Clicked, Opened, Sent, Processing, then Failed; the
  oldest on a tie). Removed rows go to
  `__archived_PlatformMarketingMessage_0027`.
- Every organization's tenant database,
  `packages/tenant-db/drizzle/0018_concurrency_guards.sql`:
  - Journey runs of a once-per-customer trigger (`phone_verified`,
    `profile_completed`), duplicated per journey and customer. The kept run is
    completed, then running, then failed, then cancelled (the oldest on a tie).
    Removed runs go to `__archived_journey_runs_0018`, and their step executions
    to `__archived_journey_step_executions_0018`. A message sent by a removed
    step keeps its row with the step link set to `NULL`; a copy with the old
    link is in `__archived_marketing_messages_0018`
    (`archive_reason = 'journey_step_unlinked'`).
  - Broadcast messages duplicated per campaign and customer. The kept row is the
    most engaged one (Clicked, Opened, Delivered or Sent, Unknown or Processing,
    then Failed; the oldest on a tie). Removed rows go to
    `__archived_marketing_messages_0018`
    (`archive_reason = 'duplicate_broadcast'`).

The archive tables are created even when nothing was removed (then empty). They
hold customer ids and journey context, so person erasure deletes a customer's
archived rows too (`eraseArchivedRows` in
`apps/tenant-api/src/services/person-erasure-service.ts`), and they live in the
organization's own region like the rows they came from. To restore a row, insert
it back from the archive (drop `archive_reason`) after removing the row that was
kept, since the unique index allows one. Drop the archive tables in a later
migration once the rollout has been checked.
