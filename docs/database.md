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

To apply it to your local database:

```sh
npx tsx src/migrate.ts
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
