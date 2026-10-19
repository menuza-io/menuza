# Decision: reservation reports live in the generic Reports system

Status: proposal for the product owner. Read-only investigation, no code
changed. Question: "use the existing reporting system in the app for reservation
reports instead of creating another page for reports in reservations."

## 0. Recommendation in one paragraph

Yes, do it, and it is cheaper than it looks. Commit c043ba8f already put two
reservation subjects (`bookings`, `waitlist_entries`) into the generic catalog,
with token grants, location scoping, a regional loader and an audit row, all
browser-direct. Most of the custom page (Summary, No-shows, Cancellations,
Waitlist, most of Turn times) is a group-by / filter / measure over those two
subjects. Three things are missing and must be added to the catalog side: (a)
numeric flag fields and ratio fields so rates (no-show %, late-cancel share,
seated share) are exact over any group; (b) turn-time target and variance fields
(reuse `configuredTurnMinutes`); (c) one new subject, `pacing_slots`, built from
the pacing math already in `buildPacingReport`. Then ship a "Reservations"
template category (7 to 9 presets), make Reports reachable from Reservations
with a deep link, redirect `/reservations/reports` to
`/reports?category=Reservations`, and delete the custom screen, its API client,
its tenant-api endpoints and its tests. Two generic extensions are worth
building and benefit every subject: grant-filtering of the dashboard Add block
picker (a pre-existing gap that gets worse with reservation templates) and a
"compare with previous period" on single-number reports (replaces the insight
sentence). One prerequisite fix: the report token route currently demands an
analytics/settings/website permission, which reservation-only roles (host, shift
manager, finance) do not hold, so they would lose reports they have today.

## 1. Inventory: what the generic Reports system supports

Sources:
`packages/reports/src/{dsl,catalog,engine,templates,export,access,operator-token}.ts`,
`packages/reports/src/ui/*`, `apps/app/app/routes/_app+/$orgSlug_+/reports+/*`.

| Area             | What exists                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subjects         | `ReportSubject` in `catalog.ts`: `scope`, `source` (`control-plane`, `tenant-api`, `integrations`), `fields`, `currencyField`, `timeZoneField`, `defaultColumns`. Regional subjects (customers, orders, phone calls, staff, reservations) run in tenant-api from the browser.                                                                                                           |
| Field types      | `datetime`, `boolean`, `enum`, `string`, `number`, `currency`, `duration` (minutes), `ratio` (ratio of two summed fields, `percent` or `per_hour`). Per-field flags: `filterable`, `groupable`, `timeframe`, `listable`, `options`, `sumLabel`/`averageLabel` (false hides a meaningless measure), `showTime`, `requiresSubject`.                                                       |
| Measures         | `count`, `percent` (share per segment), `sum`, `average`, `ratio` (`dsl.ts` `measureSchema`). Currency is never added across currencies (`mixedCurrencies`).                                                                                                                                                                                                                            |
| Group-bys        | Up to 3 `groupBy` fields, plus `timeBucket` day / week / month for datetime fields.                                                                                                                                                                                                                                                                                                     |
| Filters          | `filterGroupSchema`: nested and/or/not groups; operators `eq`, `neq`, `contains`, `starts_with`, `is_empty`, `is_not_empty`, `in`.                                                                                                                                                                                                                                                      |
| Date ranges      | `timeframe.preset`: today, last_7_days, last_30_days, last_3_months, last_6_months, last_12_months, all_time, custom (ISO start/end). Edges are cut in the record's own zone when the subject sets `timeZoneField`.                                                                                                                                                                     |
| Chart styles     | `pie`, `single_number`, `table`, `bar`. A `table` with no group-by is a list report (columns, max 8).                                                                                                                                                                                                                                                                                   |
| Saved reports    | `saveReport`, `listSavedReports` (`@repo/reports/server`); routes `reports+/_index.tsx`, `new.tsx`, `$reportId.tsx`; the definition is the only thing saved (never results). Access is re-checked on every list/open through `definitionAllowed`.                                                                                                                                       |
| Export           | `export.ts`: CSV for list and aggregate reports (`reportToCsv`), PNG/SVG/PDF for charts. No scheduling or email delivery exists in `packages/reports` (nothing to inherit or to lose).                                                                                                                                                                                                  |
| Templates        | `templates.ts` `organizationTemplates()` grouped by category (Sales, Orders, Menu, Marketing, Reviews, Labor, Hiring). Titles translated in `ui/report-labels.ts` (`TEMPLATE_LABELS`, `CATEGORY_LABELS`, checked by `TRANSLATED_TEMPLATE_IDS`). `ReportStart` / `ReportLibrary` render them.                                                                                            |
| Dashboard blocks | Block type `report` (unlimited instances) shows a saved report or a template (`utils/dashboards/reports.ts`, `components/dashboard/blocks/report-block.tsx`, `report-block-options.tsx`); regional subjects fetch with the same token and `tenantApiUrl` (`ReportBlockData`). Separate built-in block `bookings-today` (`bookings-today.server.ts`).                                    |
| Permissions      | `operator-token.ts`: `RESTRICTED_REPORT_SUBJECTS` (includes both reservation subjects via spread) are listed in the JWT `subjects` claim only when granted; `scopeIds` limits locations. `access.ts` (`catalogForGrants`, `definitionAllowed`, `templatesForGrants`) hides gated subjects from the UI. tenant-api re-checks (`operatorTokenAllowsSubject`, `locationIds`) on every run. |

### Reservation subjects already exposed (`catalog-reservations.ts`)

`bookings` (one row per reservation): `startsAt` (timeframe), `businessDate`,
`location`, `service`, `experience`, `partySize`, `covers`, `status` (13
values), `channel` (7), `durationMinutes`, `actualMinutes`, `lateCancel`,
`paymentStatus`, `collectedMinor`, `refundedMinor`, `currency`, `timeZone`.
`waitlist_entries`: `joinedAt` (timeframe), `businessDate`, `location`,
`partySize`, `channel`, `status` (outcome), `quotedMinutes`, `actualMinutes`,
`timeZone`. No field carries a name, phone, email, note or allergy text.

How they fetch data: browser GETs `/<org>/reports/token` (`reports+/token.ts`:
mints `mintOperatorAnalyticsToken` with `subjects` and `scopeIds`, returns the
regional `tenantApiUrl`, `Cache-Control: private, no-store`), then POSTs the
definition straight to tenant-api `routes/analytics.ts` (branch at line ~442
`isReservationsReportSubject`): `loadBookingRecords` / `loadWaitlistRecords`
(`services/rsv-report-records.ts`, 20,000 row cap, `truncated` flag),
`auditRsvReportRun`, then the shared engine computes the result. Grant mapping:
`resolveReservationsReportAccess` in
`apps/app/app/utils/reservations/report-access.server.ts` requires the
`reservations.enabled` flag, `read:reservation_report:any`, no impersonation,
and non-empty locations. No PII reaches the App. This already satisfies ADR 048.

Tests that already cover this: `reports+/token.reservations.test.ts`,
`reports+/reports.reservations-subjects.test.ts`,
`apps/tenant-api/src/routes/analytics.reservations.test.ts`.

## 2. What the custom `/reservations/reports` page does, and the gap

The custom page: route `reservations+/reports.tsx`, screen
`components/reservations/reports/reports-screen.tsx` (+ `report-panels.tsx`,
`report-insight.tsx`), client `utils/reservations/reports-api.ts`,
`reports-view.ts`, `reports-export.ts`; server
`apps/tenant-api/src/routes/operator-reservations-reports.ts` (six GET kinds,
one location, `from`/`to` business dates, max 366 days, optional service) and
`services/rsv-report-service.ts` (`buildSummaryReport`, `buildNoShowsReport`,
`buildCancellationsReport`, `buildTurnTimesReport`, `buildWaitlistReport`,
`buildPacingReport`, `auditReportRun`).

Two notes before the table. First, the page has no allergy or dietary content at
all (grep of the screen, the service and the catalog finds only comments that
forbid it), so there is nothing to migrate; the PII rule is the same in both
systems (aggregate facts only). Second, the two math paths are not identical
today: the service uses `coversOf = coversActual ?? partySize`, the generic
record uses `bookingCovers` (also uses `seatedCovers` for finished parties).
Totals can differ between the old page and the generic report. Decide one
(recommend `bookingCovers`) and say so in the release note.

Legend: COVERED = a preset over the existing catalog; CATALOG = needs new
catalog entries only; NEW = needs a new capability.

| Custom panel                                             | What it shows                                                        | Generic equivalent                                                                                                          | Status                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary: totals (parties, covers)                        | Two numbers, excluding cancelled, declined, expired                  | `bookings`, single_number, count / sum `covers`, filter status `in` booked set (all pending, booked, ... statuses)          | COVERED                                                                                                                                                                             |
| Summary: by service / source / party size / status       | Parties and covers per group                                         | `bookings`, bar/table, groupBy service / channel / partySize / status, measure sum `covers` (segment shows count and value) | COVERED                                                                                                                                                                             |
| Summary: insight sentence ("No-show rate x, up from y")  | One computed sentence, compares to the prior period                  | None                                                                                                                        | NEW (compare with previous period on single_number, section 4.3); sentence itself is dropped                                                                                        |
| No-shows: total, covers, rate                            | Rate = no-shows / bookings that are not cancelled, declined, expired | count with filter status = no_show; rate needs a ratio                                                                      | CATALOG (`noShowRate` ratio field)                                                                                                                                                  |
| No-shows: by service, by party size                      | Group tables                                                         | groupBy service / partySize with the no-show filter                                                                         | COVERED                                                                                                                                                                             |
| No-shows: row list                                       | Date, time, service, party, source                                   | List report (table, no groupBy), columns `startsAt` (showTime), service, partySize, channel, filter no_show                 | COVERED                                                                                                                                                                             |
| Cancellations: total, late, regular                      | Counts                                                               | count; groupBy `lateCancel`                                                                                                 | COVERED                                                                                                                                                                             |
| Cancellations: by cancelled-by                           | guest / restaurant / system / unknown                                | `bookings` has no `cancelledBy` field                                                                                       | CATALOG (`cancelledBy` enum)                                                                                                                                                        |
| Cancellations: rows                                      | Row list with late flag, cancelled at                                | List report, filter status = cancelled; needs `cancelledBy`                                                                 | CATALOG (same field)                                                                                                                                                                |
| Turn times: actual average by party size                 | Mean seated-to-finished minutes                                      | filter status = finished, groupBy partySize, average `actualMinutes`                                                        | COVERED                                                                                                                                                                             |
| Turn times: configured and variance                      | Configured rule minutes per party size and actual minus configured   | Not in the record                                                                                                           | CATALOG (`configuredTurnMinutes`, `turnVarianceMinutes`, reuse `configuredTurnMinutes()`)                                                                                           |
| Turn times: configured rules table                       | The rules list itself                                                | It is settings, not facts                                                                                                   | Not needed (stays in Settings > Policies)                                                                                                                                           |
| Waitlist: total, outcomes                                | Count by outcome                                                     | `waitlist_entries` groupBy status                                                                                           | COVERED                                                                                                                                                                             |
| Waitlist: quoted vs actual average                       | Two averages                                                         | average `quotedMinutes` and `actualMinutes` (two reports or one table via groupBy status)                                   | COVERED                                                                                                                                                                             |
| Waitlist: seated share                                   | Not on the page as a figure, useful                                  | needs ratio                                                                                                                 | CATALOG (`seatedRate`, optional)                                                                                                                                                    |
| Waitlist: rows                                           | Per-entry list                                                       | List report                                                                                                                 | COVERED                                                                                                                                                                             |
| Pacing: totals, by service                               | Bookings and covers                                                  | `bookings` groupBy service                                                                                                  | COVERED                                                                                                                                                                             |
| Pacing: slots vs limits, over-limit flag                 | One row per date, service, slot with limit                           | Not a booking-level fact; limits live in `rsv_pacing_rules`                                                                 | NEW SUBJECT (`pacing_slots`, section 4.2)                                                                                                                                           |
| Date range: 7 / 30 / 90 days, custom dates, max 366 days | Business-date range at one location                                  | Presets 7 days, 30 days, 3 months, custom                                                                                   | COVERED (90 days maps to last_3_months)                                                                                                                                             |
| Location picker                                          | One location at a time (the shell's active location)                 | `location` is a filterable, groupable field; token already limits to the person's locations                                 | COVERED (deep link carries a location filter)                                                                                                                                       |
| Service filter                                           | One service                                                          | `service` filter                                                                                                            | COVERED                                                                                                                                                                             |
| CSV export                                               | Main table of each tab                                               | `reportToCsv` for list and aggregate reports                                                                                | COVERED                                                                                                                                                                             |
| Refresh button                                           | Run again                                                            | Runner re-runs on change; has a refresh in `use-report-runner.ts`                                                           | COVERED                                                                                                                                                                             |
| Audit row per run                                        | `auditReportRun` (`report.run`, kind, range)                         | `auditRsvReportRun` (subject, row count)                                                                                    | COVERED (different payload shape; update `docs/reservations.md` audit text)                                                                                                         |
| Per-tab translations (en, ar)                            | Lingui                                                               | Template titles via `TEMPLATE_LABELS`                                                                                       | CATALOG (add ar strings for new templates and field labels; field labels in the catalog are English constants today, check how staffing labels are localized in `report-labels.ts`) |
| Mobile/RTL layout, e2e testids                           | `report-tab-*` etc.                                                  | Generic workspace                                                                                                           | Tests are rewritten, not ported                                                                                                                                                     |

Net: 3 panels need catalog fields, 1 needs a new subject, 1 needs a new generic
capability (previous-period comparison). Nothing the page shows is impossible.

## 3. Recommended architecture

Principles: Reports is the single reporting surface; data stays regional and
browser-direct; no new PII; one grant (`read:reservation_report:any`).

### 3.1 User-visible behaviour

1. Reservations top nav / sidebar "Reports" item stays as a link, but points to
   the generic list filtered to reservations:
   `/<org>/reports?category=Reservations`. (Keep it in the Reservations nav so
   hosts find it; it is a link out, not a tab.) Visibility keeps using
   `canSeeReservationsSection('reports', ...)`.
2. Generic Reports start page (`ReportStart` / `ReportLibrary`) gains a
   `category` search param that expands and scrolls to that category (it is a
   Collapsible per category already, `defaultOpen`). New category:
   `Reservations`.
3. Templates (ids kebab-case, subject, chart, default timeframe):
   - `rsv-daily-summary` "Daily summary": `bookings`, bar, groupBy
     `businessDate` (string, sorts as a date and is the service day), measure
     sum `covers`, last_7_days, filter `isBooked` = 1 (or status `in` the booked
     set).
   - `rsv-covers-by-service` "Covers by service": bar, groupBy `service`, sum
     `covers`.
   - `rsv-by-channel` "Bookings by channel": pie, groupBy `channel`.
   - `rsv-no-show-rate` "No-shows and cancellations": table, groupBy `service`,
     measure ratio `noShowRate` (plus a sibling `rsv-cancellations` list
     filtered to cancelled).
   - `rsv-no-show-list`: list report, filter no_show.
   - `rsv-turn-times` "Turn times": table, groupBy `partySize`, average
     `actualMinutes`, filter finished (variant with `turnVarianceMinutes`).
   - `rsv-waitlist-outcomes` "Waitlist": `waitlist_entries`, pie, groupBy
     status; `rsv-waitlist-waits`: average `actualMinutes` groupBy `partySize`.
   - `rsv-pacing` "Pacing": `pacing_slots`, table, groupBy `slotTime`, sum
     `covers`, filter `overLimit` true (or ratio utilization). Note: date
     grouping uses `timeBucket: 'day'` on `startsAt` (datetime field), not
     `businessDate` (a string). Keep `startsAt` as the timeframe field;
     `businessDate` stays a filterable/groupable string for exports.
4. Presets are templates, not seeded saved reports. Templates need no DB writes,
   are versioned with the code, are filtered by grants (`templatesForGrants`),
   and "Save" in the builder copies one into a saved report. Seeding saved
   reports per organization would require a migration and would clutter orgs
   that never use reservations.
5. Dashboard blocks for KPIs: no new block type. Add single_number templates
   (`rsv-covers-today`, `rsv-no-show-rate-30d`, `rsv-late-cancels-30d`,
   `rsv-waitlist-avg-wait-7d`), which appear in the Add block dialog as `report`
   blocks. Keep `bookings-today` as is (live operational list, not a report).
6. Redirects: `/<org>/reservations/reports` -> 301/302 to
   `/<org>/reports?category=Reservations`; the old `?location=` param becomes
   ignored (reports cover the person's locations; `location` is a filter in the
   builder, see 3.3). Keep the redirect route for at least one release.

### 3.2 Residency and permissions (unchanged invariants)

- Data path: browser -> `/reports/token` (control plane, no PII) -> tenant-api
  `POST /analytics/...` directly. No Sites/App proxying, no new App route reads
  reservation rows. ADR 048 holds.
- Grants: nothing new. The token route already maps
  `read:reservation_report:any` + `reservations.enabled` + location scope to
  subjects `bookings`, `waitlist_entries` (+ `pacing_slots` automatically,
  because `RESERVATIONS_REPORT_SUBJECTS` is spread into
  `RESTRICTED_REPORT_SUBJECTS` and `resolveReservationsReportAccess`).
- Prerequisite fix (blocking, section 5 step 1): `reports+/token.ts` throws 403
  unless the person has `read:analytics:any`, `read:settings:any` or
  `read:website:any`. The custom page needs only `read:reservation_report:any`
  (roles `shift_manager`, `finance`, `reservations_manager` in
  `docs/reservations.md`). Make the gate "analytics OR settings OR website OR
  any non-empty restricted subject set that the token grants itself (staff,
  reservations)". The same applies to the Reports sidebar item and the three
  report routes (they have no permission check of their own; they depend on the
  token call failing). Known issue in `AGENTS.md`: no role holds
  `read:analytics:any`, so today only admin-like roles can run reports at all.
  Add the new rule to `token.reservations.test.ts`.
- Sidebar: the top-level "Reports" item (`components/app-sidebar.tsx` line ~298)
  is shown to everyone. For a reservations-only person it must show when they
  hold the reservation report grant; otherwise the link leads to an empty page.
  Prefer to compute `canSeeReports` in the layout loader from the same grants.
- Dashboard picker gap (pre-existing): `loadBlockPicker`
  (`utils/dashboards/block-data.server.ts` line ~375) returns
  `reportTemplateGroups()` and `loadSavedReportOptions` without
  `templatesForGrants` / `definitionAllowed`. Staff templates already show to
  people who cannot run them. Adding 8 reservation templates makes this worse.
  Filter both by `resolveReportGrantsForRequest` (needs `request`; its callers
  in `index.tsx` and `actions.server.ts` have it). Also gate rendering of a
  saved report block when the viewer lacks the grant (the block shows the
  generic "no access" state; verify `use-report-state-messages.ts` handles
  `unauthorized`).

### 3.3 Location scoping

Generic reports span every location in the token (`scopeIds`). That is correct
for reports; a template can pre-filter `location` eq <name> only if the id is
known, and filters hold names (`location` string), so presets span all locations
and users filter or group by `location`. If the deep link must carry the active
location, support `?location=<name>` in `new.tsx` loader that adds an `eq`
condition (S effort), otherwise skip it.

## 4. Catalog additions and generic extensions

### 4.1 `bookings` fields to add (`packages/reports/src/catalog-reservations.ts`, loader `bookingRecord` in `services/rsv-report-records.ts`)

| Field id                                                | Type                                               | Source                                                                                                                  | Notes                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cancelledBy`                                           | enum guest / restaurant / system / unknown         | `row.cancelledBy ?? 'unknown'` (same as `buildCancellationsReport`)                                                     | filterable, groupable                                                                                                                                                                                  |
| `isBooked`                                              | number (0/1), `listable: false`, `sumLabel: false` | `!NOT_BOOKED.has(status)` (export `NOT_BOOKED` from `rsv-report-service.ts` into a shared module, do not copy)          | ratio denominator                                                                                                                                                                                      |
| `isNoShow`, `isCancelled`, `isLateCancel`, `isFinished` | number (0/1), same flags                           | status / `lateCancel`                                                                                                   | ratio numerators                                                                                                                                                                                       |
| `noShowRate`                                            | ratio percent = `isNoShow` / `isBooked`            | engine ratio measure                                                                                                    | same definition as `buildNoShowsReport.rate` (documented caveat in `docs/reservations.md` that upcoming bookings count in the denominator; the filter on `startsAt` before now fixes it in the preset) |
| `cancellationRate`                                      | ratio percent = `isCancelled` / bookingCount       | needs a constant-1 field `bookingCount` (number, 1)                                                                     | optional                                                                                                                                                                                               |
| `lateCancelShare`                                       | ratio percent = `isLateCancel` / `isCancelled`     |                                                                                                                         |                                                                                                                                                                                                        |
| `configuredTurnMinutes`                                 | duration                                           | `configuredTurnMinutes(rules, partySize, serviceId, businessDate)` (exported already, `rsv-report-service.ts` line 276) | loader loads `rsvTurnTimes` once per run                                                                                                                                                               |
| `turnVarianceMinutes`                                   | number (can be negative)                           | `actualMinutes - configuredTurnMinutes`, null if either missing                                                         | average label "Average difference from configured turn time"; verify engine average of empty/negative values                                                                                           |
| `hourOfDay`/`slotTime`                                  | string `HH:MM`                                     | `formatMinutesToHHMM(localStartMin)`                                                                                    | groupable; gives by-slot bookings without a new subject                                                                                                                                                |

Ratio engine caution: `ratioParts` and `valueMeasureLabel` in `engine.ts` decide
whether numerator and denominator fields are accepted; the existing ratios
(`laborCostPercent`, `catalog-staffing.ts` line ~370) use currency / duration
fields. Spike one test in `packages/reports/src/engine.test.ts` with a
number-typed flag pair before committing to this design. Fallback if the engine
refuses: ratio in a presets-only way (`measure: percent` with groupBy `status`,
which already gives the share per status over the filtered set).

### 4.2 New subject `pacing_slots` (reuse, not reimplement)

Add `'pacing_slots'` to `RESERVATIONS_REPORT_SUBJECTS` and a `pacingSlotFields`
list: `businessDate`, `location`, `service`, `slotTime` (string, groupable),
`startsAt` (datetime timeframe), `bookings` (number), `covers` (number),
`maxCovers`, `maxParties` (number), `overLimit` (boolean, filterable),
`coversUtilization` (ratio percent = covers / maxCovers, rows with no limit are
excluded by the ratio rule), `timeZone`.

Loader `loadPacingSlotRecords(ctx, definition)` in `rsv-report-records.ts`:

1. Load bookings with `loadBookingRecords`-style query limited to the timeframe.
2. Call a function extracted from `buildPacingReport` (refactor, behaviour
   unchanged): `computePacingSlots(bookedRows, rules, names)` that returns the
   `slotRows` array (the `slots` map, `limitFor`, `overLimit` logic from lines
   ~495 to ~540 of `rsv-report-service.ts`). `buildPacingReport` then calls the
   same function, so both outputs stay identical until the old endpoint is
   deleted.
3. Map each slot to a `ReportRecord`. Wire in `analytics.ts` (new branch beside
   `bookings`/`waitlist_entries`; line 81 list of subjects too),
   `catalog-reservations.ts` `reservationsSubjects`, and `isGatedSubject`. Token
   minting needs no change (spread).

### 4.3 Generic-system extensions

| Extension                                                                                                                                          | Why                                                                                                                    | Effort                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Grant-filter the dashboard picker (templates + saved reports)                                                                                      | Existing gap; reservation templates would leak existence to non-grantees                                               | S (0.5 day)                                                                                                                                                                                                              |
| `?category=` param on Reports start (`ReportStart`, `ReportLibrary`)                                                                               | Deep link from Reservations                                                                                            | S                                                                                                                                                                                                                        |
| Token route gate relaxed for restricted-only roles                                                                                                 | Reservation-only roles keep reports                                                                                    | S, needs tests                                                                                                                                                                                                           |
| Previous-period comparison on `single_number` (`compare: 'previous_period'` in `visualization`, engine runs the shifted timeframe, UI shows delta) | Replaces insight sentence; useful for all subjects                                                                     | M (2 to 3 days: DSL + engine + UI + tests; DSL schema change is additive with a default)                                                                                                                                 |
| Table-only subject / per-measure formatting                                                                                                        | Not needed: `pacing_slots` is a normal record subject; `duration` and `ratio` types already format minutes and percent | none                                                                                                                                                                                                                     |
| CSV export                                                                                                                                         | Already exists                                                                                                         | none                                                                                                                                                                                                                     |
| Multi-panel "report pack" (all panels in one view)                                                                                                 | The custom page gave six tabs in one place; generic equivalent is a dashboard of report blocks                         | M optional: a "Reservations overview" dashboard preset created on request ("Create from template" in the dashboard switcher). Skip in v1; document that users can add the template blocks to Home or a custom dashboard. |
| Scheduling or email delivery                                                                                                                       | Neither system has it                                                                                                  | out of scope                                                                                                                                                                                                             |

Effort total (engineering days, one person incl. tests and translations):
catalog fields S-M (1.5), pacing subject M (1.5), templates and labels S (1),
deep link, redirect, nav S (1), token gate and sidebar S (1), picker filter S
(0.5), delete and migrate tests/docs S (1), previous-period compare M (2.5,
optional, can ship after). About 7.5 days without compare, 10 with.

## 5. File list

### Add

- `packages/reports/src/catalog-reservations.ts`: fields from 4.1, subject
  `pacing_slots` (edit, not new file).
- `apps/tenant-api/src/services/rsv-report-records.ts`: `loadPacingSlotRecords`,
  extra booking fields, turn rule load (edit).
- `apps/tenant-api/src/services/rsv-report-shared.ts` (new, small):
  `NOT_BOOKED`, `coversOf`/`bookingCovers` single definition,
  `computePacingSlots` (moved from `rsv-report-service.ts`).
- `packages/reports/src/templates.ts`: `reservationTemplates()` merged into
  `organizationTemplates()` (category `Reservations`).
- `packages/reports/src/ui/report-labels.ts`: `TEMPLATE_LABELS` entries and
  `CATEGORY_LABELS.Reservations`; `apps/app/app/locales/{en,ar}` catalogs via
  `npm run lingui:extract -w app` then `node scripts/check-lingui.mjs`.
- Tests: see section 7.
- `apps/app/app/routes/_app+/$orgSlug_+/reservations+/reports.tsx`: keep as a
  redirect-only loader (no component).

### Change

- `packages/reports/src/operator-token.ts` and `access.ts`: no change expected
  (spread picks up the new subject); add test cases.
- `packages/reports/src/ui/report-library.tsx`: honor `?category=` (open and
  scroll).
- `apps/app/app/routes/_app+/$orgSlug_+/reports+/_index.tsx`: read `category`,
  pass to `ReportStart`.
- `apps/app/app/routes/_app+/$orgSlug_+/reports+/token.ts`: relax the permission
  gate (3.2).
- `apps/app/app/components/app-sidebar.tsx`: Reservations "Reports" sub-item url
  becomes `/${orgSlug}/reports?category=Reservations` (isActive logic: stop
  treating `/reports` as both); top-level Reports visible for reservation-report
  holders (line ~760 map keyed by url must be re-keyed since the url changes:
  `allowedByUrl` uses `/${orgSlug}/reservations/reports`).
- `apps/app/app/components/reservations/reservations-chrome.tsx` (line ~98, 163)
  and `utils/reservations/shell-routes.ts`, `utils/reservations/sections.ts`,
  `utils/reservations/nav.ts`: the `reports` section becomes an external link
  (`href` to the generic Reports), no longer a shell route;
  `RESERVATIONS_SECTION_REQUIREMENTS.reports` stays for visibility. Update
  `nav.test.ts`, `reservations-chrome.test.tsx`, `host-subnav.test.tsx`,
  `header-controls.test.tsx`, `design-conventions.test.ts` where they list the
  reports tab.
- `apps/app/app/utils/ai/app-nav-routes.ts`: reservations reports entry path.
- `apps/app/app/utils/dashboards/block-data.server.ts`: grant-filter the picker
  (3.2).
- `apps/tenant-api/src/routes/analytics.ts`: pacing branch; subjects list
  line 81.
- `apps/tenant-api/src/services/rsv-report-service.ts`: delete the build*
  functions after cutover (see Delete); keep `configuredTurnMinutes` and move
  shared helpers.
- `packages/reservations/src/token.ts` and `permissions.test.ts`: the `reports`
  scope of the reservations token
  (`GET /<org>/reservations/token?scope=reports`) goes away only if nothing else
  uses it; check `useReservationsScopeClient(..., 'reports')` callers first.
- Docs: `docs/reservations.md` (line 27 table, lines ~287 to 296 notes, audit
  text), `docs/reservations-contract.md`,
  `docs/reservations-mission/{architecture,validation-contract}.md`,
  `docs/reservations-mission/features.json` (mark reports feature as moved),
  `apps/app/PRODUCT.md` (Reports and Reservations sections),
  `docs/decisions/048-reservations-data-residency.md` (one line: reports run
  through the report token).

### Delete (last step, after redirect and e2e are green)

- `apps/app/app/components/reservations/reports/{reports-screen,report-panels,report-insight}.tsx`
  and `reports-screen.test.tsx`.
- `apps/app/app/utils/reservations/reports-api.ts`, `reports-view.ts`,
  `reports-export.ts` (and their tests, if any).
- `apps/tenant-api/src/routes/operator-reservations-reports.ts` and its mount in
  the tenant-api router; the `build*Report` functions and `REPORT_KINDS` in
  `rsv-report-service.ts`; `auditReportRun`.
- `apps/tenant-api/src/routes/reservations-guestbook-reports.test.ts`: remove
  the report cases; `reservations-security.test.ts`: remove the
  `/operator/reservations/reports/*` rows (every operator route test must still
  prove forged-token refusal for the remaining routes).
- `apps/app/tests/e2e/reservations-guestbook-reports.test.ts`: replace the
  reports test (lines ~305 to 335) with a generic-reports test (below); keep
  guestbook and Bookings today tests.
- Lingui entries for the deleted components (extract removes them).

### Migration of links

`/reservations/reports` bookmarks, the Reservations chrome tab, sidebar item, AI
nav route, docs table and the e2e `navigate('/:slug/reservations/reports')`.
Backwards compat: keep the route module as a redirect, preserving `lng`:
`/reservations/reports?location=X&lng=ar` ->
`/reports?category=Reservations&lng=ar`.

## 6. Risks

1. Behavioural differences in numbers (covers definition, no-show denominator
   includes upcoming bookings). Mitigate: one shared definition, a note in
   `docs/reservations.md`, and golden-value tests (section 7) before deleting
   the old math.
2. Reservation-only roles lose access if the token gate is not relaxed first.
   Ship the gate fix before changing the nav.
3. Ratio engine may not accept number-typed flags; spike first, fallback is
   `percent` measure by status.
4. 20,000 row cap and the 366-day cap: the old page capped by days, the generic
   one by rows (`sourceTruncated` notice exists). A busy venue could exceed
   20,000 bookings in a year; the notice shows, but "all_time" templates must
   not be offered (use last_3_months defaults).
5. Time-zone semantics: the old page used the location's `businessDate`; the
   generic timeframe cuts `startsAt` in `timeZone` (record zone). A booking
   after midnight but in the previous service day can land in a different day in
   a `startsAt` bucket versus `businessDate`. Mitigate: bucket templates by
   `businessDate` groupBy (string, sorts correctly) rather than `timeBucket`
   where the service day matters, and document it.
6. Multiple locations: generic reports aggregate across locations (and currency
   fields are per row currency); old page was one location. Presets should show
   `location` as a group-by only when the person has more than one.
7. PII regression: every new field must be a coded value or number. Add a
   field-name allow-list test (see 7) so a later `guestName` or `notes` field
   fails CI.
8. Translations: the catalog labels are English constants; confirm how the
   staffing subjects are localized before assuming Arabic works for the new
   fields (`report-labels.ts`).
9. Dashboard picker leak (pre-existing) must be fixed in the same release.
10. `AGENTS.md` known issue: no role grants `read:analytics:any`. Do not rely on
    analytics permission anywhere in the new path.

## 7. Ordered implementation plan (small, safe steps) and test plan

Each step is independently shippable and leaves the old page working until
step 9.

1. Token gate: allow people whose token grants any restricted regional subject
   (staff or reservations) even without analytics/settings/website. Tests:
   extend `token.reservations.test.ts` (reservation-only role gets token with
   `bookings`; still 403 with neither grant), `token.staffing.test.ts`
   unchanged.
2. Picker and saved-report grant filtering in `block-data.server.ts`. Tests:
   `block-data.server.test.ts` (non-grantee sees no staff or reservation
   templates; grantee does).
3. Shared helpers extraction (`rsv-report-shared.ts`: `NOT_BOOKED`, covers,
   `computePacingSlots`), pure refactor. Tests: existing service tests and the
   old endpoints' tests stay green (golden-value test that `buildPacingReport`
   output is byte-identical).
4. Catalog fields + loader (4.1). Tests: `packages/reports` engine test with a
   number-flag ratio (spike first), `analytics.reservations.test.ts` rows for
   `cancelledBy`, `isNoShow`, `turnVarianceMinutes`, parity test: for a seeded
   range, generic `noShowRate` equals `buildNoShowsReport().rate` and covers sum
   equals `buildSummaryReport().totals.covers` (documented delta if
   `bookingCovers` is chosen), PII allow-list test over
   `reservationsSubjects[*].fields[*].id`.
5. `pacing_slots` subject (4.2). Tests: parity with `buildPacingReport().slots`,
   location scoping (token with one location sees only its slots),
   `reservations-security`-style test (missing/forged/non-granted token refused,
   cross-org refused).
6. Templates + labels + `?category=`. Tests: `templates.test.ts` (every template
   references a real subject and fields, runs through `definitionAllowed`),
   `report-labels` translated-ids test, `reports.reservations-subjects.test.ts`
   (templates listed only to grantees), `report-library` unit test for
   `category` expansion.
7. Reservations nav link and redirect route; sidebar and chrome tests updated.
   Tests: `nav.test.ts`, `reservations-chrome.test.tsx`, loader test that
   `/reservations/reports?lng=ar` redirects to
   `/reports?category=Reservations&lng=ar`.
8. Dashboard KPI templates (single_number) + e2e. E2E (replace the reports case
   in `reservations-guestbook-reports.test.ts`, stub `/analytics` and token like
   the existing stubs): open Reservations > Reports link, land on Reports with
   the Reservations category open, run "No-shows and cancellations", assert the
   request went to tenant-api directly (no reservation fields in any App `.data`
   response, as the Bookings today test already checks), RTL `lng=ar` renders
   `dir=rtl`, CSV export button present.
9. Cutover: delete the custom page, client, tenant-api endpoints, tests, update
   docs (section 5 Delete). Run `npm run typecheck -w app`,
   `npm run lint -w app`, `cd apps/app && npx vitest run`, tenant-api vitest,
   `node scripts/check-lingui.mjs`. E2E per `AGENTS.md` (ask first on a
   developer machine).
10. Optional: previous-period compare on single_number (4.3), then add the
    "No-show rate vs. previous period" KPI template.

Rollback: steps 1 to 8 are additive; only step 9 deletes. If the owner prefers a
softer landing, ship 1 to 8 and keep the old route behind the redirect-less link
for one release before step 9.

## 8. Open questions for the product owner

1. Is one source of truth for covers OK (include seated covers for finished
   parties), accepting that old and new totals can differ slightly?
2. Should presets span all locations (recommended) or must the deep link carry
   the active location?
3. Allergy or dietary reporting: not on the current page. Allowed only as coded
   aggregate counts after a privacy review; free text never.
4. Is a combined "Reservations overview" dashboard worth a follow-up, since the
   six-tab single view has no one-screen equivalent in Reports?
