# Website SEO

Search features of the restaurant website, added in one change for #182, #137,
#88, #184 and #138. Everything here is public business data or aggregate search
data: no guest data is stored or sent.

Sites already had the SEO stack these build on: `sitemap.xml`, `robots.txt` and
`llms.txt` (`apps/sites/src/lib/seo-files.ts`, `seo-data.ts`) and the schema.org
Restaurant builder (`restaurant-jsonld.ts`). Every new page goes through them;
there is no second sitemap, robots file, `llms.txt` or JSON-LD system.

## Cuisine and price range (#182, part 1)

- Settings, Organization, **Cuisine and price range**: up to three cuisines from
  the fixed list in `packages/common/src/cuisines.ts` (English and Arabic
  labels, schema.org text; no free text and no "Other") and a price range from
  `$` to `$$$$`, shown in the local currency symbol. Each location can override
  both on its settings page (Website card).
- Stored on `Organization.cuisines` / `priceRange` and
  `OrganizationLocation.cuisines` / `priceRange` (migration `0062`).
- The public site payload carries them; the home page Restaurant JSON-LD adds
  `servesCuisine` and `priceRange` (per branch when a location overrides), and
  `llms.txt` adds `Cuisine:` and `Price range:` lines. Empty leaves them out
  everywhere.

## Keywords and local rank checks (#182, part 2)

- Flag `seo.rank_tracking` (default off). Website, SEO, Keywords: up to ten
  keywords per location (2 to 80 characters, lower-cased, `keyword_exists` for
  duplicates), exactly one primary, each optionally linked to the page that
  should rank (home, a location page, a dish page or a website page; the page
  editor shows "This page targets: …", nothing else changes). Suggestions come
  from cuisine, popular dishes and city, in Arabic too when the site speaks it.
- `POST /resources/jobs/seo-rank-check` (daily, `0 3 * * *`) checks each keyword
  that is due (never checked, or a week since its last check), so a new keyword
  gets its baseline the next day. A check asks the provider for the location's
  position in Google map results at each point of a 5 by 5 grid, 1 km apart, and
  stores the grid and its average in `SeoRankCheck`. A point where the location
  is not in the top 20 is "not found" (never 0) and counts as 21 in the average.
- Budget: 50 checks per organization per month (`SeoUsage`), overridable per
  organization with the numeric flag `seo.rank_budget`. A check over the budget
  is recorded as `skipped` / `budget_exhausted` and shown on the screen. A
  location without coordinates is skipped as `location_missing_coordinates`.
- Provider: DataForSEO's Google Maps SERP API when `SEO_RANK_API_LOGIN` and
  `SEO_RANK_API_PASSWORD` are set; a deterministic mock on a local deployment;
  otherwise checks are skipped as `provider_not_configured`. Tests replace it
  with `setRankProvider`.
- A removed keyword is soft-deleted and purged with its history after 90 days.

## Generated pages (#137)

- **Location pages** (`website.location_pages`, on by default): `/locations`
  lists active locations (with one location it redirects to that page) and
  `/locations/<slug>` shows hours (today marked, special hours applied),
  address, directions, phone, Order and Book buttons, popular dishes and the
  operator's introduction, with its own Restaurant JSON-LD
  (`buildLocationRestaurantJsonLd`). A deactivated location, or one whose page
  is switched off, answers **410** and leaves the sitemap. A location slug
  change adds a 301 from the old page. Edited on the location's settings page
  (Website page card: switch, intro per language, title, description; a sensible
  title is generated otherwise).
- **Dish pages** (`website.dish_pages`, default off): "Give this dish its own
  page" on the dish editor publishes `/menu/<slug>` with MenuItem JSON-LD while
  the dish is visible online at some location. Hidden or switched off: 404.
  `checkout` and `success` are never dish slugs.
- **Area pages** (`website.area_pages`, default off): `/delivery/<slug>` for
  each named, enabled, allowed delivery zone, at most 50. Without the operator's
  introduction a page is noindex and stays out of the sitemap. Website, Area
  pages switches single areas off and edits slug and intro.
- An operator page at the same path wins (`/locations`, `/events`).
- Data: `GET /resources/sites/landing` (public, rate limited, cached with the
  site cache).

## Automatic redirects (#88)

- Renaming a page that was ever published (`status` published, or a
  `publishedData` snapshot) adds a 301 from the old path, stored once on the
  unprefixed path, in the same `db.batch` as the rename. The toast offers **Undo
  redirect**; the Redirects list badges it **Added automatically**
  (`WebsiteRedirect.source`).
- Renaming back removes the redirect that would hide the page and adds the
  reverse one. Redirects that pointed at the old path are updated to the new
  one, so there is never more than one hop. A redirect the operator made from
  the old path is kept and nothing is added. Loops are refused.
- Deleting a published page asks where its visitors go (home by default, or
  another published page) and adds that redirect.
- Shared helpers: `apps/app/app/utils/website/redirect-plan.ts` (pure) and
  `redirects.server.ts` (moved out of `redirects.tsx`).

## Events (#184)

- Flag `website.events` (default off). Website, Events: title and description
  per site language, location, photo, link (internal path or https URL), an
  optional bookable experience (its Book button shows only while online booking
  and experiences are on), start and end (at most 24 hours,
  `invalid_event_time`), and a repeat rule: weekly on chosen days, monthly on
  the same date or the same weekday ("second Friday"), or chosen dates. Single
  dates can be skipped or moved.
- Times are wall-clock in the location's time zone and expanded with
  `@repo/zoned-time` (`packages/common/src/site-events.ts`), so 20:00 stays
  20:00 across daylight-saving changes. An endless series shows its next 12
  dates.
- Sites: `/events`, `/events/<slug>` (Event JSON-LD, Add to calendar `.ics`,
  share), and the **Upcoming events** section (next 3 or 6) for any page.
  Finished events leave the list and the sitemap at once; the page says it
  ended, and answers 410 thirty days after the last date. Unpublishing removes
  it at once.

## Verification, IndexNow and Search Console (#138)

- Website, SEO: Google and Bing verification codes (the code or the pasted meta
  tag; validated by format) are rendered as meta tags on the home page.
- IndexNow: every organization gets a key, served by Sites at `/<key>.txt`.
  Publishing a page sends one request listing every language version of the page
  if it is indexable (published, not noindex), each URL at most once an hour
  (`IndexNowPing`), after the response so publishing is never slowed.
- Search Console (`seo.search_console`, default off): **Connect Search Console**
  signs in with Google (the `google-search-console` provider in
  `@repo/integrations`, using the same Google OAuth client as Google Business
  Profile, `GBP_CLIENT_ID` / `GBP_CLIENT_SECRET`, with the Search Console and
  Site Verification APIs enabled). Menuza then gets a META token, puts it on the
  home page, adds the primary origin as a property, verifies it and submits
  `/sitemap.xml`, without manual steps (the SEO screen starts it and the daily
  job retries). A new primary host gets a new property and the sitemap again.
  `gsc_not_owner` explains how to get owner rights.
- `POST /resources/jobs/search-console-sync` (daily) stores 28 days of clicks,
  impressions and position (`SearchConsoleDaily`) and the top queries and pages
  (`SearchConsoleTop`); the SEO screen shows them with the two-day lag labelled,
  and warns about sitemap errors, warnings and pages not indexed. Disconnecting
  removes the stored tokens; the property stays in the operator's Google
  account.
- Without Google credentials outside production the sign-in and the API calls
  use a mock. Tests use `setSearchConsoleClientFactory` and `setIndexNowSender`.

## Deploy order

App first (migration `0062`, new routes, payload fields), then Sites (reads the
new fields, all optional), then jobs-cron (the two daily routes). Every new
field is optional and every new flag defaults off except
`website.location_pages`.
