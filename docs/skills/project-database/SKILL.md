---
name: project-database
description:
  Guide Drizzle schema design, SQLite/D1 migrations, tenant databases, queries,
  and data residency in this project.
---

# Project database

## When to use this skill

Use this skill when changing schemas, writing Drizzle queries, generating or
applying migrations, adding indexes, seeding data, or working with control-plane
and regional tenant databases.

## Database boundaries

This project has two data planes and they must not be merged:

- `@repo/database` is the US control-plane Drizzle database. It stores
  operators, organizations, CMS/configuration, billing, permissions, and
  operational metadata.
- `@repo/tenant-db` is the per-organization regional SQLite database used by
  `apps/tenant-api`. It stores customer phone/name/email, OTP/refresh hashes,
  form submissions, journeys, and other tenant customer data.

The Worker US path uses one Durable Object (`TenantOrg`) per organization with
the tenant schema/migrations and an isolated `ctx.storage`-backed Drizzle
database. The Node path uses `tenant_{orgId}.db` under `TENANT_DB_DIR`. Keep
both migration paths compatible.

Customer PII must not be added to control-plane `User` or `Organization`, App
sessions, Admin, Sites SSR, or a cross-region cache. Read
[tenant data residency](../../tenant-data-residency.md) and
[project-tenant-data](../project-tenant-data/SKILL.md) before touching tenant
tables or organization region behavior.

## Drizzle conventions

Import the shared database client and table definitions rather than creating a
second connection:

```typescript
import { and, db, desc, eq, Note } from '@repo/database'

const notes = await db
	.select({ id: Note.id, title: Note.title, updatedAt: Note.updatedAt })
	.from(Note)
	.where(eq(Note.ownerId, userId))
	.orderBy(desc(Note.updatedAt))
	.limit(20)
```

- Select only the columns a caller needs; never accidentally return password,
  token, encryption-key, or audit-integrity material.
- Index foreign keys and proven `where`/`orderBy` combinations. Avoid indexes
  added without a query need.
- Use the project’s CUID-based IDs, standard `createdAt`/`updatedAt` fields, and
  explicit nullable/ownership relationships.
- Use transactions for multi-write invariants and return the result of each
  required insert/update; do not leave partial authorization or membership
  state.
- Drizzle table exports are often PascalCase (`User`, `Organization`, `Note`) in
  the control plane and lower/camel-case schema exports in tenant-db; follow the
  owning package instead of assuming ORM naming from another project.
- Validate input before constructing queries. Prefer typed Drizzle expressions
  over string-built SQL; use parameterized SQL when raw SQL is required.

## Migrations

Control-plane migration workflow:

```sh
cd packages/database
npx drizzle-kit generate --name describe_the_change
npx tsx src/migrate.ts
```

Tenant migration workflow:

```sh
cd packages/tenant-db
npx drizzle-kit generate --name describe_the_change
```

Tenant migrations are applied lazily when a tenant connection opens, and
provisioning forces a complete migration run. Use additive/widen-then-narrow
changes for deployed databases: add nullable columns or compatible structures,
backfill safely, deploy readers/writers, then tighten constraints in a later
migration. Do not edit an already-applied migration.

Local control-plane commands include `npm run db:migrate:deploy`,
`npm run db:seed`, and `npm run db:studio`. Production D1 migrations are applied
by the deployment workflow; follow `docs/deployment.md` and the app’s Wrangler
config rather than inventing a second production path.

After a control-plane schema change, inspect generated SQL and snapshots, update
seed/setup roles when permissions are involved, and verify both App and Admin
consumers because they share the D1 database. After a tenant schema change,
exercise Node and Worker tenant connection/migration tests.

## Tenant database safety

On the Node path, `tenant_{orgId}.db` is selected from a validated organization
and matching `DATA_REGION`, and lives under `TENANT_DB_DIR`. On the Worker path,
the equivalent tenant database is isolated in the organization's `TenantOrg`
Durable Object `ctx.storage`. Provisioning and deprovisioning must preserve
those storage boundaries and carry organization metadata, not customer rows.
Changing `Organization.dataRegion` after provisioning is an explicit destructive
wipe and does not migrate PII; preserve the confirmation and ordering described
in the residency guide.

## References

- [Database docs](../../database.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [Database ADR](../../decisions/003-sqlite.md)
- [Tenant DB package](../../../packages/tenant-db/README.md)
