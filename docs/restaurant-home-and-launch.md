# Restaurant home and launch checklist

The organization home (`/<orgSlug>`) for restaurants: the **Today** block (#81),
the **Needs attention** feed (#82) and the per-location **launch checklist**
(#83, `/<orgSlug>/launch`, Admin's Launch card).

## Default home

`defaultRestaurantHomeConfig()` (`apps/app/app/utils/dashboards/config.ts`) is
used while a member has no saved Home row: Today, Needs attention, onboarding
(the launch checklist when `launch.checklist` is on) and, only when the viewer
can read reservations, Bookings today. A saved Home is never replaced; its notes
blocks (and the notes KPI row, shown only when it has a `stats` block) stay.
Reset goes back to the restaurant default.

The location picker on Today, Needs attention and the checklist is one shared
choice, remembered in `localStorage` per user and organization
(`homeLocationStorageKey`). First visit: All locations. Location-scoped members
only ever see their locations.

## Today (#81)

- Data: `GET /analytics/today?locationIds=&timeZones=` on the regional
  tenant-api, called by the browser with the reports token
  (`/<orgSlug>/reports/token`, order subjects). Totals only: sales and orders
  per currency for today, yesterday to this time and the same weekday last week,
  and distinct guests split first-time and returning.
- Each location counts its own business day in `OrganizationLocation.timezone`.
  Amounts in different currencies are never added (one tile per currency).
- The sales rule is the reports' `countedOrderCondition` (same as `sales-total`
  / `orders-total`); guests use the reports' customer identity (account, else
  phone). Station sales are not included until #84.
- Why a route instead of three report runs: the orders report can filter by the
  stored location name only (not the id) and runs in one zone per run.
- Tiles follow grants: the order tiles need report access plus menu read (the
  grant behind the order subjects of the reports token); covers need
  Reservations on and `read:reservation:any`. A missing grant hides the tile.

## Needs attention (#82)

- Control-plane detectors: `ATTENTION_DETECTORS` in
  `apps/app/app/utils/dashboards/attention.server.ts`, each with a module flag
  (or none) and the permission to act on it. Regional counts are fetched by the
  browser: payment review (`GET /operator/orders/attention`, orders token), call
  follow-ups (`/operator/calls`, calls token) and stock counts waiting
  (`/operator/inventory/counts`, inventory token). A failing detector is skipped
  and logged by kind and organization id.
- Urgent kinds (payments not connected, payment review, ordering paused over 2
  hours, no menu on sale) cannot be dismissed; the server refuses
  (`not_dismissible`). Advice is dismissed per user for 7 days
  (`HomeAttentionDismissal`, key `kind:locationId` or `kind:org`).
- Sold-out dishes: "Mark available" (`restore-dishes` home intent) needs
  `update:menu:any`, uses the same writer as Station's manual sold out, and
  never gives back a dish inventory holds off: the App asks the region
  (`POST /internal/home/stock-sold-out`) and refuses everything when it cannot
  answer. Those dishes go back only through the inventory undo.
- No item carries a guest's name, phone, email or message text.

## Launch checklist (#83)

- Flag `launch.checklist` (system default off; new organizations get it on at
  creation). Without it the template onboarding steps are unchanged.
- Steps (`LAUNCH_STEPS`, seeded as `OnboardingStep` rows `launch_*` by
  migration 0047) are evaluated on read per location. Organization-wide steps
  (logo and theme, payments, test order, custom domain) show the same state on
  every location. Optional: Station terminal, test order (until #119), custom
  domain. Skip: `POST /api/onboarding/skip-step`, optional steps only
  (`step_not_skippable`), `update:settings:any`.
- `menuReady`: a category with 5 or more priced dishes and
  `menuHealthMeetsGrade(health, 'D')` (score 60 or more).
- Live: every required step done, site published, ordering on (not paused, a
  channel on), location active, a sellable dish, and payments connected or "pay
  at pickup only" chosen (`ordering.pay_at_pickup_only`). No paid order needed.
  `OrganizationLocation.liveAt` records the first time (set once).
- Progress rows: `OnboardingStepProgress` with `locationId` (shared by every
  member; `userId` is who last changed it), `completedAt`, `skippedAt`,
  `skipReason`.
- Regional facts come from `POST /internal/home/launch-facts` (internal command
  token): paired terminal location ids and the first counted order time. Nothing
  else.
- "Tell your guests" opens `marketing/campaigns/new?template=launch` as a draft;
  nothing is sent until the operator presses Send, and normal consent rules
  apply. Offered once on Home, always on the launch page.
- Admin: the organization detail shows a Launch card from
  `POST /resources/launch-status` on the App (internal token, same evaluator,
  state and dates only). The organizations list filters "Stuck in setup for more
  than 14 days" (on the checklist, signed up more than 14 days ago, no location
  ever live).

## Deploy order

tenant-api (`/analytics/today`, `/operator/orders/attention`,
`/internal/home/*`), then App (migration 0047, seeds, UI), then Admin.
