# Staging hostnames and operator cookies

Date: 2026-09-02

Status: accepted

## Context

Menuza deploys staging from the `dev` branch onto the **same Cloudflare zone**
as production (`yourdomain.com`). Staging URLs were originally nested under
`app.stage.yourdomain.com`, `admin.stage.yourdomain.com`, etc.

Cloudflare **Universal SSL** covers only the apex and **one** subdomain level
(`*.yourdomain.com`). Hostnames like `app.stage.yourdomain.com` require **Total
TLS** or **Advanced Certificate Manager** (paid add-ons) for
`*.stage.yourdomain.com`.

Operator apps (App, Admin) share HttpOnly session cookies across `app.{apex}`
and `admin.{apex}` via `Domain=.{apex}` so SSO-style navigation works without
re-login.

## Decision

### 1. Flat staging hostnames (free Universal SSL)

Use single-label subdomains on the production apex:

| Service         | Production              | Staging                    |
| --------------- | ----------------------- | -------------------------- |
| App             | `app.{apex}`            | `app-staging.{apex}`       |
| Admin           | `admin.{apex}`          | `admin-staging.{apex}`     |
| Web             | `{apex}` / `www.{apex}` | `staging.{apex}`           |
| Tenant API (US) | `tenant-us.{apex}`      | `tenant-us-staging.{apex}` |
| Jobs cron       | `jobs.{apex}`           | `jobs-staging.{apex}`      |
| Sites (demo)    | `demo.{apex}`           | `demo-staging.{apex}`      |

`ROOT_APP_STAGING` is the **same apex** as production (`yourdomain.com`), not
`stage.yourdomain.com`. Staging tenant sites use org hostnames
`{slug}-staging.{apex}` (for example `acme-staging.yourdomain.com`).

URL defaults live in `scripts/staging-hostnames.mjs` and
`launch.config.example.json`.

### 2. Staging operator cookies on `.{apex}` with suffixed names

Flat staging hosts (`app-staging`, `admin-staging`) still set `Domain=.{apex}`
so App and Admin share sessions on staging.

Because production uses the same registrable domain, cookie **names** are
suffixed on staging to avoid overwriting prod sessions in the same browser:

| Cookie        | Production       | Staging                  |
| ------------- | ---------------- | ------------------------ |
| Session       | `en_session`     | `en_session_staging`     |
| Impersonation | `en_imp_session` | `en_imp_session_staging` |
| Theme         | `en_theme`       | `en_theme_staging`       |
| Consent       | `cconsent`       | `cconsent_staging`       |

Logic: `@repo/common/cookie-domain` (`operatorCookieName`,
`isStagingOperatorOrigin`).

Deep health checks remain at `/resources/healthcheck` (App/Admin only). Liveness
probes use `/api/health` on every deployable app.

### 3. Sites staging routes

Production Sites owns the zone wildcard `*.{apex}/*`. Staging cannot attach a
second wildcard on the same zone.

The staging Sites Worker ships with an explicit route for
`demo-staging.{apex}/*` (more specific than the prod wildcard). Additional
staging org sites need a **Custom Domain** (or explicit route) on the staging
Sites Worker for each `{slug}-staging.{apex}` hostname.

`PUBLIC_SITE_HOST_SUFFIXES_STAGING` defaults to `{apex},workers.dev`.

### 4. Marketing Web theme cookie sync

The Astro marketing site (`apps/web`) reads and writes the same operator theme
cookie as App and Admin:

- **Cookie name** — derived from `PUBLIC_APP_URL` via
  `operatorThemeCookieName()` (`en_theme` or `en_theme_staging`).
- **Cookie domain** — `Domain=.{PUBLIC_ROOT_APP}` (same apex as App/Admin).
- **Login / signup links** — `Header.astro` uses `PUBLIC_APP_URL`, patched from
  `PUBLIC_APP_URL` / `PUBLIC_APP_URL_STAGING` at deploy time.

App/Admin theme switchers support `system` | `light` | `dark` (clearing the
cookie for `system`). Web only toggles `light` | `dark`; when the cookie is
missing, Web defaults to `dark` while App/Admin follow the OS preference.

## Consequences

- No paid SSL add-on required for staging subdomains.
- GitHub Variables and `launch.config.json` staging URLs must use the flat
  pattern (`APP_BASE_URL_STAGING=https://app-staging.yourdomain.com`, etc.).
- Operators can use prod and staging in the same browser without session
  collisions.
- Staging tenant sites beyond the demo host require manual Custom Domain setup
  on the staging Sites Worker (documented in launch checklist).
- Infrastructure labels (`app-staging`, `admin-staging`, `staging`, …) are
  reserved in Sites host resolution so they are not treated as org slugs.

## Related

- [Launch checklist](../launch-checklist.md) — GitHub Variables table
- [Deployment checklist](../deployment-checklist.md) — health probe URLs
- [007 - Sessions](./007-sessions.md)
- [005 - Client preference cookies](./005-client-pref-cookies.md)
