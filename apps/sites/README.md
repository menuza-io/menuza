# Organization Sites

Public Astro app that serves published organization websites at
`{orgSlug}.{brand.domain}` (e.g. `acme.epic-startup.com`) and optional customer
custom domains (e.g. `www.acme.com`) via Cloudflare for SaaS.

## Local development

```bash
npm run dev:sites
# or via monorepo
npm run dev
```

Sites runs on port **3008**. Through the HTTPS proxy (`:2999`), the derived
`{brand.slug}.test` domain and its org subdomains and custom domains are routed
here.

Published sites do not require a local KV namespace. Development safely runs
without Cloudflare's edge cache. To open an organization site locally, add its
hostname and restart the dev processes:

```bash
npm run setup:hosts
npm run dev
# https://acme.epic-stack.test:2999 (replace `acme` with the org slug)
```

Opening `localhost:3008` does not identify an organization. Re-run
`npm run setup:hosts` after creating or publishing a new organization because
`/etc/hosts` cannot provide wildcard subdomains.

### Env (varlock)

Config is defined in [`.env.schema`](.env.schema) and loaded via
`@varlock/astro-integration` (same pattern as `apps/web`). Copy values into a
local `.env` (gitignored) as needed. Types are generated to `env.d.ts`.

### Hosts

`/etc/hosts` does not support wildcards. `npm run setup:hosts` adds product app
domains and published org slug subdomains under `{brand.slug}.test`. It never
maps the production brand domain or connected public custom domains to
localhost. Re-run after publishing a site.

### Custom domains (Cloudflare for SaaS)

Production custom domains use
[Cloudflare for SaaS Custom Hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/):

1. Enable Cloudflare for SaaS on your platform zone
2. Set the Sites Worker/Pages deploy as the **fallback origin**
3. Configure on the main app (`apps/app`):
   - `CLOUDFLARE_API_TOKEN` (SSL and Certificates Write)
   - `CLOUDFLARE_ZONE_ID`
   - `CLOUDFLARE_CUSTOM_HOSTNAME_CNAME_TARGET` (e.g. `sites.epic-startup.com`)
4. In Website → General Settings → Connect domain
5. Customer CNAMEs their hostname to the CNAME target; SSL validates via HTTP
   DCV

Without Cloudflare credentials (local), domains are still stored so you can test
host resolution via `/etc/hosts` + the dev proxy.

## Customer auth (do not add a BFF)

Sites SSR serves CMS HTML only. Customer phone OTP is **not** App operator auth
and must not go through a Sites `/api/auth` proxy.

The layout injects `data-tenant-api-url` (US `:3007` or KSA `:3009` from the
org’s `dataRegion`). Page JS in `src/lib/client-auth.ts` calls that API directly
and stores JWTs in `localStorage`. Login asks for **phone only**; name is
collected after OTP if that number is new.

Full rules:
[docs/tenant-data-residency.md](../../docs/tenant-data-residency.md).

## Locale-prefixed internationalization

Published org sites support locale-prefixed URLs (e.g. `/ar/about`), independent
of the App/Admin operator Lingui locales:

- Supported content locales and RTL flags are defined in
  [`packages/common/src/site-locales.ts`](../../packages/common/src/site-locales.ts)
  (`SITE_CONTENT_LOCALES`, `RTL_SITE_LOCALES`)
- `src/middleware.ts` resolves each request's locale from the path prefix
  (falling back to `?lng=`, then the org's default locale) via
  `resolveSiteLocaleRequest`, and 301s or rewrites accordingly. The default
  locale is unprefixed; a request for the default locale's own prefix (e.g.
  `/en/...` when `en` is default) redirects to the unprefixed path
- `src/lib/i18n.ts` (`createSiteI18n`) builds the request-scoped i18n context
  consumed by page/layout components
- Organizations choose their enabled locales and default locale from the website
  editor in `apps/app`; unsupported locale prefixes 404

## Page builder (website editor)

Org website pages are built from typed sections (hero, features, content, cards,
testimonials, FAQ, CTA, header, footer, and more), edited in `apps/app` and
rendered here. There is no separate organization "post" model — only
`WebsitePage` / `WebsitePageSection` (see `packages/database/src/schema.ts`).

- Section/link types and defaults: `apps/app/app/utils/website/block-types.ts`
- Default seeded home page sections: `apps/app/app/utils/website/home-page.ts`
- Shared link model (URL / page / email / phone / file link types) used by both
  the editor and Sites rendering:
  [`packages/common/src/site-link.ts`](../../packages/common/src/site-link.ts)
- Every org gets a protected `home` page (see `HOME_PAGE_SLUG` in
  `apps/app/app/utils/website/home-page.ts`) that cannot be deleted from the
  editor
