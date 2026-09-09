# Tenant data residency

This is the canonical guide for **customer** data on organization public sites
(Astro `apps/sites`). Read it before adding auth, cookies, APIs, or database
fields that touch phone, name, or email collected on a tenant site.

Related: [ADR 045](./decisions/045-tenant-data-residency.md),
[Authentication](./authentication.md#tenant-sites-phone-authentication),
[Deployment](./deployment.md#regional-tenant-data-plane),
[Database](./database.md), [Secrets](./secrets.md).

## Two different auth systems

Do not mix these up.

| Who                           | Where they sign in         | Storage                      | Tokens                              |
| ----------------------------- | -------------------------- | ---------------------------- | ----------------------------------- |
| **Operators** (org staff)     | App (`apps/app`)           | US SQLite (`User`, sessions) | HttpOnly cookies via `@repo/auth`   |
| **Customers** (site visitors) | Tenant site (`apps/sites`) | Regional per-org SQLite      | JWT + refresh in **`localStorage`** |

Customer PII must never land in the US control-plane database, App session
cookies, Admin, or a Sites server-side auth proxy.

## Why this shape exists

App and Admin run in the US. KSA organizations require that customer PII is
neither **stored** nor **transited** through servers outside Saudi Arabia.

Sites SSR often stays in the US (it only renders CMS HTML). A Sites BFF that
proxies login/profile would pull KSA phone/name/email through US machines. The
browser therefore calls **that org’s regional tenant-api directly**.

## Topology

```
US (control plane)                         Regional data plane (US and/or KSA)
─────────────────                          ──────────────────────────────────
App, Admin                                 Tenant API  (US: CF Containers or OCI;
                                           KSA: OCI VM + block volume)
Control-plane SQLite                       Per-org SQLite  tenant_{orgId}.db
  org flags, CMS, billing                  customers (name, email, phone, hashes)
Sites SSR (CMS HTML only)  ─browser JS──►  In-region tenant-api (auth + PII)
                                           In-region SMS (Twilio is US-only)
```

| App         | Where it runs      | What it may see                                                                          |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------- |
| App / Admin | US only            | Org metadata, site CMS, billing. **Not** customer phone/name/email.                      |
| Sites       | Often US (CMS SSR) | Public org JSON and HTML. Injects the regional API URL. **Must not** proxy customer PII. |
| Tenant API  | **Per region**     | Customer PII and auth. Rejects orgs whose `dataRegion` does not match `DATA_REGION`.     |

Never share one SQLite volume across US and KSA. Each region is an isolated
deployment (Cloudflare Container singleton for US, or OCI VM + block volume).

## What lives where

**US control-plane SQLite (`Organization`)** — flags only, not PII:

- `dataRegion` — `"us"` or `"ksa"` (default `"us"`)
- `hasProvisionedDb` — tenant SQLite exists in the current region
- `sitePublished`, slug, custom domain, CMS content

**Regional tenant SQLite** (`packages/tenant-db`, table `customers`):

- `name`, `email`, `phone`
- OTP hash + expiry (`phoneVerificationCode`, `phoneVerificationExpiresAt`)
- Refresh-token hash + expiry

App never reads or writes that table. Provision/deprovision send `{ orgId }`
only.

## Code map

| Concern                                  | Path                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| Regional API (Hono)                      | `apps/tenant-api/src/index.ts`                                                             |
| Customer auth routes                     | `apps/tenant-api/src/routes/auth.ts`                                                       |
| Provision / wipe                         | `apps/tenant-api/src/routes/provision.ts`                                                  |
| CORS + Origin → org                      | `apps/tenant-api/src/lib/origin.ts`                                                        |
| `DATA_REGION` checks                     | `apps/tenant-api/src/lib/region.ts`                                                        |
| JWT / HMAC / command token               | `apps/tenant-api/src/lib/secrets.ts`                                                       |
| Per-org SQLite + Drizzle                 | `packages/tenant-db/`                                                                      |
| OTP SMS (Twilio blocked for KSA prod)    | `packages/sms/`                                                                            |
| App → regional provision                 | `apps/app/app/utils/sites/tenant-api.server.ts`                                            |
| Publish + region switch UI               | `apps/app/app/routes/_app+/$orgSlug_+/website+/_index.tsx`                                 |
| Region dropdown + wipe dialog            | `apps/app/app/components/settings/cards/organization/site-card.tsx`                        |
| Public org JSON (`dataRegion` for Sites) | `apps/app/app/utils/sites/public-org.server.ts`                                            |
| Sites: pick public API URL               | `apps/sites/src/lib/tenant-api.ts`                                                         |
| Sites: browser session (`localStorage`)  | `apps/sites/src/lib/client-auth.ts`                                                        |
| Sites: inject `data-tenant-api-url`      | `apps/sites/src/layouts/SiteLayout.astro`                                                  |
| Login / verify / profile / complete-name | `apps/sites/src/pages/login.astro`, `verify.astro`, `profile.astro`, `complete-name.astro` |

There is **no** `apps/sites/src/pages/api/auth/` BFF. Do not add one.

## Request flows

### Publish a site

1. Operator publishes on Website settings in App.
2. App POSTs `{ orgId }` to the regional tenant-api (`TENANT_API_URL` or
   `TENANT_API_URL_KSA`) with `Authorization: Bearer INTERNAL_COMMAND_TOKEN`.
3. That node checks `org.dataRegion === DATA_REGION`, then creates
   `tenant_{orgId}.db` and runs Drizzle migrations.
4. App sets `hasProvisionedDb = true`.

### Customer login

1. Sites SSR serves HTML. The layout sets `data-tenant-api-url`,
   `data-org-slug`, and `data-custom-host` from the org’s `dataRegion`.
2. Page JS (`client-auth.ts`) POSTs phone to `{tenantApiUrl}/auth/send-code`,
   then `/auth/verify`. New customers are asked for a name after the OTP;
   returning customers skip that. Org is bound from the request `Origin`, not a
   client-chosen `orgId`.
3. Tenant-api writes the customer row in that region’s SQLite and returns
   access + refresh JWTs.
4. The browser stores tokens in `localStorage` (`tenant_access_token`,
   `tenant_refresh_token`). They are **not** sent to Sites on navigation.

### Change customer data region

Operators can switch `dataRegion` after customers exist. PII is **not**
migrated.

1. If `hasProvisionedDb`, the UI requires an explicit confirm
   (`confirmWipe=true`).
2. App deprovisions the **old** region (the control-plane database still has the
   old `dataRegion`, so the old node accepts the wipe).
3. App updates the control-plane database: new `dataRegion`,
   `hasProvisionedDb = false`.
4. If the site is published, App provisions an empty DB in the new region and
   sets `hasProvisionedDb = true`.
5. Existing visitors must sign in again. Old tokens are useless against the new
   empty database.

## Tenant-api surface

Browser CORS is allowlisted only for origins that resolve to an org in **this**
node’s `DATA_REGION` (slug subdomain or published custom domain).

| Method | Path               | Who      | Notes                                                                                              |
| ------ | ------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/health`          | Anyone   | Returns `{ region }` for the node.                                                                 |
| POST   | `/auth/send-code`  | Browser  | Body: `phone`, optional `slug`/`host`. Same success for new and existing numbers (no enumeration). |
| POST   | `/auth/verify`     | Browser  | Issues JWTs. `needsName: true` when the customer has no name yet.                                  |
| POST   | `/auth/refresh`    | Browser  | Rotates refresh token.                                                                             |
| POST   | `/auth/logout`     | Browser  | Clears refresh hash.                                                                               |
| GET    | `/auth/me`         | Browser  | Bearer access token.                                                                               |
| POST   | `/auth/profile`    | Browser  | Update name/email.                                                                                 |
| POST   | `/api/provision`   | App only | `{ orgId, slug, dataRegion }`. Bearer `INTERNAL_COMMAND_TOKEN`.                                    |
| POST   | `/api/deprovision` | App only | Same payload. Deletes that org’s SQLite on this node.                                              |

Access tokens last 15 minutes. Refresh tokens last 30 days (stored hashed with
`AUTH_HMAC_SECRET`).

## Auth model (do not “fix” this)

Login, verify, profile, and logout run in **page JavaScript** against the
regional tenant-api. Tokens stay in `localStorage` so they are not sent to US
Sites on every page load.

Send-code and verify bind to the request `Origin`, not a client-supplied
`orgId`.

Tokens in `localStorage` are readable by XSS on the tenant origin. That is the
accepted tradeoff for keeping KSA PII off US Sites servers. Do **not**:

- Put customer tokens in cookies on the Sites host
- Add `apps/sites/src/pages/api/auth/*` (or any Sites server proxy of PII)
- Give Sites a `JWT_SECRET` so it can mint or verify customer sessions
- Store customer phone/name/email on control-plane `User` / `Organization`

## Local development

`npm run dev` starts **both** tenant-api nodes:

| Process          | Port | `DATA_REGION`                              | Script                           |
| ---------------- | ---- | ------------------------------------------ | -------------------------------- |
| tenant-api (US)  | 3007 | `us`                                       | `dev:tenant-api` (via `dev:all`) |
| tenant-api (KSA) | 3009 | `ksa`                                      | `dev:tenant-api:ksa`             |
| Sites            | 3008 | injects 3007 or 3009 from org `dataRegion` | `dev:sites`                      |

App defaults:

```
TENANT_API_URL=http://localhost:3007
TENANT_API_URL_KSA=http://localhost:3009
```

New orgs default to `dataRegion=us`. To validate KSA:

1. Restart `npm run dev` so both APIs and env values load.
2. Confirm the KSA node: `curl http://localhost:3009/health` should show
   `"region":"ksa"`.
3. On Website settings, set **Customer data region** to **Saudi Arabia (KSA)**
   (switching after customers exist **deletes** them; they are not migrated).
4. Publish. App provisions against port 3009.
5. On the tenant site, login/profile traffic should hit port 3009 (not 3007, and
   not any Sites `/api/*` path).

If `npm run dev` is already running without the KSA process:

```sh
npm run dev:tenant-api:ksa
```

Then restart App (or the whole `npm run dev`) so `TENANT_API_URL_KSA` is picked
up. SMS is mocked to the console on both nodes in development.

Shared local secrets (not for production) live in `.env.schema`:

- App + tenant-api `INTERNAL_COMMAND_TOKEN`
- Tenant-api `JWT_SECRET` (per node; Sites does not verify customer JWTs)
- Tenant-api `AUTH_HMAC_SECRET` (OTP / refresh hashing; **not** the provision
  token)

Local schema values contain `do-not-use-in-prod` and are rejected at tenant-api
startup in production.

## Production deployment

App and Admin stay on Cloudflare Workers in the US. **Tenant-api** is regional:

| Logical `dataRegion` | Where to run tenant-api                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `us`                 | **Cloudflare Worker + Durable Objects** (default) or optional OCI Ashburn               |
| `ksa`                | OCI Saudi Arabia Central (Riyadh) `me-riyadh-1` (Always Free A1 in the **home** region) |

KSA customer PII must stay on the Riyadh OCI VM with a block volume — never on
Cloudflare Workers or US infrastructure. US tenant-api runs as a native Worker
with one SQLite-backed Durable Object per org, or on OCI if you set
`OCI_TENANT_US_HOST`.

Set home region to Riyadh when you create the tenancy. Always Free resources
cannot be created in Ashburn if Riyadh is home. AWS still has no generally
available Kingdom region; do not use Bahrain or UAE as a KSA stand-in.

OCI uses `linux/arm64`; Cloudflare Containers use `linux/amd64`. SQLite files
live at `TENANT_DB_DIR=/data/tenants` (OCI block volume or container disk). Run
a **single writer** per region. Leave LiteFS unset.

App stays in the US and only sends `{ orgId, slug, dataRegion }` to the matching
regional URL. Set `APP_URL` on each tenant-api so it can resolve org flags
without the control-plane SQLite volume.

GitHub Actions builds both architectures and pushes to GHCR. CI always deploys
US to Cloudflare (`deploy-tenant-api-us-cf`) and KSA to OCI when
`OCI_TENANT_KSA_HOST` is set (`deploy-tenant-api-oci`). Sites still deploy to
Cloudflare Pages.

See [Deployment](./deployment.md#regional-tenant-data-plane) and the
[deployment checklist](./deployment-checklist.md).

### Required secrets (per regional tenant-api)

| Secret                   | Notes                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- |
| `DATA_REGION`            | `us` or `ksa`. Startup fails otherwise.                                       |
| `JWT_SECRET`             | Signs customer access tokens. No default in production. Unique per region.    |
| `AUTH_HMAC_SECRET`       | OTP and refresh hashes. Different from `INTERNAL_COMMAND_TOKEN`.              |
| `INTERNAL_COMMAND_TOKEN` | Same value as US App. ≥16 chars. Empty token is rejected.                     |
| `APP_URL`                | US App origin. Used when this node cannot read control-plane org flags (KSA). |
| `DATABASE_URL`           | Control-plane SQLite for **org flags only** when available. Not customer PII. |
| `TENANT_DB_DIR`          | Volume mount for `tenant_{orgId}.db` (production: `/data/tenants`).           |
| `ROOT_APP`               | Brand domain used to map `{slug}.{ROOT_APP}` origins for CORS.                |

### App (US)

| Variable                 | Notes                                                        |
| ------------------------ | ------------------------------------------------------------ |
| `TENANT_API_URL`         | US tenant-api origin.                                        |
| `TENANT_API_URL_KSA`     | KSA tenant-api origin. Required before publishing a KSA org. |
| `INTERNAL_COMMAND_TOKEN` | Must match every regional tenant-api.                        |

### Sites

| Variable             | Notes                                                                           |
| -------------------- | ------------------------------------------------------------------------------- |
| `TENANT_API_URL`     | US tenant-api URL (injected into pages for browser calls).                      |
| `TENANT_API_URL_KSA` | KSA tenant-api URL. Safe on a US Sites instance — it is a URL, not a PII proxy. |
| `PUBLIC_APP_URL`     | US App, for CMS JSON (not PII).                                                 |

Sites must **not** call tenant-api with customer PII on the server. These URLs
are published into HTML on purpose so the browser can reach the right region.

### SMS

- **US:** Twilio (`TWILIO_*`) on the US tenant-api.
- **KSA:** Twilio is **blocked in production** (`DATA_REGION=ksa`). Plug in an
  in-kingdom provider before going live. Local KSA still mocks SMS.

### DNS

KSA org hostnames may still point at a US Sites app for CMS HTML. Customer auth
always goes to the KSA tenant-api from the browser. A mismatched API host is
safe: tenant-api returns 404/409 when `dataRegion !== DATA_REGION`.

## Troubleshooting

| Symptom                                | Likely cause                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Login hits port 3007 for a KSA org     | Sites missing `TENANT_API_URL_KSA`, or org `dataRegion` still `us`.                                 |
| CORS 403 on login                      | Origin not a published slug/custom domain for an org in that node’s region.                         |
| `region_mismatch` on provision         | App called the wrong regional URL, or control-plane `dataRegion` does not match the node.           |
| Empty customers after a region change  | Expected. Wipe is the product behavior; there is no PII migration.                                  |
| Production tenant-api refuses to start | Placeholder `do-not-use-in-prod` secrets, missing `DATA_REGION`, or short `INTERNAL_COMMAND_TOKEN`. |
| KSA OTP fails in production            | Twilio is blocked; configure in-kingdom SMS.                                                        |

### Website form submission retention and deletion

The regional tenant database remains the source of truth for website forms.
Published form definitions (name, description, field labels/types, and button
copy) are projected into the shared `SITES_DATA_KV` namespace so Sites can
render forms in the initial HTML without a regional request on every page view.
Page blocks store only the form ID. KV is updated when a form is published or
deleted and populated from tenant-api on a cache miss. It never contains form
responses or submitted customer values.

Website form submissions remain in the organization's regional tenant database.
The daily `form-submission-retention` job asks the matching regional tenant-api
to delete submissions older than 365 days; submission values never pass through
the US control plane. For a data-subject deletion request, an authorized
operator can delete one response with
`DELETE /operator/forms/:formId/submissions/:submissionId`. Deleting a form
still cascades to all of its submissions.
