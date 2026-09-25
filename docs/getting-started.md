# Getting Started with Menuza

Menuza is a full-stack SaaS starter monorepo. It includes the operator app,
public tenant sites, regional tenant APIs, a marketing site, an admin dashboard,
and shared packages.

## Requirements

- Node.js 22.18.0
- npm 10.9.0

The repository pins both versions with Volta. Install dependencies from the
repository root:

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install
npm run setup
```

Install Playwright browsers when you intend to run end-to-end tests:

```sh
npm run test:e2e:install
```

## Development

Start every local service:

```sh
npm run dev
```

Or start an individual app:

```sh
npm run dev:app        # Operator app on :3001
npm run dev:web        # Marketing site on :3002
npm run dev:sites      # Public tenant sites on :3008
npm run dev:tenant-api # US tenant API on :3007
npm run dev:tenant-api:ksa # KSA tenant API on :3009
```

`npm run dev` starts both regional tenant APIs. Tenant customer data is stored
on the regional tenant API, not in the operator app's control-plane database.
Read [Tenant data residency](./tenant-data-residency.md) before changing tenant
authentication, data regions, or customer data handling.

## Database and validation

```sh
npm run db:migrate:deploy
npm run db:seed
npm run lint
npm run typecheck
npm run test
npm run test:e2e:run
```

Use `npm run validate` before submitting a change; it runs the repository's full
validation suite. See the root [README](../README.md) and
[testing guide](./testing.md) for environment setup and test details.
