# SEO

Remix has built-in support for setting up `meta` tags on a per-route basis which
you can read about
[in the Remix Metadata docs](https://remix.run/docs/en/main/route/meta).

The Epic Stack also has built-in support for `/robots.txt` and `/sitemap.xml`
via [resource routes](https://remix.run/docs/en/main/guides/resource-routes)
using [`@nasa-gcn/remix-seo`](https://github.com/nasa-gcn/remix-seo). By
default, all routes are included in the `sitemap.xml` file, but you can
configure which routes are included using the `handle` export in the route. Only
public-facing pages should be included in the `sitemap.xml` file.

Here are two quick examples of how to customize the sitemap on a per-route basis
from the `@nasa-gcn/remix-seo` docs:

```tsx
// routes/blog/_layout.tsx
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { serverOnly$ } from 'vite-env-only/macros'

export const handle: SEOHandle = {
	getSitemapEntries: serverOnly$(async (request) => {
		const blogs = await db.blog.findMany()
		return blogs.map((blog) => {
			return { route: `/blog/${blog.slug}`, priority: 0.7 }
		})
	}),
}
```

Note the use of
[`vite-env-only/macros`](https://github.com/pcattori/vite-env-only). This is
because `handle` is a route export object that goes in both the client as well
as the server, but our sitemap function should only be run on the server. So we
use `vite-env-only/macros` to make sure the function is removed for the client
build. Support for this is pre-configured in the `vite.config.ts` file.

```tsx
// in your routes/url-that-doesnt-need-sitemap
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { type Route } from './+types/sitemap[.]xml.ts'

export async function loader({ request }: Route.LoaderArgs) {
	/**/
}

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}
```

## Tenant sites: Restaurant structured data

The home page of every restaurant website (`apps/sites`,
`src/pages/index.astro`) carries a `<script type="application/ld+json">` block
with schema.org [`Restaurant`](https://schema.org/Restaurant) data, built by the
pure `buildRestaurantJsonLd` in `apps/sites/src/lib/restaurant-jsonld.ts`
(Google's
[local business](https://developers.google.com/search/docs/appearance/structured-data/local-business)
format).

- **Shape.** One location (or none): a single `Restaurant`. Several: a `@graph`
  with the `Organization` (name, url, logo) and one `Restaurant` per location,
  linked both ways with `department` and `parentOrganization`.
- **Fields.** Name, home URL, logo and image (the site icon), telephone,
  `PostalAddress` and `GeoCoordinates` from the location address, and
  `openingHoursSpecification` from the weekly store hours. Days with the same
  hours share an entry; a closed day is `00:00`–`00:00`; overnight hours, which
  the App stores split at midnight (`18:00`–`23:59` plus `00:00`–`02:00` the
  next day), are joined back into one `18:00`–`02:00` span.
- **Actions.** `hasMenu` and an `OrderAction` to `/menu` when a menu is
  published (delivery methods from the location's pickup and delivery options);
  `acceptsReservations` and a `ReserveAction` to `/reserve` when online booking
  is on. Links are in the page's language.
- **Left out.** `servesCuisine` and `priceRange`: we store no cuisine, and a
  price range would be a guess. Any field without data is omitted, never
  invented. Only published, public facts; never customer data.
- **Cost and safety.** The menu and reservations-gate calls start before the
  page is awaited, so they run in parallel with it; the menu call is edge-cached
  and the HTML is cached on top. Preview renders skip it. The JSON is escaped
  with `serializeJsonLd` (`<`, `>`, `&`, U+2028/2029 as `\u` escapes), like the
  careers `JobPosting` data. A JSON-LD block is data, not script, so the
  production CSP needs no hash for it.

Validate a live site with Google's
[Rich Results Test](https://search.google.com/test/rich-results) or the
[Schema Markup Validator](https://validator.schema.org/).
