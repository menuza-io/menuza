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
| Reservations module (tables, triggers) | not upstream                                    | `0019_reservations` (one migration for the whole module)                     |

The reservations module is one migration, `0019_reservations`, which also holds
two non-reservation changes it needed (`voice_call_actions` and
`labor_scope_settings.demand_per_labor_hour`). It was first written as six
migrations, `0016` to `0021`, before the upstream deltas above existed on
`main`; when the module was merged they were folded into this one file (same
SQL, one snapshot chained after `0018`, a `when` later than `0018`'s). The
control-plane module migration is likewise one file, `0025_reservations` (`main`
ended at `0024_dashboards`, so its number did not move).

Policy: **never renumber, rename or edit a migration that has been applied.**
Drizzle records applied migrations by journal order and hash, and the files here
are already on long-lived `tenant_{orgId}.db` files. When upstream is merged:

1. Do not take upstream's `packages/tenant-db/drizzle` (files,
   `meta/_journal.json` and snapshots) wholesale; keep ours in a merge conflict.
2. Take only the delta: the upstream migrations whose change is not already in
   the table above. Compare the SQL, not the file names.
3. Append each one with the next free index here (`0025_...`, and so on) and
   keep its SQL unchanged. Add a `_journal.json` entry with the next `idx`, the
   new `tag` and a `when` **strictly greater than the previous entry's**. This
   is not cosmetic: Drizzle's SQLite migrator applies only the journal entries
   whose `when` is greater than the `created_at` of the last migration a
   database applied, so an entry with an older `when` is silently skipped on
   every database that already ran the entries before it.
4. Add its snapshot by taking the latest snapshot here as the base (it holds the
   fork-only tables), applying the delta to it, and chaining it: a new `id` and
   a `prevId` equal to the `id` of the previous snapshot here. Do not copy
   upstream's snapshot (it lacks the fork-only tables and carries upstream's
   ids).
5. `packages/tenant-db/src/schema.ts` is merged as code. Run
   `npx drizzle-kit generate --name check` in `packages/tenant-db`: it must
   report nothing to migrate (delete anything it creates).
6. Run `npx vitest run src/migration-chain.test.ts` in `packages/tenant-db`. Add
   the number of entries that had shipped before the sync to `SHIPPED_STATES`
   there: a database at each shipped state must migrate forward to exactly the
   schema a fresh one gets. The same test fails when a `when` does not increase
   or a snapshot is not chained to the previous one.

#### Control-plane migration numbering versus upstream

The control-plane migrations (`packages/database/drizzle`) diverged the same
way: the fork's `0021` to `0027` shipped before upstream's print and social
migrations, so upstream's files land here under the next free index.

| Change       | Upstream            | Here                                                      |
| ------------ | ------------------- | --------------------------------------------------------- |
| Print shop   | `0020_print_shop`   | `0027_print_shop` (same SQL; upstream's file is not kept) |
| Canva        | `0021_print_canva`  | `0028_print_canva` (same SQL)                             |
| Social media | `0022_social_media` | `0029_social_media` (same SQL)                            |

Merge them the way the tenant steps above describe: keep this side's journal and
snapshots in a conflict, append each upstream delta with the next free index and
a `when` greater than the previous entry's, and chain a snapshot built from the
latest one here. Then run `drizzle-kit generate --name check` in
`packages/database` (directly, as `node ../../node_modules/drizzle-kit/bin.cjs`)
and expect "No schema changes".

#### One-off: local tenant databases that ran the reservations branch early

Only developers who ran the reservations branch **before** it was merged have
this problem. Their local `tenant_{orgId}.db` files (under
`packages/database/db/`) recorded the reservations migrations under the old
numbers `0016` to `0021`. After the merge the journal is `0016` to `0018`
(upstream deltas) then `0019_reservations`, with newer `when` values, so Drizzle
sees `0016` to `0019` as not applied yet, runs the upstream deltas, and then
fails on `0019_reservations` with `table rsv_areas already exists`. Databases
created from `main`, or after the merge, are fine. So are the control-plane
databases (`data.db`, local D1): the module's control-plane migration is one
file, `0025_reservations`, made only of idempotent `INSERT OR IGNORE` and
`NOT EXISTS` statements, with a `when` later than the old `0026`'s, so a
database that applied the old `0025` and `0026` runs it once more harmlessly. No
action there.

Pick one per database. Do these only on a developer machine, with the tenant-api
dev processes stopped, and never on a shared or deployed database.

**Option A: rebuild (simplest, loses the local data of that organization).**
Delete `tenant_{orgId}.db` and its `-wal` and `-shm` files, then start
`npm run dev` (the organization's database is provisioned again on first use)
and re-run the seeds you need, for example
`npm run seed:reservations -w tenant-api -- <org-slug>` and
`npm run seed:demo-people -w tenant-api -- <org-slug>`. Local Durable Object
state of the Worker runtime (`apps/tenant-api/.wrangler/state`) is separate;
delete it the same way if you use it.

**Option B: keep the data.** The old reservations rows stay as they are. You
apply the three upstream deltas by hand and record `0016` to `0019` as applied,
so Drizzle starts at the first migration after them (the data already holds
everything `0019_reservations` creates):

```sh
cd packages/database/db
cp tenant_<orgId>.db tenant_<orgId>.db.bak            # always keep a copy
for f in 0016_person_erasure_log \
         0017_customer_subscription_email_confirmation \
         0018_customer_subscription_confirmation_sent; do
  sqlite3 tenant_<orgId>.db < ../../tenant-db/drizzle/$f.sql
done
node -e '
const fs = require("fs"), crypto = require("crypto")
const dir = "../../tenant-db/drizzle"
const { entries } = JSON.parse(fs.readFileSync(dir + "/meta/_journal.json", "utf8"))
for (const e of entries.filter((e) => e.idx >= 16)) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(`${dir}/${e.tag}.sql`, "utf8")).digest("hex")
  console.log(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ("${hash}", ${e.when});`)
}' | sqlite3 tenant_<orgId>.db
```

The three `sqlite3 < file` runs execute the upstream SQL (the
`--> statement-breakpoint` markers are SQL comments, so the files run as they
are). The `node` script prints one `INSERT` per journal entry from `0016` on,
with the hash Drizzle computes (SHA-256 of the file) and the entry's `when`, and
pipes them in. Afterwards the newest `created_at` in `__drizzle_migrations` is
the `when` of `0019`, so the next migration anyone adds applies normally. Check
with
`sqlite3 tenant_<orgId>.db 'select count(*), max(created_at) from "__drizzle_migrations"'`
and open the organization once; if anything fails, restore the `.bak` copy and
use Option A. If a file was already partly migrated (`duplicate column name` on
`0017` or `0018`), the upstream deltas are already there: skip that file and run
only the `INSERT` step.

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
