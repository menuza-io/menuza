# Website conversion: forms, alerts, popups, funnel and A/B tests

Issues #239, #357, #142, #132, #179 and #338. Migrations: control plane
`0067_website_conversion`, regional `0056_website_conversion`.

## Forms (#239, #357)

- Form definitions and responses live in the **regional** tenant DB
  (`website_forms`, `website_form_submissions`), not the control plane.
- New field types `address` (street, city, postcode, stored as one line) and
  `location` (the restaurant's active locations; stored as the place name, with
  the id under `<fieldId>:location_id`). A text field can be a number with `min`
  / `max`. The Catering request and Event request templates ship their words in
  every site language.
- `showWhen` shows a field only for chosen answers of a single-choice field
  **above** it. One implementation, `@repo/common/public-form`
  (`visibleFields`), and one validator, `@repo/common/public-form-submission`
  (`validateFormSubmission`), used by Sites and tenant-api: a hidden field is
  never required and its value is dropped. A condition that points below, at a
  non-choice field or at a deleted one is refused on save and cleared (with a
  warning) in the builder.
- Restricted forms (`website_forms.restricted`): responses need
  `read:form_restricted:any` (admins by default, grantable to custom roles). The
  App adds a signed `restrictedForms` claim to the operator token only for
  holders; tenant-api refuses everyone else on list, count, search, read, draft,
  export, delete and unrestrict. Others see the form, a lock and a count.
  Applies to past responses.

## Response alerts and exports (#142)

- A stored response queues one ids-only row in `form_response_outbox` in its own
  transaction (spam-blocked or invalid submissions never queue one). It is sent
  to `POST /resources/forms/notify` (internal token, strict schema: org, event
  id, form id and name, count, who is notified: never a value). The orders tick
  retries failures.
- The App writes one in-app notification per response (idempotent) and at most
  one email per form per member every 10 minutes (`FormAlertDigest`; a count of
  responses that arrived inside the window goes out in the next email, or in the
  15-minute sweep `/resources/jobs/form-alerts`). Members control the channels
  in Settings, Notifications (`form-response-workflow`).
- CSV export is browser-direct from tenant-api: forms
  (`GET /operator/mailbox/forms/:id/export`) and applicants
  (`GET /operator/hiring/applications.csv`). Formula-safe, 10,000-row cap (413
  `export_too_large`), a `form_export_audit` row per export with ids and a
  count.

## Popups (#132)

- `SitePopup` (control plane, flag `website.popups`). Saving or publishing a
  popup with a coupon fails with `coupon_not_valid_online` unless the discount
  is active, applied with a code, usable on `web`, inside its dates, not used up
  and has a code. The public payload (`GET /resources/sites/popups`, CORS-open,
  `no-store`) re-checks it on every request, so an expired coupon stops the
  popup without an edit.
- Sites decides page, dates and frequency per view with
  `@repo/common/site-popup` (`pickPopup`): never on checkout, payment, account
  or booking-management pages, one popup per view. Closes are kept in the
  browser. The button opens `/menu?coupon=CODE`.
- Contact capture: `POST /forms/popup-signup` stores a contact and an explicit,
  never pre-ticked consent in the region only (email is pending until confirmed;
  a customer with a verified phone is never rewritten).
- "Write it for me" uses `@repo/ai` behind an adapter with a fixture; output is
  cleaned and must keep the coupon code.

## Funnel (#179) and A/B tests (#338)

- Flag `website.funnel` (default off) turns on both. The browser sends one count
  per step per session to `POST /forms/site-events` (event, device class, how
  the visit started, test arm). `site_events_daily` holds counts only: no
  visitor id, address or user agent. `SITE_EVENTS_ENABLED=false` stops counting
  on a node (204, Sites never errors).
- Read in Website, Analytics through a `funnel`-scope operator token.
- A test targets one text section of a published page: variant B is the live
  section with some texts changed, shown by a template swap in the browser
  (crawlers and scriptless visitors get the original). Even split, a returning
  visitor keeps their arm (`localStorage`). Result: orders per visit, two-sided
  95% test, "not enough data" under 100 visits per arm. One test per page; it
  ends after 60 days or 50,000 visitors (daily sweep
  `/resources/jobs/website-experiments`). Applying B replaces the live section,
  writes a version and the editor's draft section, and publishes nothing else.
