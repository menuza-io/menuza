---
name: project-agent-commands
description:
  Guide per-workspace typecheck, lint and test commands, memory and timeout
  limits, exit codes, SQLite inspection, Lingui, Playwright, native builds and
  migration pitfalls for agents in this project.
---

# Project agent commands

## When to use this skill

Use this skill before you run a verify command (typecheck, lint, test, build,
E2E) in any workspace, when a command fails in a way that looks like the
environment rather than your change, or when you inspect a local database. Read
"Developer machine or sandbox? Decide first" in the root `AGENTS.md` first; this
skill does not relax those rules.

## Verify matrix

Run from the repo root unless the command starts with `cd`. "No script" means
the workspace's `package.json` has none.

| Workspace             | Typecheck                                                                   | Lint                                                                       | Test                                   | Single test file                                 | Notes                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app                   | `cd apps/app && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck`   | `cd apps/app && NODE_OPTIONS=--max-old-space-size=4096 npx eslint <paths>` | `npm run test -w app`                  | `cd apps/app && CI=true npx vitest run <path>`   | Test config in `vite.config.ts`. Whole lint has a baseline.                                                                                                      |
| admin                 | `cd apps/admin && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck` | `cd apps/admin && npx eslint <paths>`                                      | `npm run test -w admin`                | `cd apps/admin && CI=true npx vitest run <path>` | `react-router typegen && tsc`, like App.                                                                                                                         |
| sites                 | `npm run typecheck -w sites` (`astro check`)                                | `npm run lint -w sites`                                                    | `npm run test -w sites`                | `cd apps/sites && npx vitest run <path>`         | Locales en, ar, es, fr, de, zh.                                                                                                                                  |
| web                   | `npm run typecheck -w web` (`astro check`)                                  | `npm run lint -w web`                                                      | `npm run test -w web`                  | `cd apps/web && npx vitest run <path>`           |                                                                                                                                                                  |
| tenant-api            | `npm run typecheck -w tenant-api`                                           | no script: `npx oxlint <paths>`                                            | `npm run test -w tenant-api` (Varlock) | `CI=true npm run test -w tenant-api -- <path>`   | Typecheck runs `codegen` and `generate:do-migrations`.                                                                                                           |
| jobs-cron             | `npm run typecheck -w jobs-cron`                                            | no script: `npx oxlint <paths>`                                            | `npm run test -w jobs-cron`            | `cd apps/jobs-cron && npx vitest run <path>`     |                                                                                                                                                                  |
| voice-agent           | `npm run typecheck -w voice-agent`                                          | no script: `npx oxlint <paths>`                                            | `npm run test -w voice-agent`          | `cd apps/voice-agent && npx vitest run <path>`   | Typecheck runs `codegen` first.                                                                                                                                  |
| mobile                | `npm run typecheck -w mobile`                                               | `npm run lint -w mobile`                                                   | no `test`: `npm run testing -w mobile` | `cd apps/mobile && npx jest <path>`              | Jest, so root `npm run test` skips it.                                                                                                                           |
| android               | no script                                                                   | `npm run android:lint -w android`                                          | `npm run android:test -w android`      | no script                                        | Gradle through `scripts/gradle.sh`.                                                                                                                              |
| ios                   | no script                                                                   | no script (`ios:format` rewrites files)                                    | `npm run ios:test -w ios`              | no script                                        | `swift test` on the TenantKit package.                                                                                                                           |
| Varlock packages      | `npm run typecheck -w @repo/<pkg>`                                          | `validation` only; others `npx oxlint <paths>`                             | `npm run test -w @repo/<pkg>`          | `CI=true npm run test -w @repo/<pkg> -- <path>`  | auth, cache, common, database, email, observability, reports, security, sso, tenant-db, validation.                                                              |
| Other tested packages | `npm run typecheck -w @repo/<pkg>`                                          | `marketing-workflow`, `payments`, `types` only                             | `npm run test -w @repo/<pkg>`          | `cd packages/<pkg> && npx vitest run <path>`     | ai, config, geo, integrations, marketing, marketing-workflow, mcp, payments, phone-agent, phone-agent-restaurant, staffing, staffing-restaurant, storage, types. |
| Untested packages     | `npm run typecheck -w @repo/<pkg>`                                          | `audit`, `flow-editor`, `notifications`, `ui` only                         | no script                              | no script                                        | analytics, audit, flow-editor, i18n, notifications, seo, sms, test-utils, ui.                                                                                    |

For workspaces without a `lint` script, also run `npx prettier --check <files>`.
`@repo/ui` lint runs Oxlint and then ESLint. Never run Vitest from the repo
root: there is no root config.

## Memory and concurrency

- Assume about 8 GB of RAM. App typecheck uses about 3.4 GB, the whole App
  Vitest suite about 2.6 GB, and an App browser tab about 500 MB.
- Never run App typecheck, App ESLint and a build at the same time. Run the
  whole App suite alone. Keep to two or three browsers.
- After an Android build, stop the Gradle daemon with
  `cd apps/android && ./gradlew --stop`; it holds about 2 GB.

## Timeouts and background processes

- Over 60 s: App and Admin typecheck (about 70 s), `npm run build -w app` (about
  110 s), the whole App suite (about 7.5 min) and Playwright. Allow 300-600 s.
- Start dev servers with your tool's background mode or `setsid`; a plain
  `nohup ... &` in a one-shot shell dies with that shell. Poll with
  `curl -s --max-time 5 <health-url>`. Ports, health checks and the stop recipe
  are under "Local services (headless)" in the root `AGENTS.md`.

## Reading results

- Keep the real exit code: `<cmd> > /tmp/x.log 2>&1; echo EXIT=$?`, then search
  the log. A pipe into `tail` or `grep` reports the exit code of the last
  command in the pipe.
- A failing command under Varlock ends with "try running the same command
  without varlock...". Ignore that trailer and read the error above it.
- Add `--reporter=verbose` to Vitest when you need test names.

## One-off scripts

- `tsx -e` compiles to CommonJS, so top-level `await` fails. Write `/tmp/x.mts`
  and run `node_modules/.bin/tsx /tmp/x.mts`, or wrap the code in
  `;(async () => { ... })()`.
- A script that imports a repo dependency (for example `jose`) must live inside
  the repo tree so Node can resolve it. Delete it afterwards.
- Pass multi-line programs through a quoted heredoc.

## SQLite

- Use the `sqlite3` CLI; `better-sqlite3` is not installed. Use absolute paths.
- Check columns first (`.schema <table>`, `PRAGMA table_info(<table>)`, or
  `packages/database/src/schema.ts` and `packages/tenant-db/src/schema.ts`).
- Copy a live database with `sqlite3 <src> ".backup /tmp/x.db"`, because recent
  writes may still be in the `-wal` file. Open a live file read-only as
  `sqlite3 "file:<path>?mode=ro"`.
- Local App D1:
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "<sql>"`
  (5-15 s per call; secret-looking columns come back as asterisks). The file is
  under `apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`.
- Tenant DBs: `packages/database/db/tenant_<orgId>.db` unless `TENANT_DB_DIR` is
  set.

## Migrations and seeds

- Observed: local D1 rejects a large `INSERT ... SELECT ... UNION ALL` with "too
  many terms in compound SELECT". Write one `INSERT ... WHERE NOT EXISTS` per
  row, separated by `--> statement-breakpoint`.
- Tenant DBs run Drizzle's migrator on open
  (`packages/tenant-db/src/migrations.ts`), which records applied migrations in
  `__drizzle_migrations` and applies only newer ones. Editing a migration that a
  local tenant DB already applied changes nothing there; add a new migration.
- Seed and provision scripts print "Successfully provisioned tenant DB" on every
  run. To check what was applied, compare the row count of
  `__drizzle_migrations` with `packages/tenant-db/drizzle/meta/_journal.json`.
- `apps/tenant-api/workers/migrations.generated.ts` is gitignored and generated
  by `scripts/generate-do-migrations.mjs` (run by tenant-api typecheck, build
  and `deploy:cf`).
- `@repo/security` and `@repo/observability` are consumed from `dist`. After
  changing them, run `npm run build -w @repo/<pkg>`.

## Generated files

- Varlock rewrites tracked `src/env.ts` files unformatted. Restore formatting
  with `npx prettier --write $(git ls-files -m | grep -E '(^|/)src/env\.ts$')`
  instead of `git checkout`, so genuine schema changes survive.
- Check `git diff --quiet -- package-lock.json` for stray lockfile changes.
- Do not commit `test-results/`.

## Lingui

1. `npm run lingui:extract -w <app>` (app, admin, sites, mobile).
2. Fill every `msgstr` in each non-source catalog: `ar` for App, Admin and
   mobile; `ar`, `es`, `fr`, `de` and `zh` for Sites. Keep source strings in
   English.
3. `node scripts/check-lingui.mjs`.

The check does not catch hardcoded English literals that never went through a
macro, such as option arrays, enum values rendered as text, or `aria-label`s.
Search the files you touched, then look at the page with `?lng=ar`.

## Playwright (App)

```bash
npm run build -w app
cd apps/app && PORT=3101 CI=true npx playwright test tests/e2e/<spec>.test.ts --workers=1 --reporter=line
```

- Check that port 3101 is free first. On a developer machine, ask first: it
  writes to LibSQL.
- Add `--retries=0 --repeat-each=3` for new tests.
- Copy `-g` titles exactly. "No tests found" also appears when a spec fails to
  import.

## Native on Linux

- Android: `scripts/gradle.sh` finds the SDK from `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `local.properties` or the usual install paths, and needs
  `java` on `PATH` or `JAVA_HOME`. `.agents/setup` writes both exports to
  `~/.bash_profile` (SDK default `$HOME/android-sdk`), which a non-login shell
  does not read, so export them in the same command when they are missing.
- iOS: only the TenantKit Swift package builds on Linux
  (`npm run ios:build -w ios`, `npm run ios:test -w ios`) and only if a Swift
  toolchain is installed. Everything else needs macOS.

## Commit hygiene

- Test fixtures named like `secret*` with long random-looking values can be
  blocked by secret scanners. Use obviously fake values such as
  `test-only-not-a-secret`.

## References

- [Root agent guide](../../../AGENTS.md)
- [App agent guide](../../../apps/app/AGENTS.md)
- [Testing docs](../../testing.md)
- [Dev port list](../../../scripts/kill-dev-ports.mjs)
- [Lingui check](../../../scripts/check-lingui.mjs)
- [Tenant migrations](../../../packages/tenant-db/src/migrations.ts)
