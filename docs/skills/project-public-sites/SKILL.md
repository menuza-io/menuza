---
name: project-public-sites
description:
  Guide Astro tenant-site rendering, host and locale resolution, public content
  caching, CSP, forms, shop, and media boundaries in this project.
---

# Project public sites

## When to use this skill

Use this skill when changing `apps/sites`, public tenant pages, custom-domain or
slug routing, locales, public forms, shop pages, customer auth UI, media
delivery, SEO, security headers, or published-content caching.

## Request lifecycle

`apps/sites` is an Astro app, not a React Router app. Its middleware in
`src/middleware.ts`:

1. Resolves the request Host into a tenant slug or published custom domain.
2. Loads the published organization/public payload from App.
3. Negotiates the enabled locale/default locale and rewrites or redirects the
   locale path.
4. Resolves published redirects.
5. Exposes safe org/API data through `Astro.locals` and renders the page.
6. Applies CSP, `Vary: Host, Accept-Encoding`, and deliberate cache headers.

Preserve host isolation, locale behavior, and published-only checks. A page must
never render draft CMS content or use a client-supplied organization ID to
choose private data.

## Data boundary

Sites SSR may fetch public organization metadata, published pages, public forms,
public shop configuration, and public media URLs. It must not proxy customer
phone/name/email, customer auth, tenant profile, or KSA form/customer payloads
through the US App/Sites server.

Customer login/profile/form submission browser calls go directly to the regional
tenant-api. The layout injects the regional API URL and org binding; do not add
`src/pages/api/auth/` or turn a media/shop proxy into an auth BFF.

## Caching and headers

Published HTML may use the configured edge cache only when the request is safe
to cache. Cache keys must include host, path, query/locale variants, and any
other public representation input. Never cache `/api/*`, customer auth, profile,
form submission, or payment responses; these routes use no-store semantics.

When adding a third-party script/frame/connect target, update the narrow CSP
builder in middleware and add/adjust tests. Turnstile and inline/hosted shop
checkout have explicit CSP branches; do not use a global unsafe wildcard. Keep
HSTS production-only behavior and do not remove Host from `Vary`.

## Public forms, shop, and media

- Public form reads use the published form projection/cache; submissions go to
  regional tenant-api and carry Origin/org binding, honeypot, optional
  Turnstile, and validated fields.
- Shop session/payment-intent routes may call App/processor resources, but
  responses are no-store and paid state is confirmed server-side. Do not trust a
  browser return URL or payment ID alone.
- Use the existing `media.ts`/resource URL contracts for images, fonts, and
  video. Do not expose arbitrary storage URLs or object keys.

## Content and SEO

Render sanitized rich content through the site sanitization helper. Preserve
canonical URLs, locale-aware links, sitemap/robots behavior, redirect safety,
alt text, and organization-provided metadata. External redirects must be
explicitly allowed; reject scheme-relative and malformed destinations.

## References

- [Tenant data skill](../project-tenant-data/SKILL.md)
- [Routing skill](../project-routing/SKILL.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [SEO docs](../../seo.md)
- [Redirects](../../redirects.md)
- [Sites middleware](../../../apps/sites/src/middleware.ts)
