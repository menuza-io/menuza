# Security

The Epic Stack has several security measures in place to protect your users and
yourself. This (incomplete) document, explains some of the security measures
that are in place and how to use them.

## Content Security Policy

The Epic Stack uses a strict
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP).
This means that only resources from trusted sources are allowed to be loaded,
and violations are blocked by the browser.

In the App (`applyContentSecurity` in `apps/app/app/entry.server.tsx`), scripts
run only with the per-request nonce (`'strict-dynamic'`, no `'unsafe-inline'`),
stylesheets load only from the App's own origin, and `object-src`, `base-uri`,
`form-action` and `frame-ancestors` are locked down. `entry.server.test.ts`
checks the script and style directives.

## Private client code

A logged-out visitor can download only the code the public pages need. The App's
client build (`apps/app/vite/private-route-chunks.ts`) splits the output:

- **Public** (`build/client/assets/`): `entry.client`, `root`, the routes in
  `PUBLIC_ROUTE_PATTERNS` (`apps/app/app/utils/route-visibility.ts`: login,
  signup, 2FA and email verification, password reset, OAuth and SSO callbacks,
  onboarding, kiosk, my-schedule, invitations, health and SEO), and every chunk
  they load.
- **Private** (`build/client/assets/app/`): every other route module and the
  chunks only those use.

At the edge:

- `wrangler.jsonc` sends `/assets/app/*` and `/assets/manifest-*` to the Worker
  before static assets (`assets.run_worker_first`). The Worker
  (`serveGatedAsset` in `apps/app/app/utils/private-client-code.server.ts`)
  serves a private chunk only with a valid session (`hasActiveSession`: a signed
  cookie for an unexpired session of a user who is not banned) and marks it
  `Cache-Control: private`. Without one it answers 404, the same as for a file
  that does not exist.
- React Router uses lazy route discovery (`routeDiscovery: { mode: 'lazy' }`): a
  document lists only the routes matched for its URL. Without a session,
  `documentContextFor` also drops private routes that React Router would add for
  ancestor paths (`/` is the dashboard), and `filterRouteDiscovery` answers
  `/__manifest` requests that would name a private route with
  `204 X-Remix-Reload-Document`, so the browser loads the URL as a document and
  the server redirects to the login page.
- The full route manifest file (`assets/manifest-<hash>.js`) is deleted at build
  time and answered 404.
- The Node production server (`apps/app/server/index.ts`, used by CI E2E and the
  Dockerfile) applies the same rules (`private-client-code.express.server.ts`).
  Development servers serve source modules and gate nothing, so check this
  behaviour against a production build.

The build fails if public code imports a private route module, or if a chunk
public pages load is private or names a private file; the error shows the import
chain. To make a route public, add it to `PUBLIC_ROUTE_PATTERNS`; to fix the
error otherwise, move what the public page needs out of the route file.

Production client builds are minified and publish no source maps. With
`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` set, hidden maps are
uploaded to PostHog and deleted from the output.

Every loader and action still checks the session and organization membership
itself: `apps/app/app/utils/route-guards.test.ts` sweeps every route, and
`token-routes.access.test.ts` checks the token-minting routes refuse signed-out
visitors and non-members.

## Cloudflare Workers Network

The Epic Stack uses [Cloudflare Workers](https://workers.cloudflare.com) for
hosting. Cloudflare has a global network that allows you to deploy your app to
multiple regions without exposing them to the public internet. Only services
within your organization have access to this network, and only accounts in your
organization have access as well.

When running multiple instances of the Epic Stack, your instances communicate
with each other over this internal network. Most of this happens behind the
scenes via Cloudflare Workers internal routing.

We also have an endpoint that allows instances to connect to each other to
update the cache in the primary region. This uses internal URLs for that
communication, but as an added layer of security it uses a shared secret to
validate the requests.

> This could be changed if there's a way to determine if a request is coming
> from the internal network. But I haven't found a way to do that yet. PRs
> welcome!

Outside of this, the Epic Stack does not access other first-party services or
databases.

## Outbound requests never follow redirects

A server-to-server or user-influenced `fetch` must not follow a redirect: a safe
URL can redirect to an internal one, and a redirect can carry a bearer token to
another host.

Do not write `fetch(url, { redirect: 'error' })`. Cloudflare Workers does not
implement it: `fetch` throws
`TypeError: Invalid redirect value, must be one of "follow" or "manual"` before
it sends anything. In production this made every organization lookup from the
tenant-api Worker fail and answer `Organization not found`, so every operator
route returned 404.

Use `fetchNoRedirect` from `@repo/security/fetch-no-redirect` instead. It sets
`redirect: 'manual'`, cancels the body and throws `RedirectBlockedError` on a
3xx, so a caller never receives a redirect response. `ssrfSafeFetch` does the
same after its DNS check and throws
`SSRF security validation failed: redirect blocked`. `apps/tenant-api` does not
depend on `@repo/security` and keeps a copy in `src/lib/fetch-no-redirect.ts`;
its test runs the same cases on both.

Code that follows redirects on purpose (the Canva download) uses
`redirect: 'manual'` and validates each hop itself.

## Secrets

The currently recommended policy for managing secrets is to place them in a
`.env` file in the root of the application (which is `.gitignore`d). There is a
`.env.example` which can be used as a template for this file (and if you do not
need to actually connect to real services, this can be used as
`cp .env.example .env`).

These secrets need to also be set on Cloudflare Workers using the
`npx wrangler secret put` command.

There are significant limitations to this approach and will probably be improved
in the future.

## [Cross-Site Scripting (XSS)](https://developer.mozilla.org/en-US/docs/Glossary/Cross-site_scripting)

React has built-in support for XSS protection. It does this by escaping all
values by default. This means that if you want to render HTML, you need to use
the `dangerouslySetInnerHTML` prop. This is a good thing, but it does mean that
you need to be careful when rendering HTML. Never pass anything that is
user-generated to this prop.

## [Cross-Site Request Forgery (CSRF)](https://forms.epicweb.dev/07)

The Epic Stack has built-in support to prevent CSRF attacks. We use the
[`remix-utils`](https://github.com/sergiodxa/remix-utils)
[CSRF-related utilities](https://github.com/sergiodxa/remix-utils#csrf) to do
this.

## [Honeypot](https://forms.epicweb.dev/06)

The Epic Stack has built-in support for honeypot fields. We use the
[`remix-utils`](https://github.com/sergiodxa/remix-utils)
[honeypot-related utilities](https://github.com/sergiodxa/remix-utils#form-honeypot)
to do this.

## Operator login bot protection (Turnstile)

The App's login (password step), signup and forgot-password forms show a
Cloudflare Turnstile challenge when both `TURNSTILE_SITE_KEY` and
`TURNSTILE_SECRET_KEY` are set on the App (`apps/app/.env.schema`). The action
verifies the token with siteverify (`apps/app/app/utils/turnstile.server.ts`)
before it checks credentials, looks up an account or sends email, and checks the
action name (`login`, `signup`, `forgot-password`), the client IP and, when
`TURNSTILE_HOSTNAMES` is set, the hostname. A missing or rejected token is a
form error. With either key empty the check is skipped (local dev, Vitest,
Playwright E2E). The widget's iframe origin `https://challenges.cloudflare.com`
is added to `frame-src` (and `script-src` as a fallback) only while Turnstile is
on. The mobile JSON API (`/api/auth/login`, `/api/auth/signup`) cannot show a
widget and relies on rate limits.

## Rate Limiting

On Cloudflare Workers, `apps/app/workers/app.ts` limits credential routes
(`credentialRateLimitFor` in `apps/app/app/utils/credential-routes.ts`: login,
signup, verify, password reset and the mobile auth API) to 10 POSTs per minute
per client IP, and token refresh to 60. Forgot-password, SSO, MCP OAuth and the
translate API have their own database-backed limits. For volumetric attacks, add
Cloudflare WAF rate-limiting rules on `/login`, `/signup` and `/api/auth/*`.

The Node server also uses a rate limiter. This is configured in the
`server/index.ts` file and can be changed as needed. By default it uses
[`express-rate-limit`](https://npm.im/express-rate-limit) with the in-memory
store. There are trade-offs with this simpler approach, but it should be
relatively simple to externalize the store into Redis as that's a built-in
feature to express-rate-limit.

## Tenant customer PII (Sites)

Customer phone OTP on tenant sites is **not** the same as App operator sessions.
Customer PII stays on the regional tenant-api. Sites must not proxy it. Customer
JWTs live in `localStorage` (XSS-readable on the tenant origin) so US Sites
never sees those tokens as cookies.

Do not add a Sites `/api/auth` BFF or Sites-hosted HttpOnly cookies for
customers. See [tenant data residency](./tenant-data-residency.md).

## Tenant public website forms

Published form blocks on tenant sites submit directly from the browser to the
regional tenant-api (`POST /forms/:formId/submissions`). Customer responses are
stored in per-org regional SQLite, not the US control-plane database.

Defense layers:

1. **Honeypot** — A hidden `website` field in `FormBlock` silently accepts bot
   submissions with `201` without storing data.
2. **Cloudflare Turnstile** — When `PUBLIC_TURNSTILE_SITE_KEY` is set on Sites
   and `TURNSTILE_SECRET_KEY` on tenant-api, submissions must include a valid
   `turnstileToken` verified server-side via
   `https://challenges.cloudflare.com/turnstile/v0/siteverify` with action
   `website-form` and hostnames listed in `TURNSTILE_HOSTNAMES`. Verification is
   skipped when the secret is unset (local development).
3. **Rate limiting** — `public-form-submissions` allows 30 submissions per IP
   per hour on tenant-api.
4. **Origin resolution** — Submissions must resolve to an active organization
   via browser `Origin` plus `slug` or custom `host`.
5. **Published-only** — Draft forms are not exposed on public sites.
6. **Server validation** — Required fields, length limits, email format, and
   localized choice matching are enforced before insert.
7. **Retention** — `jobs-cron` purges submissions older than the org retention
   window via `DELETE /api/forms/purge-submissions`.

Sites CSP allows Turnstile from `https://challenges.cloudflare.com` in
`script-src` and `frame-src`. Do not proxy form POSTs through Sites SSR; that
would transit regional customer PII through the US worker.
