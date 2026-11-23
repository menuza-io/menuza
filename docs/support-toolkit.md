# Support toolkit (#385, #233, #406, #272, #279, #246, #291)

Seven features that let a restaurant reach Menuza support and let support help
quickly and safely: a reference id on error pages, a Help menu, a support
request thread, named contacts, an account timeline, sign-in help and caller
verification. Every one extends something that already existed: the
observability request context and logger, the `Feedback` record, the Admin
organization and user pages, the audit log, the `Notification` engine of
`docs/manager-alerts.md` and the existing email and text senders. There is no
second ticket table, audit log, logging path or notification engine.

Support data is **control-plane** data and carries ids, states, dates and what
the sender typed. No guest name, phone, email or order is ever attached to a
request, an event or a log row. Sign-in codes and caller-verification codes are
never shown to support and never stored in plain text.

## Migrations and deploy order

One control-plane migration, `0074_support_toolkit` (widen only: new tables and
new columns with defaults). No tenant-db migration: the guest delivery log of
#246 is optional in the issue and is not built (platform Admin sees operator
data only).

Deploy: **tenant-api** (new `POST /webhooks/sms-status/:provider` and
`POST /api/phone-lookup`; `alert-texts` also answers the provider message id),
then **App** (migration, writers, Help, Support page, security card), then
**Admin**. There are no new flags. New env: Admin `BETTERSTACK_TELEMETRY_TOKEN`
and `BETTERSTACK_LOGS_SOURCE_ID` (Request lookup), App `WHATS_NEW_URL`
(optional). In Stripe, subscribe the Connect webhook to `payout.failed` and the
platform webhook already sends `invoice.payment_failed` /
`invoice.payment_succeeded`. In Resend, enable the `email.delivered`,
`email.bounced`, `email.delivery_delayed`, `email.complained` and `email.failed`
events on the existing webhook. In Twilio nothing is configured by hand: each
text carries its own `statusCallback`.

## Reference id on the error page (#385)

- One trace id per page load (`@repo/common/trace-id`: 16 random hex
  characters). The Worker (`apps/app/workers/app.ts`,
  `apps/admin/workers/app.ts`) and the Express `wideEventMiddleware` put a valid
  id on the request (the page's own when the browser sent one, else a new one)
  and on the response (`x-trace-id`).
- The server writes it into the document (`bootstrapScriptContent`), the client
  entry reads it and sends it on every same-origin `fetch` (including React
  Router data requests). Other origins (the regional tenant-api) are left alone.
- `handleError` and the 5xx log line carry `traceId`; the PostHog capture
  carries `trace_id`. The error pages show it with a Copy button
  (`@repo/ui/error-reference`, a native `<button>`: Tab, then Enter or Space).
- Admin, Request lookup (`/request-lookup`) searches the log provider by that id
  through `searchLogsByTraceId` (`@repo/observability`, Better Stack Telemetry
  query API, injectable `fetch`) and lists support requests that came with it.

## Help menu and support requests (#233, #406)

- `Feedback` gains `kind` (`feedback`, `support`, `problem`), `status` (`open`,
  `waiting_on_you`, `closed`), `subject`, `context` (JSON), `errorId`,
  `screenshotKey`, `assigneeId`, read times per side and `closedAt`. A reply is
  a `FeedbackMessage` row (the first message stays in `Feedback.message`).
- `context` is an allowlist (`SUPPORT_CONTEXT_KEYS`): organization, location,
  page path (query string and fragment are dropped), app version (decided on the
  server) and error id.
- Help is in the one signed-in layout (`HelpProvider` in `MarketingLayout`): the
  account menu, the command menu, error screens (`Get help`) and every error
  toast (`installGetHelpOnErrorToasts`). `POST /resources/support` is rate
  limited per member, accepts one screenshot (PNG, JPEG, WebP, 4 MB, platform
  bucket, never the media library) and never calls the regional node.
- Visibility: members holding `update:settings:any` (owners and admins) see
  every request of the restaurant, any other member only their own.
- Admin replies and closes from Feedback. The reply is saved first; the sender
  is then told through `POST /resources/support/notify` (ids only): a
  `support-reply` `Notification` row (also the claim) and a
  `StaffingAlertEmail`, the same pattern as `marketing.notify`. Neither carries
  the reply text.
- Unread: `isUnreadFor(side, row)` compares the last message with the side's
  read time. The badge is in Help and the Support page lists unread requests.

## Menuza contacts (#272)

`OrganizationAssignment` (organization, team member, role, location scope, from,
to). One open row per organization, role and scope (a partial unique index). A
change ends the old row and starts the new one in one `db.batch`; nothing is
deleted, so the table is the history. The role is `launch_specialist`,
`account_manager` or `support`. Assignment gives no access and changes no
permission. The Help menu reads `GET /resources/support-contact` and shows only
a first name and a photo key; new requests are routed to the support contact
first (`pickSupportContact`: support for the location, support for all, account
manager, launch specialist). Admin: a card on the organization page, "My
restaurants" and "Unassigned" filters (also narrowing the stuck-in-setup filter)
and `/assignments` for bulk reassign.

## Account timeline (#279)

Admin, organization, Timeline. `OrganizationEvent` rows are written only where
no audit row already describes the event, by the handlers that see them: the
Stripe webhook (plan changes through `updateOrganizationSubscription`, billing
failed or recovered, Connect account state, `payout.failed`),
`notifyDomainEvent` (domain events and reminders), the launch checklist (steps
completed, live) and the trial reminder, plus connected and disconnected
integrations. Each kind has one strict payload schema
(`@repo/common/organization-events`); `recordOrganizationEvent` refuses any
other key, never throws and writes a retried webhook once (`dedupeKey`).
Ordering pauses, texting lines, impersonation, sign-in help and caller
verification are **read** from the audit log; support requests and assignments
from their own tables; support notes (`SupportNote`) can be pinned. Admin only;
filters by kind and location; paged by date.

## Sign-in help (#246)

Operators receive one-time codes by email (sign-up, password reset, a new email
address) and, for the contacts they add for order alerts and for the phone line,
by text. Those senders now log the **send** in `SignInCodeDelivery`: destination
(keyed hash and masked hint), provider, provider message id, status and reason.
The table has no column for a code or a hash of one, and the senders never pass
one. Status comes from the existing Resend webhook route (delivered, bounced,
delayed, complained) and from a per-message Twilio `statusCallback` handled by
tenant-api, which forwards only the message id, the status word and the error
code. Line type and validity come from Twilio Lookup behind an adapter
(`POST /api/phone-lookup`, mocked in tests and with `MOCKS=true`). Rows are kept
7 days (hourly operator-alerts sweep, no new cron slot).

Admin, Sign-in help: look up by email or phone, see the attempts, check a
number, resend by the other channel (an email code by text to a mobile number
the operator verified themselves, or a text code by email) and end all sessions.
Every lookup and action is audited with the support member's name. Operators
have no phone number of their own, so "by text" needs a verified order-alert
contact.

## Caller verification (#291)

`SupportVerification` (user, agent, code hash, expiry, attempts, lock, verified
at). The agent presses Verify caller; the signed-in operator opens Profile,
Security, which makes a 6-digit code at that moment (only a keyed hash is
stored) and shows it once; the agent types it. 10 minutes, single use, five
wrong entries lock the user for an hour. The card and the code are refused while
an admin is impersonating the user. Admin never receives the code.

Change email, reset two-factor sign-in and start an ownership transfer need a
verification by the same agent of the affected user from the last 15 minutes,
checked first on the server (`requireSensitiveSupportAction`); a refusal is
audited. These three actions did not exist in Admin and are built here.
Operators have no phone field, so "change phone" does not exist. "Start
ownership transfer" makes the named member an admin of the organization; the
caller stays an admin until the restaurant removes them.

## Tests

`packages/common/src/{trace-id,support-requests,organization-events,support-verification}.test.ts`,
`packages/observability/src/log-search.test.ts`, `apps/app`
(`support.server.test.ts`, `support.notify.test.ts`,
`support-verification.test.ts`, `support.sign-in-help.test.tsx`,
`organization-events.server.test.ts`, `help/*.test.*`,
`error-boundary.test.tsx`, `entry.server.test.ts`), `apps/admin`
(`caller-verification`, `support-requests`, `request-lookup`, `assignments`,
`timeline`, `sign-in-help` tests) and
`apps/tenant-api/src/routes/sms-status.test.ts`.
