# @repo/database

Control-plane SQLite schema (Drizzle) for App/Admin: organizations, billing
flags, website config, and **`OrganizationLocation`** (restaurant branches).

## Migrations

SQL migrations live in `drizzle/`. After checkout or pulling schema changes,
apply them from the repo root: **`npm run db:migrate:deploy`** (runs
`packages/database` migrate against local `./packages/database/data.db`).

Generate new migrations after editing `src/schema.ts`:

```bash
cd packages/database && npm run db:generate -- --name your_migration_name
```
