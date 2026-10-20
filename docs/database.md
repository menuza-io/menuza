# Database

## Control Plane Database (Cloudflare D1)

The Epic Stack uses Cloudflare D1 (a serverless SQLite database) for the control
plane database. D1 automatically handles replication, scaling, and backups
without needing manual intervention like LiteFS. The control plane database is
used for the App and Admin applications and stores operators and configuration
data.

You manage D1 via the `wrangler` CLI.

## Tenant customer SQLite

Customer phone, name, and email are **not** in the control plane database. Each
published org gets a file `tenant_{orgId}.db` on the tenant-api node whose
`DATA_REGION` matches `Organization.dataRegion`. Production files live on an OCI
block volume (`/data/tenants`). When an org switches data regions, the old file
is destroyed and a new one is provisioned. There is no automated cross-region
tenant-DB migration because regional migration must be a destructive,
user-initiated action. See `docs/tenant-data-residency.md`.

## Drizzle Studio

To manage your local development database with a UI:

```sh
npm run db:studio
```

For connecting to your production D1 database, you can use the Cloudflare
Dashboard, or proxy a local studio connection via wrangler.

## Migrations

Migrations are handled by Drizzle. To create a new migration:

```sh
cd packages/database
npx drizzle-kit generate --name your_migration_name
```

To apply it to your local databases, run from the repo root:

```sh
npm run db:migrate:deploy          # LibSQL (packages/database/db/data.db)
npm run db:migrate:d1:local -w app # Workers local D1 used by App dev
```

To deploy migrations to production on Cloudflare D1:

```sh
cd apps/app
npx wrangler d1 migrations apply menuza-db --remote \
  --config wrangler.deploy.jsonc
```

On pushes to `main` and `dev`, GitHub Actions applies pending D1 migrations
before it triggers the App or Admin Worker deployments. The migration job uses
the App config because App and Admin share the same control-plane D1 database;
if migration fails, Worker deployments are not triggered. The CI Cloudflare API
token must have permission to edit that D1 database.

`npm run db:migrate:deploy` is for the local LibSQL development database used by
tests and local development; it does not migrate Cloudflare D1.

### Tenant database migrations

Tenant `tenant_{orgId}.db` files are long-lived, so migrations are **applied
lazily when a connection is opened** (`applyTenantMigrations`), on both the Node
(OCI) filesystem path and the Cloudflare Durable Object path. This matters when
a migration adds a column to an existing table: Drizzle enumerates columns on
`select().from(table)`, so a stale file would fail every query until the org
happened to be re-provisioned.

Generate tenant migrations in `packages/tenant-db`:

```sh
cd packages/tenant-db
npx drizzle-kit generate --name your_migration_name
```

They apply automatically on the next connection; `POST /api/provision` also
forces the full migration run for a specific org.

#### Migration numbering versus upstream

The tenant migrations of this repository (`packages/tenant-db/drizzle`) are
numbered differently from upstream's, because the fork shipped its own
migrations (and applied them to deployed databases) before it synced upstream's.
The files are the same changes, in a different order and with different indexes:

| Change                                 | Upstream                                        | Here                                                                         |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Restaurant orders                      | not upstream                                    | `0011_restaurant_orders`                                                     |
| Voice calls                            | `0011_voice_calls`                              | `0012_voice_calls` (same SQL)                                                |
| Delivery quote columns + customer subs | `0013_customer_subscriptions` (subscriptions)   | `0013_delivery_quote_and_subscriptions` (adds the delivery columns up front) |
| Staffing foundation                    | `0012_staffing_foundation`                      | `0014_staffing_foundation` (same SQL)                                        |
| Hiring interested scopes               | not upstream                                    | `0015_hiring_interested_scopes`                                              |
| Person erasure log                     | `0014_person_erasure_log`                       | `0016_person_erasure_log` (same SQL, trailing newline only)                  |
| Email confirmation on subscriptions    | `0015_customer_subscription_email_confirmation` | `0017_customer_subscription_email_confirmation` (same SQL)                   |
| Confirmation sent marker               | `0016_customer_subscription_confirmation_sent`  | `0018_customer_subscription_confirmation_sent` (same SQL)                    |

Policy: **never renumber, rename or edit a migration that has been applied.**
Drizzle records applied migrations by journal order and hash, and the files here
are already on long-lived `tenant_{orgId}.db` files. When upstream is merged:

1. Do not take upstream's `packages/tenant-db/drizzle` (files,
   `meta/_journal.json` and snapshots) wholesale; keep ours in a merge conflict.
2. Take only the delta: the upstream migrations whose change is not already in
   the table above. Compare the SQL, not the file names.
3. Append each one with the next free index here (`0019_...`, and so on) and
   keep its SQL unchanged. Add a `_journal.json` entry with the next `idx`, the
   new `tag` and a `when` later than the previous entry.
4. Add its snapshot by taking the latest snapshot here as the base (it holds the
   fork-only tables), applying the delta to it, and chaining it: a new `id` and
   a `prevId` equal to the `id` of the previous snapshot here. Do not copy
   upstream's snapshot (it lacks the fork-only tables and carries upstream's
   ids).
5. `packages/tenant-db/src/schema.ts` is merged as code. Run
   `npx drizzle-kit generate --name check` in `packages/tenant-db`: it must
   report nothing to migrate (delete anything it creates).
6. Run `npx vitest run src/migration-chain.test.ts` in `packages/tenant-db` and
   raise `SHIPPED_ENTRIES` there to the number of entries that had shipped
   before the sync: a database at the old state must migrate forward to exactly
   the schema a fresh one gets.

## Seeding

During development, you may want to seed your database with test data:

```sh
npm run db:seed
```

## Backups

Cloudflare D1 takes automatic snapshots of your database. You can view, restore,
or download these snapshots via the Cloudflare Dashboard or using
`wrangler d1 backup` commands.

```sh
# Example of taking a manual backup
npx wrangler d1 backup create menuza-db
```

For tenant databases on OCI, you should configure standard OCI block volume
backups.
