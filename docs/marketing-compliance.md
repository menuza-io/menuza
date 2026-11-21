# Marketing compliance and measurement (#75, #159, #247, #393, #152, #115)

One page for six features that share the marketing send path. Each is built on
the system that already existed: one SMS consent writer, one short-link table,
one attribution record on the order, one frequency cap and one marketing
calendar. Guest data stays in the guest's region; the control plane keeps
numbers only.

## SMS opt-out, START, HELP and quiet hours (#75)

- **Inbound.** `POST /webhooks/sms/:provider` on tenant-api
  (`routes/sms-webhook.ts`, `services/sms-inbound-webhook.ts`). The provider
  adapter (`lib/sms-inbound-provider.ts`: `twilio` and `mock`) verifies the
  signature first; a forged or unsigned request is refused with 403 and changes
  nothing. Retries are processed once (`sms_inbound_events`, unique on the
  provider's message id). The body is matched as a whole trimmed keyword
  (`matchSmsKeyword` in `@repo/common/sms-compliance`) and **only the matched
  keyword is stored**, never the text. Rows are purged after 90 days and by
  person erasure.
- **One consent writer.** STOP and START go through `setCustomerSubscription`
  with source `sms_reply`; there is no second writer. STOP sends one
  confirmation text, START re-subscribes, HELP names the restaurant. On Workers
  the webhook fans out to each organization's Durable Object
  (`/api/sms-inbound/apply`, internal token); on Node it runs in process.
- **Every marketing SMS** ends with `Reply STOP to opt out.`
  (`withSmsOptOutFooter`); the composer's segment count includes it
  (`countMarketingSmsSegments`).
- **Quiet hours.** No marketing text outside 09:00-20:00 in the guest's location
  time zone (`smsSendWindow`, `@repo/zoned-time`). A broadcast that would start
  outside the window is held until it opens (the dispatcher re-dates the claim);
  an automation step returns `deferred` and the workflow `sleepUntil`s.
  Transactional texts are never held.
- **Kill switch.** `MARKETING_SMS_ENABLED=false` on a tenant-api node stops
  every marketing text (no flag; #75 is always on).

## Short links (#159)

- Flag `marketing.short_links` (default off). Table `short_links` and per-day
  `short_link_clicks_daily` (tenant-db `0059`). A link is a 7-character code
  that can point only at a path on the restaurant's own site
  (`siteTargetPathSchema`): an external domain cannot be created.
- Sites serves `GET /l/<code>` (`apps/sites/src/pages/l/[code].astro`), never
  cached, and redirects with the `utm_*` values and `mzc` / `mzs` / `mzl`. Bots
  and over-limit visitors are not counted. A count holds **no IP, user agent or
  person id**: a number per link per day.
- Broadcast and automation texts carry the link automatically (own-site links in
  the text are shortened and tagged); print QR codes use the same table, so a
  scan increments the same count.
- App: Marketing, Short links (`marketing+/links.tsx`).

## Text allowance (#247)

- Control plane: `MarketingSmsUsage` (per organization per UTC month) and
  `MarketingSmsSend` (one row per broadcast or automation start), numbers only.
  A plan includes `smsSendsForPlan(plan)` sends a month; Admin can grant extra
  sends (`MARKETING_TEXT_SENDS_GRANTED` audit entry).
- A "send" is one broadcast text, or one start of an automation text step, not a
  segment. Transactional texts are never counted.
- Spending is one conditional UPDATE, so two sends cannot both take the last
  one; cancelling or failing before anything was sent gives it back once. The
  region's start gate asks the App (`/resources/marketing/sms-allowance`) before
  a text starts. The send step shows what is left; a send over the allowance
  cannot start but can be scheduled for next month. Billing shows usage.

## Overlap warning (#393)

Two campaigns to overlapping audiences show a warning in the pre-send checks
(`audience_overlap`). The region computes the counts
(`GET /operator/marketing/audience-overlap`, `services/campaign-overlap.ts`);
the App sees counts, never guests.

## Marketing calendar (#152)

- Flag `marketing.calendar` (default off). Occasions are code
  (`packages/marketing/src/occasions.ts`) per market
  (`Organization.marketingMarket`, overridable in Marketing, Settings).
  Ready-made messages in English and Arabic.
- Hijri dates are computed with `Intl` `islamic-umalqura` and marked
  **expected** (moon sighting can move them by a day).
- The calendar shows the market's occasions with ready-made campaigns four weeks
  ahead. **Use this** prefills a broadcast (`campaigns/new?occasion=`).
  **Auto-schedule** creates a broadcast 14 days ahead, once per year (an
  idempotent claim per occasion and year in `MarketingOccasionChoice`), and
  notifies the operator. **Dismiss** hides one for the year.
- jobs-cron: `OccasionScheduleWorkflow` (hourly sweep; no new cron slot) calls
  `POST /resources/jobs/occasion-schedule`, which asks the region to create the
  broadcast (internal token, conflict check).

## Order attribution and campaign revenue (#115)

- **What an order stores.** `restaurant_orders.attribution` (JSON) and
  `attribution_source` (tenant-db `0059`). The browser or app sends an
  `attribution` object on `POST /orders`: `utmSource`, `utmMedium`,
  `utmCampaign`, `utmContent`, `campaignId` (`mzc`), `stepId` (`mzs`),
  `shortLinkId` (`mzl`) and `touchedAt` (epoch ms). Strict: values at most 100
  characters, control characters removed, an unknown field is a 400. A touch
  older than 7 days is dropped; a short link id the region does not know is
  dropped. **No visitor id, address or user agent** is kept.
- **Sites** keeps the last non-direct touch for 7 days in `localStorage`
  (mirrored in `sessionStorage`, never a cookie) and sends it with the order
  after the attempt key is derived, so a retry replays the first order
  (`apps/sites/src/lib/ordering/attribution.ts`). The customer app places no
  orders (it opens the website), so it sends nothing.
- **Source** is `qr_table` / `qr_poster` (kept as they were), `short_link`,
  `email` / `sms` / `campaign` (a campaign id), the UTM source, `coupon` or
  `direct`.
- **Two views of the same orders.** _Clicked_ counts orders that carry a
  campaign or short link. _Reached_ is Clicked plus orders from guests who were
  sent a message in the 14 days before, each credited once to the guest's latest
  message; it is a union, so it is never below Clicked. Revenue is paid or
  completed online orders **net of refunds** (reversed refunds count again).
- **Where it shows.** Marketing overview (messages sent, unique guests reached,
  orders and revenue, Clicked / Reached switch;
  `GET /operator/marketing/attribution?days=`), the broadcast page, the
  automation Runs page per step (`GET /operator/journeys/:id/attribution`), the
  order ("Came from"), and reports: `Order source` and `Campaign` fields
  (templates "Orders by where guests came from" and "Revenue by campaign").

## Deploy order

tenant-api, then App, then Sites and the customer app, then jobs-cron, then
Admin. The order body is strict, so a region that is older than Sites would
refuse `attribution`; the region first.
