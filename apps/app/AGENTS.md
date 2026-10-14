# apps/app AGENTS.md

The operator App: React Router 8 on Cloudflare Workers (D1). Read the root
`AGENTS.md` first. Its "Agent quickstart" covers bootstrap, `BASE_URL`, the
start command, which database each command uses, and how to check your work.
Paths below are relative to `apps/app` unless they start with `packages/`. Run
commands from the repo root unless a line starts with `cd apps/app`.

## App map

| Path                                                   | What lives there                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/routes.ts`                                        | `remix-flat-routes` config. Folders ending in `+` group routes; `*.server.*`, `*.client.*`, `*.test.*` and `__*` files are not routes.                  |
| `app/routes/_app+/_layout.tsx`                         | Signed-in shell and sidebar.                                                                                                                            |
| `app/routes/_app+/$orgSlug_+/`                         | Everything inside an org: `index.tsx` (Home dashboard), `dashboards+/`, `reports+/`, `staff+/`, `settings+/`, `marketing+/`, `website+/`, `notes*.tsx`. |
| `app/routes/_auth+/`                                   | Login, signup, logout, password reset, SSO.                                                                                                             |
| `app/routes/resources+/`, `app/routes/api+/`           | Resource routes, cron jobs (`resources+/jobs.*`), the notifications SSE stream (`api+/notifications+/stream.tsx`).                                      |
| `app/utils/organization/loader.server.ts`              | `requireUserOrganization(request, orgSlug, columns?)`: 404 unless the user is an active member.                                                         |
| `app/utils/organization/permissions.server.ts`         | `requireUserWithOrganizationPermission`, `requireAnyUserWithOrganizationPermission` (401 when signed out, 403 when the permission is missing).          |
| `packages/auth/src/organization-permissions.server.ts` | `ORG_PERMISSIONS` and `userHasOrganizationPermission`.                                                                                                  |
| `app/utils/dashboards/`                                | Dashboard access, actions, queries, config and layout.                                                                                                  |
| `app/components/dashboard/`                            | Dashboard grid, editor hook, dialogs and report blocks.                                                                                                 |
| `packages/reports/`                                    | Report catalog, engine, DSL, builder UI and saved reports.                                                                                              |
| `packages/database/src/schema.ts`                      | Control-plane tables (`User`, `Organization`, `UserOrganization`, `Permission`, `Dashboard`, `DashboardShare`, `SavedReport`, ...).                     |
| `tests/`                                               | Test helpers, Vitest setup, Playwright fixtures and `e2e/` specs.                                                                                       |
| `README.md`                                            | Dashboards architecture.                                                                                                                                |

## Running locally

- `BASE_URL`, the start command and the database table are in the root Agent
  quickstart.
- MSW mocks load only in the Node server (`index.ts`), not in Workers dev. In
  `npm run dev -w app`, `sendEmail` calls the real Resend API, so test signup
  and email invites with Playwright instead.
- Run `npm run build` once before the first `npm run dev -w app`, Vitest run or
  typecheck (root Agent quickstart, step 1). `@repo/observability` and the root
  export of `@repo/security` resolve to their gitignored `dist` builds, and
  `app/root.tsx` imports the gitignored icon sprite. `npm run dev -w app` builds
  neither. Other workspace packages are read from source.
- After changing `@repo/observability` or `@repo/security`, run
  `npm run build -w <package>`. After adding or changing SVG icons, run
  `npm run generate:icons`.
- Commands run from inside `apps/app` print "ignoring workspace config at
  apps/app/.npmrc". The warning is harmless.

## Databases and migrations

- Query local D1:
  `cd apps/app && npx wrangler d1 execute DB --local --json --command "<sql>"`.
  Timestamps are integer milliseconds. Check columns with
  `PRAGMA table_info(<Table>)` before you write SQL.
- New migration: follow "Database Operations" in the root `AGENTS.md` (generate
  in `packages/database`, then `npm run db:migrate:deploy` and
  `npm run db:migrate:d1:local -w app`).
- Migration numbers can collide after a merge from `main`. Delete your
  migration, merge, and generate it again so it gets the next number. Then fix
  your local ledgers:
  - Drizzle (LibSQL) applies only migrations newer than the newest `created_at`
    in `__drizzle_migrations`, so recreate LibSQL with
    `npm run db:reset -w @repo/database` (destructive).
  - Local D1 records applied files by name in `d1_migrations`. Rename the row to
    match your new file, or delete `apps/app/.wrangler/state` (destructive) and
    migrate again.

## Test data and several users

- `npm run db:seed` fills LibSQL only. It creates five faker users and the admin
  demo user `kody`; their passwords are set in `packages/database/seed.ts`. It
  creates no organizations.
- Copy seed data into the local D1 that `npm run dev -w app` uses. This needs
  the `sqlite3` CLI. Run it once, while local D1 has no users: a second run with
  a new seed fails with a foreign-key error and changes nothing.

  ```bash
  npm run db:migrate:d1:local -w app
  cd packages/database
  DATABASE_URL=file:/tmp/seed.db npm run db:migrate:deploy
  DATABASE_URL=file:/tmp/seed.db npm run db:seed
  (echo 'PRAGMA defer_foreign_keys = true;'
   sqlite3 /tmp/seed.db .dump | grep '^INSERT INTO' \
     | grep -v '__drizzle_migrations\|sqlite_sequence' \
     | sed 's/^INSERT INTO/INSERT OR IGNORE INTO/') > /tmp/seed.sql
  cd ../../apps/app && npx wrangler d1 execute DB --local --file /tmp/seed.sql
  ```

- Membership is a `UserOrganization` row (`userId`, `organizationId`,
  `organizationRoleId`, `active`, `isDefault`). Built-in org roles are
  `org_role_admin`, `org_role_member`, `org_role_viewer` and `org_role_guest`.
- Join tables: in `_RoleToUser`, `A` is the role id and `B` the user id. In
  `_OrganizationPermissionToRole`, `A` is the org role id and `B` the permission
  id.
- A user who must sign in needs a `Password` row. Copy the hash from a seeded
  user, and do not print it.
- An org you insert by hand needs a tenant DB before reports or staffing work.
  POST `http://localhost:3007/api/provision` with
  `{"orgId": "...", "slug": "...", "customDomain": null, "dataRegion": "us"}`
  and `Authorization: Bearer <INTERNAL_COMMAND_TOKEN>`, then set
  `Organization.hasProvisionedDb = 1`.
- Opening `/<orgSlug>` makes that org the user's default (the Home loader calls
  `setUserDefaultOrganization`), so later logins land there.

## Login and browser testing

- Use a fresh browser context per user, open `/login` directly, and accept the
  cookie banner.
- Login has two steps: fill "Email or Username" and click Continue, then fill
  the password input (`input[type=password]`; the text "Password" also matches
  "Forgot your password?") and click Sign In. Wait for the URL to change.
- Never wait for `networkidle`. The notifications SSE stream
  (`/api/notifications/stream`) stays open. Wait for a specific element or
  response instead. The Playwright `page` fixture in `tests/playwright-utils.ts`
  aborts the stream.
- Do not log out to switch users. See "Known issues" in the root `AGENTS.md`
  (logout then login lands on `/_.data`).
- Arabic and RTL: add `?lng=ar` to any URL. The `lng` cookie is httpOnly, so
  page scripts cannot set it.
- Dashboard edits save after a 500 ms debounce (`SAVE_DELAY_MS` in
  `app/components/dashboard/use-dashboard-editor.ts`). Before reloading, wait
  for the save request to return and for "Saved" in the toolbar. A pending save
  is sent with `keepalive` on `pagehide`.

## React Router 8 data requests (single fetch)

- Client data requests go to `<path>.data`, or `<path>_.data` when the path ends
  in `/` (so `/` becomes `/_.data`). GET loader requests drop an empty `index`
  parameter and may add `_routes`. Forms and fetchers POST to the same `.data`
  URL, and a POST to an index route keeps `?index`.
- A redirect thrown over `.data` comes back as HTTP 202 with the redirect
  encoded in the body, not as a 3xx. A document request to `<path>` gets the
  real status.
- `request.url` in a loader or action is the raw `.data` URL. Use the `url`
  argument (normalized, without `.data`, `index` or `_routes`) to build
  user-facing URLs or `redirectTo`.
- The client calls `window.fetch` with `URL` and `Request` objects as well as
  strings. A fetch wrapper or observer must handle all three.
- To check authorization by hand, POST `FormData` with the route's `intent` to
  the document URL and read the status. A POST to an index route needs `?index`;
  without it the parent route's action handles it.

## UI kit, icons and design lint

- `@repo/ui` is built on Base UI (`@base-ui/react`), not Radix. Import each
  component by path, for example `@repo/ui/button`, `@repo/ui/dialog`,
  `@repo/ui/icon`. Most sources are in `packages/ui/components/ui/`; `Icon` is
  in `packages/ui/components/icon.tsx`.
- Use `render` instead of `asChild`: `<Button render={<Link to="..." />}>`. Base
  UI needs `nativeButton={false}` when the rendered element is not a `<button>`.
  `Button` sets it from the `render` element; other triggers may not.
- Icons: `<Icon name="plus" />` from `@repo/ui/icon`. Add SVGs to
  `packages/ui/other/svg-icons/` and run `npm run generate:icons`. Turbo also
  runs it before `npm run dev:app` and the `@repo/ui` build, but
  `npm run dev -w app` does not.
- Design lint (`shadcn/*` rules) is described in the header of
  `packages/config/eslint-preset.js`. Use theme tokens and existing variants. If
  `no-restyle` fails, fix the call site. Extend the component's contract only
  when the design system intentionally allows the change.
- Wrap long user-supplied names with `wrap-anywhere`, as the dashboard menus do.

## Internationalization

- Wrap UI text with `Trans`, `t` or `msg` from `@lingui/macro`. Use
  `useLingui()` from `@lingui/react` for `_()` in components.
- After changing text, run `npm run lingui:extract -w app`, then fill every new
  `msgstr` in `app/locales/ar.po`. Extraction also covers
  `packages/reports/src/ui`, `packages/ai`, `packages/marketing` and
  `packages/marketing-workflow`.
- Verify with `node scripts/check-lingui.mjs`. Pre-commit runs it; it fails on
  unextracted strings, an empty `msgstr`, or an unstaged `.po` file.
- Resolve `.po` merge conflicts by running extract again and checking that no
  `msgstr` is empty.

## Forms, fetchers and access errors

- Forms with fields use Conform (`parseWithZod`) and Zod. Fetcher routes with
  several actions parse `FormData` with a Zod discriminated union on `intent`
  (see `app/utils/dashboards/actions.server.ts`).
- Return 404 when the user may not know the resource exists (not a member, not
  shared with them). Return 403 when they can see it but lack the right for this
  intent. Signed-out requests get 401.
- Decide "no access" or "signed out" UI from the actual response status, not
  from permission flags computed in the loader. Flags may only hide entry
  points. See `refusalError` in `packages/reports/src/ui/use-report-runner.ts`
  and `isReportAccessDenied` in `app/utils/dashboards/reports.ts`.
- `useFormAction()` with no argument includes `location.search`. Do not use it
  as an effect dependency or cache key; use `useFormAction('.')`.
- For bug fixes, write the failing test first.

## Reports

- `@repo/reports` exports `.` (catalog, engine, DSL), `./ui` (builder, library,
  runner), `./token` (operator token) and `./server` (saved reports).
- The browser gets a short-lived token from
  `app/routes/_app+/$orgSlug_+/reports+/token.ts` and queries tenant-api
  directly. The token needs `read:analytics:any`, `read:settings:any` or
  `read:website:any`. Call reports also need `read:phone_call:any`. Staff
  reports follow the staffing flags and permissions.
- No role grants `read:analytics:any` (see root Known issues). To test a
  non-admin report viewer, insert a `Permission` row and grant it to an org
  role.
- Create saved reports with `saveReport` from `@repo/reports/server`. It sets
  `title` from `definition.settings.title`; raw SQL must keep the two equal.
- Current limitations: the UI cannot delete a saved report, and choosing Table
  in the builder clears `groupBy`. Grouped tables exist only through SQL or
  `saveReport`.
- A new org has an empty tenant DB, so reports show no rows until you add data.

## Tests, lint and typecheck

- Vitest: `cd apps/app && npx vitest run <paths>`. Watch: `npx vitest`.
  `npm run test -w app` runs everything once. Vitest only picks up
  `app/**/*.test.{ts,tsx}`.
- `tests/setup/setup-test-env.ts` resets MSW handlers and Testing Library after
  each test, and turns `console.error` and `console.warn` into failures. Fix the
  warning, or mock it in the test when it is expected.
- Examples: `app/routes/_app+/$orgSlug_+/notes.statuses.test.ts` for a route
  action, `tests/setup/drizzle-mock.ts` for DB mocks. Helpers:
  `tests/test-utils.ts` (`createTestUser` hashes a real password and is slow,
  `createTestOrganization`, `addOrganizationMember`) and
  `tests/dashboard-utils.ts` (`insertTestUser`, `insertTestMember`, fast).
- Oxlint ignores test files. ESLint and typecheck still check them.
- E2E writes to LibSQL, so it cannot use the Workers dev server:

  ```bash
  npm run build -w app
  cd apps/app && PORT=3101 CI=true npx playwright test <spec> --workers=1
  ```

  `CI=true` starts `npm run start:mocks` and adds 2 retries. Check new tests
  with `--retries=0 --repeat-each=3`. Timeouts: 60 s per test, 15 s per
  `expect`.

- Fixtures in `tests/playwright-utils.ts`: `login`, `insertNewUser`, `navigate`.
  For a second signed-in user in one test, copy `signInElsewhere` from
  `tests/e2e/dashboard-sharing.test.ts`.
- Lint and types: `npm run lint -w app` and `npm run typecheck -w app` (runs
  `react-router typegen` first).

## Commands that rewrite files

Check `git status` after these and revert what you did not mean to change:

- Vitest, builds and dev servers: Varlock regenerates tracked `env.ts` files,
  for example `packages/security/src/env.ts`.
- `npm run generate:icons`: `packages/ui/components/icons/` (tracked).
- `npm run lingui:extract -w app`: `app/locales/*.po` (meant to be committed).
- `node scripts/write-ci-app-env.mjs`: overwrites `apps/app/.env` and
  `apps/admin/.env` (gitignored, but your `BASE_URL` line is lost).
- Root `npm run dev`: kills every dev port first.
