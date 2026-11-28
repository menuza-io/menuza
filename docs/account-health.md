# Account health and setup safety nets

Six small features that keep an account from failing quietly (#242, #275, #237,
#379, #347, #271). Each one extends something that already existed; none adds a
second hours engine, banner system, billing action, email sender, scheduler,
notification preference system or audit log.

## Special hours that repeat every year (#242)

- `repeatsYearly?: boolean` on a special-hours entry (stored JSON, no
  migration). `@repo/opening-hours` `special-hours.ts` is the one rule:
  `findSpecialHourForDate` (an entry for exactly that date wins, a one-off
  before a repeating one; else a repeating entry on the same month and day that
  started on or before it), `nextSpecialHourDate` and `expandSpecialHours`
  (dated entries over a range, for channels that need a list).
- Read by ordering and the reservations engine (`ruleForDate`), Sites, the phone
  agent (`describeBusiness`), Google listing sync, delivery-app holiday hours
  (`projectSpecialHoursForPlatform`) and inventory (`parseClosedSpecialDates`).
  Copying hours between locations copies the flag.
- 29 February repeats only in leap years. Holidays that move (Eid, Easter,
  Thanksgiving) stay one-off, and the form says so.
- The list hides past one-offs ("Show past" is off), marks repeating entries and
  shows the date they apply on next.

## Hours mistake warnings (#275)

- `lintHours` in `@repo/common/hours-lint` returns coded warnings with one-click
  fixes (`applyHoursFix`): a day open under 3 or over 20 hours, an AM and PM
  mix-up ("Did you mean 11:00 PM?"), a store row that wraps midnight on the
  online hours, online hours outside store hours or too short to order in, a
  location closed every day, special hours that overlap, repeat a date, are open
  without hours or closed with hours. Overnight rows split at midnight and
  24-hour days never warn. Special hours read "today" in the location's zone.
- The editor shows them (never blocks a save). The launch checklist shows a
  count on the hours step and Needs attention has an `hours_look_wrong` item,
  both from the saved hours through `savedHoursWarnings`.
- "Dismiss until the hours change" stores `hoursWarningsDismissedFor` (a
  fingerprint of the saved hours) on the location; any edit brings them back.

## Past-due banner and Retry payment (#237)

- `Organization.pastDueSince` is set by the Stripe webhook on the first
  non-paying `past_due` event and cleared when it is paid or ends (Admin shows
  days overdue). The org layout loader exposes `billingPastDue` to members with
  `update:settings:any` only; the banner cannot be dismissed.
- Billing page: the unpaid invoice, each failed attempt (card brand and last
  four, date) and the next try, read live from Stripe
  (`PaymentProvider.getBillingIssue`). **Retry payment** pays only the open
  invoice (`PaymentProvider.payInvoice`), once a minute per organization,
  idempotent at Stripe (key: invoice and attempt count), and reads the status
  back at once so the banner goes immediately.

## Cancel or downgrade requests (#379)

- Settings, Billing, "Request a change": cancel locations, cancel everything or
  move to the smaller plan, with a reason and sub-reason, a retention offer when
  one is configured, links to the existing exports and the billing cutoff date
  shown above the confirmation. A request is only a row
  (`SubscriptionChangeRequest`): nothing is cancelled, charged or deleted, and
  it takes effect at period end. The owner can withdraw it. One open request at
  a time.
- The retention offer is the plain-text feature flag `billing.retention_offer`
  (set at system or organization level in Admin, Feature flags, as a string).
- Admin: Cancel requests lists every request with its reason; the organization
  page shows its own; "Mark handled" records that support acted. The Timeline
  gets a `subscription_change_requested` event (kind and reason only).

## SSO failure alerts (#347)

- `handleSSOError` counts each failure that points at the setup
  (`shouldNotifyAdmin`) for the organization in the request path
  (`SsoFailureEvent`). Five in ten minutes email and notify the organization's
  admins (members who can run settings) once per hour per outage
  (`SsoFailureNotice`, one compare-and-set claim).
- The words come from the error kind alone: no message, user, token or assertion
  is ever stored or sent. Admins mute it in Notification settings (workflow
  `sso-failure-workflow`; email and app switches). SSO itself is configured in
  Admin, so the notice links to organization Settings.

## Setup reminders (#271)

- A daily job (`/resources/jobs/setup-reminders`, on the existing 03:00 cron
  slot) emails the owners of an organization that is not live about the single
  next unfinished required launch step, 1, 3 and 7 days after the last progress,
  then stops. Any progress (a step done or undone) resets the sequence
  (`SetupReminderState`). A reminder more than three days late is skipped, not
  sent. Behind the organization flag **`launch.reminders`** (default off, only a
  literal `true`).
- Never sent to test organizations (organization flag `account.test`), cancelled
  or inactive accounts, or an organization with a location that was ever live.
  Sent in the organization's default language (English or Arabic, right to
  left). Owners turn it off from the email (signed one-click link) or in
  Notification settings.
- Admin, organization page: **Preview reminder**, **Send reminder now** (one
  manual reminder per day per organization, audit logged, "Nobody to notify"
  when no owner can receive it) and the history (`SetupReminder`: step, kind,
  progress, count; no address).

## Operations

- Migrations: control plane `0087_account_health` (none for tenant-db).
  `POS_CONTRACT_VERSION` stays 13 and `INVENTORY_POS_CONTRACT_VERSION` 2.
- Flags: `launch.reminders` (default off), `account.test` (marks a test
  account), `billing.retention_offer` (plain text). No new environment
  variables.
- Deploy order: tenant-api (it reads `repeatsYearly` in the order context), then
  App with the control-plane migration, then Sites, Admin and jobs-cron.
- Tests never call a live host: Stripe is a stand-in provider, email is an
  injected `sendEmail`, clocks are injected.
