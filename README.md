# Menuza

Menuza is a full-stack SaaS monorepo. It uses npm workspaces and
[Turborepo](https://turbo.build/repo/docs) to coordinate React Router, Astro,
Expo, Cloudflare Worker, and shared TypeScript projects.

## Requirements

- [Node.js](https://nodejs.org/) **22.18.0**. The root `package.json` requires
  `^22.18.0` and Volta pins `22.18.0`.
- [npm](https://www.npmjs.com/) **10.9.0**, as declared by `packageManager` and
  Volta in the root `package.json`.
- macOS or Linux on `arm64` or `x64` with glibc, as declared in the root
  `package.json`.

## Setup

Clone the repository, install the workspace dependencies, and run the repository
setup flow from the root:

```sh
git clone https://github.com/mohammedzamakhan/epic-startup.git
cd menuza
npm install # for agents PUPPETEER_SKIP_DOWNLOAD=true npm install
npm run setup
```

`npm run setup` applies the control-plane database setup and runs the local
brand, SSL, and hosts setup scripts. Review the
[getting started guide](./docs/getting-started.md) and each app's local
environment schema for environment-specific configuration.

Local HTTPS uses the automatically derived `{brand.slug}.test` domain (for
example, `app.acme.test:2999`). The configured brand domain remains reserved for
production and staging deployment URLs.

## Repository layout

The root workspace globs are `apps/*` and `packages/*`. Turborepo runs common
tasks across those workspaces while npm provides dependency and script
management.

### Applications

- `apps/app` — primary React Router application for operators, organizations,
  sites, billing, and platform features. Runs on port `3001` in development.
- `apps/admin` — React Router platform administration application. It starts
  near port `3005` and chooses a free port when needed.
- `apps/web` — Astro marketing website. Runs on port `3002`.
- `apps/sites` — Astro renderer for published organization websites. Runs on
  port `3008`.
- `apps/tenant-api` — regional Hono service for customer phone OTP, auth, and
  per-organization tenant databases.
- `apps/mobile` — Expo and React Native mobile application.
- `apps/chrome-extension` — Vite-powered Chrome and Firefox extension.
- `apps/docs` — Mint documentation site for the project docs.
- `apps/studio` — Drizzle Studio entry point for the local control-plane
  database.
- `apps/email` — React Email preview and export app for shared email templates.
- `apps/jobs-cron` — Cloudflare Worker for scheduled jobs and workflows that
  call authenticated App routes.

### Shared packages

The `packages/` workspace contains reusable code used by the applications:

- **Foundations:** `@repo/common`, `@repo/config`, `@repo/types`, `@repo/ui`,
  `@repo/validation`, and `@repo/test-utils`.
- **Data and platform:** `@repo/database`, `@repo/tenant-db`, `@repo/storage`,
  `@repo/cache`, `@repo/auth`, `@repo/security`, `@repo/sso`, `@repo/audit`,
  `@repo/analytics`, and `@repo/observability`.
- **Product capabilities:** `@repo/ai`, `@repo/email`, `@repo/i18n`,
  `@repo/integrations`, `@repo/marketing`, `@repo/marketing-workflow`,
  `@repo/mcp`, `@repo/notifications`, `@repo/payments`, `@repo/reports`,
  `@repo/seo`, and `@repo/sms`.

## Development

Run the complete local development topology from the repository root:

```sh
npm run dev
```

This starts the development proxy, the main apps and supporting workspaces, and
both regional tenant-api nodes. For a focused workflow, use the root aliases:

```sh
npm run dev:app
npm run dev:web
npm run dev:sites
npm run dev:tenant-api
npm run dev:tenant-api:ksa
npm run dev:mobile
```

The other app workspaces can be run directly through npm's workspace option:

```sh
npm run dev --workspace=admin
npm run dev --workspace=docs
npm run dev --workspace=studio
npm run dev --workspace=email
npm run dev --workspace=jobs-cron
npm run dev --workspace=chrome-extension
```

The local regional services are:

| Process      |   Port | Region                                             |
| ------------ | -----: | -------------------------------------------------- |
| `tenant-api` | `3007` | US (`DATA_REGION=us`)                              |
| `tenant-api` | `3009` | KSA (`DATA_REGION=ksa`)                            |
| `sites`      | `3008` | Injects the regional API URL for each organization |

`npm run dev:tenant-api:ksa` is the focused command for the KSA node. The
all-in-one `npm run dev` command starts it alongside the US node. See the
[tenant data-residency guide](./docs/tenant-data-residency.md) before changing
customer authentication, cookies, or PII handling.

In production, the US tenant-api runs on Cloudflare Worker and Durable Objects;
the KSA tenant-api runs on an OCI VM in Riyadh with block-volume storage. The
[deployment guide](./docs/deployment.md) describes the regional deployment
options.

## Data residency boundary

Operator authentication and organization configuration live in the US control
plane (`apps/app`, `apps/admin`, and `@repo/database`). Customer phone, name,
email, and tenant auth data live in an isolated per-organization SQLite database
behind the regional `apps/tenant-api` service (`@repo/tenant-db`).

Published Sites render CMS HTML and the browser calls the matching regional
tenant-api directly. Sites must not proxy customer PII through a server-side
auth BFF. Customer tokens remain in browser `localStorage`. Switching an
organization’s `dataRegion` destroys the old tenant database; customer data is
not migrated between regions. The
[canonical residency document](./docs/tenant-data-residency.md) covers the local
topology, production deployment, and required safeguards.

## Database, tests, and checks

The control-plane database commands target `packages/database` through the root
scripts:

```sh
npm run db:setup
npm run db:generate
npm run db:push
npm run db:migrate:dev
npm run db:migrate:deploy
npm run db:seed
npm run db:studio
```

For repository-wide validation, use the root scripts:

```sh
npm run build
npm run typecheck
npm run lint
npm run lint:oxc
npm run lint:all
npm run test
npm run test:e2e:install
npm run test:e2e:run
npm run format:check
```

For the full application validation flow, run the workspace script in the
application you are changing, for example:

```sh
npm run validate --workspace=app
```

Read the [database guide](./docs/database.md) and
[testing guide](./docs/testing.md) for migrations, test structure, Playwright,
Vitest, type checking, linting, and formatting details.

## Documentation and deployment

- [Documentation index](./docs/README.md)
- [Getting started](./docs/getting-started.md)
- [Deployment](./docs/deployment.md)
- [Database](./docs/database.md)
- [Testing](./docs/testing.md)
- [Tenant data residency](./docs/tenant-data-residency.md)
- [GitHub documentation](https://github.com/mohammedzamakhan/epic-startup/blob/main/docs)

## Contributing and support

- [Contributing guide](./CONTRIBUTING.md) and
  [GitHub contributing guide](https://github.com/mohammedzamakhan/epic-startup/blob/main/CONTRIBUTING.md)
- [GitHub discussions](https://github.com/mohammedzamakhan/epic-startup/discussions)
- [Ideas and feature requests](https://github.com/mohammedzamakhan/epic-startup/discussions/new?category=ideas)
- [GitHub issues](https://github.com/mohammedzamakhan/epic-startup/issues)
- [License](./LICENSE.md) and
  [GitHub license](https://github.com/mohammedzamakhan/epic-startup/blob/main/LICENSE.md)
