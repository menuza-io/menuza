# Staffing

Staffing gives an organization a workforce roster, weekly schedule, kiosk time
clock, timesheets, and labor estimates, plus a careers form for hiring. See
[staffing plan](./staffing-plan.md) for phases and cut lines and
[ADR 047](./decisions/047-staffing-data-placement.md) for data placement.

## Enable staffing for an organization

Staffing is off by default. Every route, the sidebar **Staff** group, and the
staffing token mint check both an org feature flag and a permission.

| Flag (`ConfigFlag`, org level) | Gates                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| `staffing.enabled`             | Master switch. All other staffing flags require it.         |
| `staffing.scheduling`          | Schedule grid and publish.                                  |
| `staffing.timeclock`           | Kiosk pairing, kiosk punches, and timesheets.               |
| `staffing.pay`                 | Pay rates, labor cost, and the pay claim on staffing tokens |
| `staffing.hiring`              | Reserved for structured postings (not the careers form).    |
| `staffing.onboarding`          | Reserved for onboarding checklists.                         |

Set flags per organization in **Admin → Feature flags** with value `true`. A
missing flag is off. A user-level override is ignored for staffing because the
module is organization-wide.

| Permission                             | Grants                                     |
| -------------------------------------- | ------------------------------------------ |
| `read:staff:any` / `update:staff:any`  | View / change the roster, positions, PINs  |
| `read:schedule:any` / `update:...`     | View / edit and publish shifts             |
| `read:timeclock:any` / `update:...`    | View / correct, approve, lock, pair kiosks |
| `read:hiring:any` / `update:hiring...` | Reserved for structured hiring             |
| `read:staff_pay:any`                   | Pay rates and labor cost (with the flag)   |

Only the built-in **admin** role receives these permissions. Grant them to a
custom role in **Settings → Roles** when a manager needs access. Writes require
both the read and update permission. Staff records are not organization members
and never change billed seats.

Disabling a flag stops new tokens and hides routes. It does not stop an
already-paired kiosk: revoke kiosk devices first (see the kiosk runbook below).

During support impersonation every staffing grant is read-only.

## How staffing data moves

App never reads staff names, phones, shifts, or punches. Pages load
control-plane data (locations, permissions) on the server, then the browser:

1. calls `GET /{orgSlug}/staffing/token`, which re-checks flags and permissions
   and returns a 15-minute `staffing` JWT plus the regional tenant-api URL;
2. calls `/operator/staffing/*` on that regional node directly.

The token carries `areas` (`staff`, `schedule`, `timeclock`: `read` or `write`),
`locationIds` (`null` = all; location-scoped managers are not built yet), the
organization's `locations` with time zones, and `canViewPay`. tenant-api accepts
a location only if it is in that signed list, and a read claim never writes.
Code: `apps/tenant-api/src/lib/staffing-auth.ts`,
`apps/app/app/hooks/use-staffing-client.ts`.

## Team

**Staff → Team** (`/{orgSlug}/staffing/team`) lists active and terminated team
members with search.

- **Add team member**: name, optional email (used to send schedules), phone,
  hire date, manager note, and one or more location + position pairs with one
  primary position per location.
- **Add in bulk**: paste up to 200 lines of `name, email, phone, position`
  (commas or tabs). The dialog previews row errors before anything is saved; the
  import runs in one transaction, skips emails already on the team, and creates
  missing positions.
- **Positions**: name and color. Archive instead of deleting so history keeps
  its labels.
- **Terminate** records the last day and an optional manager-only reason, and
  releases that person's shifts after the last day to open shifts. **Rehire**
  restores them. History is never deleted.
- **Settings**: week start (Monday or Sunday), weekly hours warning, and late
  clock-in grace. These drive warnings only.
- "Has an App login" compares the staff email with organization member emails in
  the browser. It is a hint, not a link; staff never need a login.

Every change writes a regional `staff_events` row with the operator's opaque
user id.

## Schedule

**Staff → Schedule** (`/{orgSlug}/staffing/schedule`) is a week grid per
location: one row per person assigned to the location plus an **Open shifts**
row. The week starts on the day set in Team → Settings.

- Click **+** in a cell to add a shift: person (or open), position, start, end,
  unpaid break, and a note staff see. **Also add on** repeats it on other days
  of the same week. An end at or before the start ends the next day.
- Shifts store the location's wall-clock times, its time zone, and UTC instants,
  so copies across a DST change keep their local times.
- Warnings, not blocks: overlapping shifts for the same person (including at
  another location) are outlined, and weekly totals above the hours setting are
  flagged. The footer shows paid hours and headcount per day.
- **Copy week** copies shifts from an earlier week (all, or one position) as
  drafts. People who were terminated or no longer work at the location become
  open shifts. **Replace** first removes this week's matching shifts.
- **Print** prints the grid without controls.

### Publish

Edits are drafts. Staff, the kiosk, and emails only see the published copy of a
shift. Deleting a published shift marks it **Removed** until the next publish;
unpublished shifts are deleted at once.

**Publish** (with the count of unpublished changes) applies every change for
that location-week in one transaction, records the publication (who, when,
changes, notified), and emails each affected person **their own** shifts for the
week, including shifts they no longer have. Emails go from the regional
tenant-api through OCI Email Delivery in the publisher's language (English or
Arabic). People without an email, or whose email failed, are listed as **Not
notified** so the manager can tell them another way.

Terminating someone turns their draft shifts after the last day into open
shifts; publish to tell the team.

Kill switch: set `STAFFING_EMAIL_ENABLED=false` on a tenant-api node to publish
without sending email (everyone is listed as not notified).

## Time clock

Staff clock in and out on a shared tablet at the location (a **time clock**)
with a personal PIN. They never need an App login.

### Set PINs

On **Team**, use **Set PIN** (or **Reset PIN**) on an active person. Generate a
PIN or choose one (4 to 6 digits). The PIN is shown once; tenant-api stores only
a keyed HMAC, so nobody can look it up later. PINs are unique within the
organization, and PINs that repeat one digit or count up or down are rejected.
Terminating someone clears their PIN. Setting PINs needs `update:staff:any`.

### Pair a tablet

1. **Staff → Time clocks** (`/{orgSlug}/staffing/kiosks`) → **Add a time
   clock**. Choose the location and name the device.
2. On the tablet, scan the QR code, or open `https://<app>/kiosk/<orgSlug>` and
   type the pairing code. The code works once and expires after 15 minutes. It
   travels in the URL fragment, so App never receives it.
3. The tablet stores a device token in `localStorage` and keeps working if the
   organization slug changes. Bookmark it or add it to the home screen.

The kiosk page is served by App, but App only renders the shell and public
organization metadata. PINs, names, punches, and shifts go from the tablet to
the organization's regional tenant-api (`/kiosk/*`).

### Clock in and out

The tablet shows the location's local time and a PIN pad. After a PIN, the
person sees their first name and last initial, whether they are clocked in, and
their next three published shifts at this location. **Clock in** picks the
position from a nearby published shift, or the person chooses one when they have
several. **Clock out** closes their open time card.

- A PIN works only for active people assigned to the tablet's location.
- Each tap carries a request id, so a retry after a network error never punches
  twice. Two tablets cannot clock the same person in at once.
- Five wrong PINs lock the tablet for 5 minutes, doubling up to an hour. A good
  PIN resets the count. Managers see **Locked after wrong PINs** on the Time
  clocks page.
- The person screen returns to the PIN pad after 40 seconds; the one-time punch
  token behind it expires after 60.
- Every clock-in and clock-out writes an append-only `time_entry_events` row.

### Kiosk runbook

- **Lost or stolen tablet:** **Time clocks → Remove**. The device token stops
  working on the next request and the tablet shows the pairing screen.
- **Pause every time clock on a node:** set `STAFFING_KIOSK_ENABLED=false` on
  that tenant-api node and restart. `/kiosk/*` returns `503 kiosk_disabled`, new
  pairing codes are refused, and tablets show that the clock is paused.
- **Turning off `staffing.timeclock`** hides the pages and stops new tokens and
  pairing, but an already-paired tablet keeps punching until you remove it or
  use the kill switch. Remove devices first.
- Pairing and removal also write App audit events
  (`staff_kiosk_pairing_started`, `staff_kiosk_revoked`) with opaque ids only.

## Timesheets

**Staff → Timesheets** (`/{orgSlug}/staffing/timesheets`) lists time cards for
one location by day or week, on the location's clock. Viewing needs
`read:timeclock:any`; changes need `update:timeclock:any`.

- **Flags.** A card is flagged **Missing clock-out** after 12 hours open, **Not
  scheduled** when no published shift matches, and **Late** when the clock-in is
  after the shift start plus the schedule's late grace minutes. **Needs
  attention** filters to flagged cards.
- **Corrections.** **Add time card** records a shift someone forgot to punch.
  **Edit** changes the times, position, break, or note; it needs a reason. A
  clock-out at or before the clock-in means the next day. Times can't be in the
  future, a break must be shorter than the time worked, and one person's cards
  can't overlap. **Delete card** also needs a reason and keeps the row hidden
  rather than erased.
- **History.** Every punch, edit, deletion, approval, and reopen is an
  append-only `time_entry_events` row with before and after values, so the
  original kiosk punch survives any correction. **History** shows them with the
  manager or time clock that made each change.
- **Approve and lock.** **Approve selected** or **Approve all** approves closed
  cards; open cards are skipped. Approved cards can't be edited or deleted until
  someone **Reopens** them with a reason, which clears the approval.
- **Weekly totals** add up each person's paid hours across every location they
  worked that week. With a weekly hours threshold set, hours over it are shown
  separately. These are hours only, not an overtime pay calculation.
- **Export CSV** builds the file in the browser from the regional response, so
  payroll data never passes through App. Times are the location's wall clock,
  and cells that start with a formula character are neutralized for
  spreadsheets.

## Careers form

### Publish an application form

1. Open **Website → Forms → Create form** at `/{orgSlug}/website/forms/new`.
   Choose **Job application**, name the form, and select **Create and
   customize**.
2. Review the six fields: full name, email, phone, role, availability, and
   experience. Email is required by default so Mailbox can offer replies; phone
   and experience are optional. Adjust labels and requirements for the opening.
   Do not add tax IDs, bank details, health records, or resume uploads.
3. Add your organization-specific privacy notice to the form description or the
   surrounding page. Explain purpose, retention, and how applicants can request
   deletion. This preset does not record legal consent acceptance.
4. Review the button and confirmation copy. The form starts as **Draft**;
   **Publish** makes it available for page selection.
5. In **Website → Pages**, create a page with a slug such as `careers`. Add job
   details using existing content blocks, then add a **Form** block. Select the
   published application form under **Connected form**.
6. Save/publish the page and publish the website if necessary. Forms and pages
   have separate publish steps. Add the page to site navigation or share its
   public, locale-prefixed URL.
7. If your site supports Arabic, use the form/page locale controls to translate
   the content. Template labels are editable website content, not automatic
   translations of applicant answers.
8. Submit a synthetic test application from the public page. The builder's
   **Test mode** validates the preview but deliberately saves no responses.
   Check that the real submission request targets the organization's regional
   tenant-api, not an App or Sites API proxy.

Configure `PUBLIC_TURNSTILE_SITE_KEY` on Sites and matching
`TURNSTILE_SECRET_KEY` / `TURNSTILE_HOSTNAMES` on tenant-api before public
launch. Empty configuration disables the widget/verification for development.
The existing honeypot, validation, and request limits still apply.

### Share and print a QR sign

Copy the **published page URL**, including the site's locale prefix. Do not link
to the App builder URL or the regional API endpoint.

The repository already includes the `qrcode` CLI. To generate a local PNG
without sending the URL to an external QR provider:

```sh
npx --no-install qrcode -o careers-qr.png 'https://your-site.example/en/careers'
```

Place the PNG and the human-readable page URL on your hiring sign and print it.
Scan the QR on a phone before posting. The QR contains a public page link, not
credentials or applicant data.

### Review applications

- Open **Mailbox → Forms**, search for the application form name, and review the
  response. The existing per-operator read state and pagination apply.
- **Open in email app** prepares a reply; it does not send email. The operator
  reviews and sends it in their configured email client. Do not describe this as
  an automated candidate-notification service.
- The form builder's **Responses** view also loads responses directly from
  tenant-api in the browser, after obtaining mailbox-scoped credentials. It
  displays at most 500 recent responses. Use Mailbox to page through older
  entries. Changing a form does not migrate previous answers.
- Access follows existing website permissions, not a new hiring permission.
  Anyone granted website-read access can read applications through Mailbox. Use
  this only where those recipients are appropriate; hiring-specific access
  restrictions arrive with the structured pipeline.

Published form definitions can be cached for SSR. Applicant names, email, phone,
and answers stay in the regional tenant database and travel only to the
authorized browser.

### Retention and deletion

**Automatic deletion is not enabled by the checked-in cron configuration.** The
existing `form-submission-retention` handler can delete submissions older than
365 days, but the `0 5 * * *` trigger is absent from
`apps/jobs-cron/wrangler.jsonc`. Verify actual deployment configuration and the
legally appropriate retention period before collecting real applications. Do not
enable that destructive job silently as part of adopting the preset.

An authorized operator can delete a response through the existing regional
submission-deletion flow. Deleting the form cascades to **all** responses.
Changing the organization's data region destroys its old tenant database,
including applications, with no cross-region migration.

The preset is available without a new staffing flag, secret, migration, or
billing seat. It does not hire a person, invite them to App, or create a
workforce record.
