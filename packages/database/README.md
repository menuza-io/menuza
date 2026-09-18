# @repo/database

Control-plane SQLite schema (Drizzle) for App/Admin: organizations, billing
flags, website config, and **`OrganizationLocation`** (restaurant branches).

## Migrations

SQL migrations live in `drizzle/`. After checkout or pulling schema changes,
apply them from the repo root: **`npm run db:migrate:deploy`** (runs
`packages/database` migrate against local `./packages/database/data.db`).

If `db:migrate:deploy` fails with **table `OrganizationLocation` already
exists**, your DB has the table but Drizzle has not recorded migration `0015`
yet. Pull the latest branch (0015 uses `IF NOT EXISTS`) and run
**`npm run db:migrate:deploy`** again. As a last resort on a throwaway local DB:
`npm run db:reset` in `packages/database`.

Generate new migrations after editing `src/schema.ts`:

```bash
cd packages/database && npm run db:generate -- --name your_migration_name
```
