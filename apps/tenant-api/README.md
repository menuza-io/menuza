# Tenant API

Regional Hono service for **customer** phone OTP and per-org SQLite. One process
per `DATA_REGION` (`us` or `ksa`). App and Admin never store customer PII here;
they only POST `{ orgId, slug, dataRegion }` to provision or wipe a database.

| Local process                 | Port | Region |
| ----------------------------- | ---- | ------ |
| `npm run dev` (via `dev:all`) | 3007 | `us`   |
| `npm run dev:tenant-api:ksa`  | 3009 | `ksa`  |

Browsers on tenant Sites call this API **directly**. Do not proxy auth through
`apps/sites`.

## Production (dual deploy)

| Region                      | Platform                            | Storage                         | CI job                    |
| --------------------------- | ----------------------------------- | ------------------------------- | ------------------------- |
| **US** (`DATA_REGION=us`)   | Cloudflare Worker + Durable Objects | SQLite per org (`TenantOrg` DO) | `deploy-tenant-api-us-cf` |
| **KSA** (`DATA_REGION=ksa`) | OCI Ampere VM + block volume        | `tenant_{orgId}.db` on disk     | `deploy-tenant-api-oci`   |

Both deploy jobs run on every tenant-api change so neither region is skipped.

### US — Cloudflare (native Worker)

- Entry: `apps/tenant-api/workers/index.ts` routes requests to a `TenantOrg`
  Durable Object per `orgId` (Drizzle `durable-sqlite` + existing schema
  migrations)
- Deploy: `cd apps/tenant-api && npm run deploy:cf` (no Docker)
- Set secrets with `wrangler secret put` (see `wrangler.jsonc` comments)
- Point App/Sites `TENANT_API_URL` at the Worker custom domain

### KSA — OCI

- **KSA:** Riyadh `me-riyadh-1` (tenancy **home region**), Always Free A1
- Mount block volume at `TENANT_DB_DIR=/data/tenants`
- Run `docker-compose.yml` on the VM; CI SSH-deploys when `OCI_TENANT_KSA_HOST`
  is set

Canonical guide:
[docs/tenant-data-residency.md](../../docs/tenant-data-residency.md). Deploy:
[docs/deployment.md](../../docs/deployment.md#regional-tenant-data-plane). ADR:
[docs/decisions/045-tenant-data-residency.md](../../docs/decisions/045-tenant-data-residency.md).

## Reservations routes

| Mount                          | Auth                                       | Purpose                                                                                                      |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `/reservations/*`              | `Origin` (organization), capability tokens | Public booking, manage, waitlist, notify-me, experiences. `X-Client: ios \| android` is native.              |
| `/operator/people/*`           | operator JWT, `scope: people`              | Customers screen: customers and reservation guests as one list, profile, edit, merge, erase (browser-direct) |
| `/operator/reservations/*`     | `rsv+jwt` minted by the App                | Setup, book, waitlist, guests, reports, payments (browser-direct)                                            |
| `/internal/reservations/*`     | `INTERNAL_COMMAND_TOKEN`                   | `context-changed`, `erase-customer` (complete erase), `link-customers`, `summary`, `location-summary`        |
| `/api/reservations/tick`       | `INTERNAL_COMMAND_TOKEN`                   | Regional tick                                                                                                |
| `/api/reservations/payments/*` | `INTERNAL_COMMAND_TOKEN`                   | App to region payment bridge (ids and amounts only)                                                          |
| `/api/voice/actions/:name`     | `VOICE_AGENT_TOKEN`                        | Phone agent actions (`reservations.availability`, `.hold`, `.book`), US only                                 |

Kill switches: `RESERVATIONS_PUBLIC_ENABLED` (503 on public routes),
`RESERVATIONS_SMS_ENABLED`, `RESERVATIONS_EMAIL_ENABLED`; interval
`RESERVATIONS_TICK_INTERVAL_SECONDS`. Other settings: `AUTH_HMAC_SECRET`,
`TENANT_OPERATOR_TOKEN`, `APP_URL`.

Dev email capture: set `DEV_EMAIL_CAPTURE_DIR` (the dev scripts use
`.dev-mail/us` and `.dev-mail/ksa`) and every email the node would only log is
written there as JSON. Demo data:
`npm run seed:reservations -w tenant-api -- <org-slug>`. Re-record the public
API fixtures with `npm run fixtures:reservations -w tenant-api`. Docs:
[reservations guide](../../docs/reservations.md),
[contract](../../docs/reservations-contract.md).
