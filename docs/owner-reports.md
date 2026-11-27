# Owner reporting and exports

Customer list sorts and export (#231), export progress and cancel (#386),
scheduled report emails (#121), the monthly results summary (#221) and the
accounting journal export (#189). All of it extends the report engine
(`packages/reports`), the analytics route
(`apps/tenant-api/src/routes/analytics.ts`) and the people, orders, payouts and
email code that already existed.

## Where the data lives

| Thing                                    | Plane                             | Notes                                                                   |
| ---------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Customer list rows, spend, points        | Region (tenant-db)                | Browser calls `GET /operator/people[/export]` directly.                 |
| Report schedules, recipients             | Control plane (`ReportSchedule*`) | Member ids and emails only.                                             |
| Report rows and figures                  | Region                            | Run by the analytics engine; only status or totals leave.               |
| Monthly figures                          | Region, totals                    | `POST /internal/reports/figures`, internal token.                       |
| Accounting days (per location, currency) | Region, totals                    | `GET /analytics/accounting-daily`, `POST /internal/reports/accounting`. |
| Payouts and processing fees              | Payment provider, via App cache   | The same data as the Payments page (#168).                              |
| Account mapping, export history          | Control plane (`Accounting*`)     | Names, codes and aggregate money per line. No guest data.               |

## Customer list (#231) and exports (#386)

- Sorts `total_spend` and `points_used`; filters `joinedFrom/To`,
  `lastOrderFrom/To` (`YYYY-MM-DD`, UTC days). Spend is the reports' "Total
  spent": orders that count toward sales (`countedOrderCondition`), matched by
  customer or by phone key, per currency. The sort uses the organization's main
  currency; the export has one spend column per currency. Points are the loyalty
  balance and points redeemed net of restored.
- `GET /operator/people/export` reads the SAME query as the list
  (`queryPeople`), in chunks of 2,000 rows, at most 50,000, and needs the
  customers facet. The first chunk writes one `form_export_audit` row
  (`kind: people`, a count, no value).
- `GET /operator/orders/export?chunk=1` pages the order history export the same
  way (`kind: orders`). The one-shot CSV still works.
- One browser-side runner, `runChunkedCsvExport` in
  `packages/reports/src/export.ts`: progress, estimated time left, cancel. The
  file is built only after the last page, so a cancelled export leaves no
  partial file. `useChunkedExport` and `ExportProgressPanel` are the App's one
  hook and one panel.

## Scheduled report emails (#121)

- Flag `reports.schedules` (default off). Hourly job
  `resources+/jobs.report-schedules.ts` (the existing hourly jobs-cron slot; no
  sixth cron).
- Rules: 10 schedules per organization, 20 recipients per schedule, members
  only, no personal field (`PERSONAL_REPORT_FIELDS`, checked in the App and the
  region), recipients re-checked at send time (`skipped_no_access`,
  `skipped_not_member`), send hour in the schedule's reporting zone, "yesterday"
  per location zone, two retries (30 minutes, 2 hours), three failed days pause
  the schedule and tell its creator.
- The region runs the definition in process through the SAME `/analytics/query`
  handler with a short-lived token that carries exactly the recipient's grants
  (`runReportInRegion`), renders the email and sends it with `sendTenantEmail`.
  Kill switch `REPORT_EMAIL_ENABLED=false` on a node drops sends (not held).
- **Decision, CSV:** the email sender (OCI Email Delivery `SubmitEmail`) has no
  attachment field. The CSV is a signed link to the region
  (`GET /reports/csv/:orgId`, HMAC with `AUTH_HMAC_SECRET`, 7 days, rebuilt at
  download time, aggregate only).
- One-click unsubscribe: signed token, `resources+/report-unsubscribe.ts`, GET
  and the mail client's POST, no login. Settings, Notifications lists each
  report email.
- The daily summary is a built-in schedule (`builtIn: daily_summary`): net
  sales, orders, average sale, tips, refunds, labor cost and percent, covers,
  new reviews, each against the same weekday last week (`dailyAsOf` moves the
  engine's clock back 7 days).

## Monthly results (#221)

- No flag. `reports+/monthly` runs `summary-figures` definitions browser-direct
  (`fetchMonthlyFigures`); a month is read by moving the engine's `now` (`asOf`
  on `/analytics/query`, never later than now), so each location's own calendar
  month in its own zone comes for free. Money is grouped by currency.
- A line without a grant is hidden; a module that is off is one "Not switched on
  yet" line, at most two. The first, partial month says so.
- "Kept by ordering direct" = direct online sales (channels `online_menu`,
  `drop`, `qr_poster`) times `Organization.deliveryCommissionBp` (default 2500).
  Always an estimate with the rate shown. Rate: Settings, General. Billing shows
  last month's figure.
- Email on the 2nd, from 08:00 in the reporting zone, to owners and admins
  (roles that hold `update:settings:any`) who have not switched it off
  (`NotificationPreference`, workflow `reports.monthly_results`). One per person
  per month (`MonthlyResultsDelivery`). Totals only.
- Simplest equivalents used: marketing lines are attributed orders and sales (no
  "messages sent" count exists as a report subject); loyalty is the value of
  rewards used (no members-who-ordered count exists as a report subject). The
  monthly email is in Arabic for KSA organizations and English otherwise (no
  per-person language is stored).

## Accounting journal (#189)

- Flag `reports.accounting` (default off). Token subject `accounting_daily`,
  granted only with the flag, analytics and order access.
- One journal per location, business day and currency (`buildJournalDay`, pure):
  sales by category (shown at gross), service fees, discounts, loyalty, cash
  discounts, refunds, tax by rate (effective rate snapped to a quarter point),
  tips, gift cards sold, payments by tender, then the provider's payout and
  processing fees against one clearing credit. It balances; when it does not, a
  `Difference (needs review)` line shows the gap.
- A day is final once its date has passed in the location's zone. Re-exporting a
  closed day never rewrites it: a change since the last export (a late refund)
  is an adjusting entry (`...-ADJ1`), nothing changed gives nothing
  (`AccountingExport`, cumulative lines).
- Layouts: QuickBooks, Xero, generic CSV (`journalToCsv`, snapshot tests).
- The payout line is the payout report's: `getOrganizationPayoutsSnapshot`,
  summed per arrival day. It needs `read:payments:any`; without it the lines are
  left out and said so.
- Weekly email to the bookkeeper (typed address, outside the member list) on
  Mondays from 07:00, with a signed link (`resources+/accounting-export`, 7
  days, no login).
- KSA: tax lines are by rate (VAT 15%); ZATCA category bases are not journal
  amounts.

## Migrations and deploy order

Control plane `0084_owner_reports`: `ReportSchedule`, `ReportScheduleRecipient`,
`MonthlyResultsDelivery`, `AccountingMapping`, `AccountingSettings`,
`AccountingExport`, `Organization.deliveryCommissionBp`, flag seeds. No tenant
migration, no POS contract change (still 13). Deploy tenant-api first (new
routes), then App (migration, job route), then jobs-cron.
