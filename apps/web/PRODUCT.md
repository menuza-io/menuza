# Product

<!-- impeccable:product-schema 1 -->

Shared template-level context lives in the repository-root `PRODUCT.md`; this
file holds marketing-site truth.

## Platform

web

## Users

Prospective customers: visitors evaluating the product through the landing page,
blog, and legal or support pages. Marketing content editors author everything
through an embedded headless CMS admin on the same origin. There are no
end-customer accounts here; the site's actions route visitors to the operator
app to sign up.

## Product Purpose

The deployed product's public marketing site. Every page is CMS-driven: home,
blog, and arbitrary pages are composed from a library of marketing block
components over CMS content, with SEO (canonical, hreflang, Open Graph,
JSON-LD), an RSS feed, and consent-gated analytics.

## Positioning

Editors work in place: the CMS admin is embedded on the same origin (patched at
build time with custom fields), and pages render typed CMS blocks, so content
changes never touch code. Analytics loads only after cookie consent.

## Operating Context

- Astro SSR on Cloudflare Workers (D1 for CMS data, R2 for media); port 3002
  behind the local HTTPS proxy (`npm run dev:web`).
- Header and footer navigation are CMS-managed (primary menu, footer menu
  columns, banner); theme and consent cookies are shared across the apex domain
  with the operator app.

## Capabilities and Constraints

- Block library (component names as shipped): hero variants, FeatureGrid,
  FeatureList, Pricing, Testimonials, FAQ, CallToAction, Stats, Team, Logos,
  ShowcaseCards, StickyCards, Tabs, ScrollHighlight, FounderNote, Beliefs, Blog,
  BuildFor, CapabilityGrid, Integration, FormBlock.
- Pages: home, blog with pagination and RSS, arbitrary CMS pages, about,
  privacy, terms, support, and 404.
- Constraints: public only, no auth. HTML is private/no-cache (it varies by
  theme and consent cookies) while static assets cache at the edge; security
  headers are set in middleware. Locales: English, Spanish, Arabic with
  right-to-left support.
- Open item: default marketing copy interpolates the brand config and still
  reads as boilerplate in places; treat copy as placeholder, not product truth.
