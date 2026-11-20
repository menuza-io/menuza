# Website publishing

Version history, scheduled publish, announcement windows, safer redirects, legal
pages with a cookie banner, Menuza agreements and the accessibility statement,
added in one change for #85, #180, #238, #248, #89, #194 and #260. Everything
here is control-plane business data (the restaurant's own content, settings and
Menuza's agreements with the restaurant). No guest data is stored. A guest's
cookie choice lives only in their browser.

Read `docs/website-seo.md` first: this change extends its publish helper, its
redirects and the Sites stack, and adds no second sitemap, redirect system or
version store.

## Step zero: what already existed

| Issue | What the product already had                                                                                                                                              | What was missing                                                                                 | Decision                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #85   | `publishWebsitePage` (`utils/website/publish-page.server.ts`), `WebsitePage.publishedData`, `updateSiteTheme` with conflict detection, `AuditLog` writer in `@repo/audit` | Versions, restore, discard, draft header/footer/theme, Activity                                  | Extend `publishWebsitePage`; one `WebsiteVersion` table; drafts are nullable `Organization.draft*` columns; Activity reads `AuditLog` (no second log)  |
| #180  | Social post workflow (`jobs-cron/social-post-workflow.ts`, `jobs.social-publish.ts`) as the pattern                                                                       | Schedule table, claim, workflow, UI                                                              | Copy that pattern; one `WebsiteScheduledPublish` table; same version snapshot format                                                                   |
| #238  | `OrganizationAnnouncement` editor and the cached public payload; #132 popups are open, so there was no date pattern to copy                                               | Window fields, request-time filtering, cache bounds                                              | Two nullable columns on the existing table; window logic in `@repo/common/announcement-window` shared by App and Sites                                 |
| #248  | `redirect-destination.ts` (accepts any http/https), cycle check and automatic redirects from #88 (`redirect-plan.ts`, `redirects.server.ts`)                              | Credentials, own-domain, http and system-path refusal; unpublished-target fallback; list warning | Extend `redirect-destination.ts` (one validator) and the existing redirects route; the 302 fallback is computed where the public payload is built      |
| #89   | Tracking tags booted unconditionally (`site-pixels.ts`), no footer legal links, checkout text without a link, a feature flag store (`getFeatureFlag`)                     | Templates, generator, banner, consent logic, links                                               | One generator in `@repo/common/legal`; pages are ordinary `WebsitePage` rows (`legalKind`); flag `website.consent_banner` is a kill switch, default on |
| #194  | The onboarding checkbox stored nothing; no agreement tables                                                                                                               | Versioned agreements, append-only acceptances, dialog, Settings, Legal, Admin list               | ONE system (`LegalAgreement` + `LegalAcceptance`) that also closes #89's operator-agreement criterion                                                  |
| #260  | Nothing                                                                                                                                                                   | Statement template and footer link                                                               | A fourth kind of the #89 generator; the footer link is the same path as the other legal links                                                          |

## Version history (#85)

- `publishWebsitePage` now also writes an immutable `WebsiteVersion` (kind
  `page`), prunes the page's history to the newest 50 and does all of it in one
  `db.batch`. Every publish path goes through it (page list, editor, schedule,
  new organizations).
- **Header, footer and theme are drafts.** Edits write
  `Organization.draftHeaderConfig`, `draftFooterConfig` and `draftSiteTheme`
  (null means "same as live"). Sites reads only the live columns. The preview
  token path of `/resources/sites/page` shows the draft header and footer to
  editors.
- **Publish publishes the page and the pending site design together** in one
  guarded batch (`publishPageWithSiteDesign`): the Organization UPDATE is last
  and every earlier statement carries the same "design columns unchanged" guard,
  so a lost race writes nothing. Branding has its own Publish (`publish-site`)
  and history.
- **Unpublished changes badge** compares the hash of the saved sections with the
  hash of the live snapshot, computed on read. The issue suggested a stored
  `WebsitePage.draftHash`; a stored hash would have to be maintained by every
  write path (editor, AI, translation, templates, restore, discard), so it is
  derived instead and cannot go stale. `expectedDraftHash` for restore is the
  same value.
- **Restore** replaces the draft only. A draft changed since History was opened
  answers `409 stale_version`. **Discard** returns the page and the pending
  design to live; a never-published page answers `409 never_published` and
  nothing is deleted.
- **Deleting a page** marks its versions (`deletedAt`); the daily
  `/resources/jobs/website-version-prune` removes them after 30 days and cuts
  any history to 50.
- Missing media in an old version: History's preview and the restore result list
  `objectKey`s the media library no longer has.
- Activity (Website, Activity) lists `AuditLog` rows for publish, unpublish,
  restore, discard, delete, schedule, redirect and legal-page actions
  (`utils/website/activity.server.ts`). Domain changes are logged by the
  organization settings route that already audits them.
- The migration backfills one version per published page and one each for the
  live header/footer and theme.

## Scheduled publish (#180)

- `WebsiteScheduledPublish` freezes the draft in the version snapshot format at
  scheduling time, so later edits are not published. One active schedule per
  page and one for the site design (`scopeKey`, a partial unique index).
  Scheduling again replaces it. 5 minutes to 90 days ahead
  (`invalid_schedule_time`), in the site's time zone (default location's zone,
  else the staff time zone), stored in UTC.
- A schedule is claimed by one caller (`scheduled` to `running`), applied with
  the same writes as a publish, retried by the hourly sweep and stopped after 3
  attempts with an in-app notice. `POST /resources/jobs/website-publish` is
  called by jobs-cron's `WebsitePublishWorkflow` (sleeps until `runAt`, so it
  runs within a minute) and by the hourly sweep as the backup.
- Publishing now, unpublishing or deleting the page cancels the schedule.

## Announcement windows (#238)

- `OrganizationAnnouncement.startsAt` / `endsAt` (UTC). The editor takes wall
  clock times in the site's time zone; the server converts them (never the
  browser), refuses a time that does not exist (the skipped hour) and an "until"
  that is not after "from".
- The public payload carries the window; **Sites decides per request**
  (`activeAnnouncements`). The HTML `Cache-Control` is cut so max-age plus the
  stale window ends at the next start or end (`publishedHtmlCacheControl`).
  Pre-start announcements are visible in the public JSON by design (the site
  decides at request time).

## Redirects (#248)

`checkRedirectDestination` is the one validator: no credentials, https only
(plain http only for a path), no address on the site's own hosts (the form
offers the path), no system paths (`/api`, `/login`, `/logout`, `/profile`,
`/resources`, `/cdn-cgi`). Existing redirects are checked on load, listed under
"needs attention" and keep working until edited. A redirect to an unpublished
page is served as a 302 to the home page until the page is published again
(`redirectsWithUnpublishedFallback`, applied where the public payload is built;
every publish and unpublish purges that payload). Unpublishing a page that
redirects point to is refused with `409 redirects_point_here` and the count
until the operator confirms; the list and editor warn first.

## Legal pages, banner and consent (#89, #260)

- Templates live in `packages/common/src/legal/` (privacy, terms, cookies,
  accessibility; English, Arabic, Spanish, French, German, Chinese). A key test
  keeps every language equal to English. They are a starting point, not legal
  advice: the editor says so, and counsel should review them before launch (US,
  EU/UK and KSA PDPL wording differ by region).
- Website, Legal pages: business details (stored in
  `Organization.legalContact`), generate, edit, regenerate and publish. A
  generated page is an ordinary page with `legalKind`; its text is Content
  blocks holding every site language. **Regenerate never overwrites an edit
  without a diff and a confirm** (`legalGeneratedHash`).
- The terms say that reservation deposits and cancellation rules are shown at
  booking and form part of it, plus optional operator text. Reservation policies
  live in the regional database (never read by the control plane), so the
  operator can paste their own wording. Refunds say "contact the restaurant"
  unless the operator wrote their own.
- The accessibility statement needs an email and a phone number and names both;
  embeds and a PDF menu are mentioned automatically.
- Footer, checkout, booking, apply and sign-in link the **published** pages
  (`LegalLinks`). The accessibility link appears only when published.
- Cookie banner: modes Required / Notice only / Off (Off refused while a tag is
  set), default by region (`legalRegionFor`). Choice kept 6 months in
  `localStorage`, asked again when the tag set changes, and a browser sending
  Global Privacy Control is treated as Reject. In Required mode no vendor script
  is rendered or loaded before Accept. Vendors get Google Consent Mode v2,
  TikTok `holdConsent`/`grantConsent` and `fbq('consent', ...)`. The banner is
  an in-flow, labelled, non-modal region at the top (never fixed, so it cannot
  cover the cart tray or the checkout bar); "Cookie settings" in the footer
  reopens it. Flag `website.consent_banner` (default on, only a literal `false`
  switches it off).

## Menuza agreements (#194, #89)

`LegalAgreement(key, version, title, url, summary, scope, requiredBy)` and the
append-only `LegalAcceptance` (triggers refuse update and delete, except the
cascade of a deleted organization). Terms, Privacy and Data processing apply to
every owner; Payment terms and Text marketing terms are asked when payouts or
texts are turned on (the shop settings, text campaigns and text programs call
`requireModuleAgreement`). Owners are the built-in admin role. Sign-up records
the Terms and Privacy versions for the person; a new organization inherits them.
Existing organizations are backfilled as "accepted at sign-up, version 1" for
Terms and Privacy. A version with `requiredBy` blocks the dashboard for owners
after that date (UI gate, not a data gate); before it the dialog can be
postponed. Impersonating staff can never accept and are never blocked. Settings,
Legal lists acceptances; Admin, Legal agreements publishes versions and lists
the organizations that have not accepted one. IP addresses are stored only as an
HMAC.

## Deploy order

App first (migration `0064`, new routes, the new public payload fields), then
Sites (reads the new fields; every field is optional, so an older cached payload
shows no banner and no links), then jobs-cron (the workflow and the two job
routes). Admin with the App. Every new column is nullable or defaulted, the
migration is widen-only, and `website.consent_banner` defaults on.

## Known limits

- The "required by" block is a dashboard gate in the browser, not an
  authorization rule on loaders.
- Marketing pages for payment terms, text marketing terms and the data
  processing agreement need the matching text and anchors before launch (the
  seeded URLs point at `/tos#payments`, `/tos#text-marketing` and
  `/privacy#data-processing`; Admin can publish a new version with other URLs).
