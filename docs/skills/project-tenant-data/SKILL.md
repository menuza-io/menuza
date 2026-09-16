---
name: project-tenant-data
description:
  Guide regional tenant-api architecture, customer PII boundaries, org
  provisioning, browser auth, and data-residency-safe changes in this project.
---

# Project tenant data

## When to use this skill

Use this skill when changing `apps/sites`, `apps/tenant-api`, tenant customer
auth, tenant forms/shop/journeys, organization publishing, region selection,
tenant migrations, or any code that handles phone, name, email, or customer
tokens.

## Non-negotiable boundary

The platform has a US control plane and a regional customer data plane:

| Boundary                                | Allowed data                                                           | Canonical code                                |
| --------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| App/Admin + `@repo/database`            | operators, org metadata, CMS/configuration, billing, permissions       | `apps/app`, `apps/admin`, `packages/database` |
| Regional tenant-api + `@repo/tenant-db` | customer PII, OTP/refresh hashes, tenant forms, journeys, shop records | `apps/tenant-api`, `packages/tenant-db`       |
| Sites SSR                               | public published org/content payloads                                  | `apps/sites`                                  |

KSA customer PII must not be stored or transited through App, Admin, US Sites
SSR, a Sites BFF, the control-plane SQLite DB, or a cross-region cache. Do not
add customer fields to control-plane `User`/`Organization` or put customer JWTs
in Sites cookies.

## Runtime topology

- Local US tenant-api: `http://localhost:3007`, `DATA_REGION=us`.
- Local KSA tenant-api: `http://localhost:3009`, `DATA_REGION=ksa`.
- Sites runs on `:3008` and injects the regional API URL chosen from the org’s
  `dataRegion`.
- Production US uses the Cloudflare Worker/Durable Object path (or configured
  OCI US deployment); KSA uses OCI Riyadh with a block volume. One org maps to
  one tenant SQLite database.

`apps/tenant-api/src/app.ts` is the shared Hono app for Node and Worker
runtimes. Routes are grouped as `/auth`, `/forms`, `/shop`, `/analytics`,
`/operator`, `/api`, and `/api/marketing`/`/api/journeys`. The Worker-specific
Durable Object routing lives under `apps/tenant-api/workers/`.

## Organization binding and request flow

Browser auth and public forms resolve the organization from the request `Origin`
plus slug/custom host. The node then requires that the organization is
published, provisioned, and its `dataRegion` matches the node’s `DATA_REGION`.
Do not trust a client-selected `orgId` for these flows.

Customer login is browser-to-regional-API:

1. Sites inject `data-tenant-api-url`, `data-org-slug`, and custom-host data in
   `SiteLayout.astro`.
2. `apps/sites/src/lib/client-auth.ts` calls `/auth/send-code`, `/auth/verify`,
   `/auth/refresh`, `/auth/me`, `/auth/profile`, and `/auth/logout`.
3. Tenant-api writes the org’s SQLite file and returns a 15-minute access JWT
   plus a rotating 30-day refresh token.
4. Browser tokens stay in `localStorage` on the tenant origin. They are never
   read by Sites SSR or sent to App on navigation.

Native clients have no browser Origin. The iOS/Android tenant builds send the
published site origin for HTTPS builds; local HTTP development may use the
documented slug/host binding. Preserve this distinction when changing origin
resolution.

## Provisioning and region changes

Publishing sends only `{ orgId, slug, dataRegion }` to the matching regional
tenant-api with `INTERNAL_COMMAND_TOKEN`. Provisioning creates the per-org DB
and runs tenant migrations. App never sends customer rows.

Changing `Organization.dataRegion` after a DB exists is intentionally
destructive: require explicit confirmation, deprovision the old node while its
old region flag still matches, update the control plane, then provision an empty
DB in the new region if published. Existing customers must sign in again. Do not
add automatic PII migration, a shared volume, a global tenant hostname, or a
region fallback that can send KSA traffic to US.

## Tenant operator routes

App operators use short-lived operator JWTs to call tenant-api `/operator/*`
routes for tenant-owned admin data. The operator token is not a customer token;
validate it with the existing `TENANT_OPERATOR_TOKEN` flow and scope all queries
to the requested org. Keep tenant-api’s internal provision token, operator
token, JWT signing secret, and HMAC secret separate.

## References

- [Tenant data residency](../../tenant-data-residency.md)
- [Tenant residency ADR](../../decisions/045-tenant-data-residency.md)
- [Tenant API app](../../../apps/tenant-api/src/app.ts)
- [Browser auth client](../../../apps/sites/src/lib/client-auth.ts)
