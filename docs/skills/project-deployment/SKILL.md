---
name: project-deployment
description:
  Guide builds, CI/CD, Cloudflare, Pages, OCI regional services, secrets, and
  health checks for this project.
---

# Project deployment

## When to use this skill

Use this skill when changing deployment configuration, CI workflows, Worker or
Pages releases, docs/studio hosting, regional tenant-api infrastructure,
environment variables, health checks, or rollback procedures.

## Deployment topology

- `apps/app`, `apps/admin`, and `apps/jobs-cron` deploy as Cloudflare Workers.
- `apps/web` and `apps/sites` deploy to Cloudflare Pages.
- `apps/docs` and `apps/studio` are local/tooling surfaces; verify their
  hosting/build path before adding deployment assumptions because they are not
  part of the Worker release set.
- `apps/tenant-api` runs regionally: US on the Cloudflare Worker/Durable Object
  path (or optional OCI Ashburn deployment), KSA on OCI Riyadh with a block
  volume.
- `apps/mobile` is Expo and `apps/ios`/`apps/android` have opt-in native build
  and release scripts; they are not normal server deployments.
- The control-plane D1 database is US-only. Customer PII is in regional per-org
  SQLite and must not cross the residency boundary.

Read [deployment](../../deployment.md),
[deployment checklist](../../deployment-checklist.md), and
[tenant residency](../../tenant-data-residency.md) before changing topology.

## Local and CI verification

Use the repository scripts from the workspace root:

```sh
npm run build
npm run typecheck
npm run lint:all
npm run test
npm run test:e2e:run
npm run validate
```

`npm run dev` starts the proxy, App/Web/Admin/Sites/Studio/Docs, both tenant-api
nodes, and jobs-cron through the configured Turbo tasks. Test changes against
the affected app/package when possible, then run proportionate workspace
validation. CI runs on pushes to `main` and `dev`, detects affected packages
with Turbo, applies required database setup, builds, type-checks, runs Vitest,
and conditionally runs Playwright.

## Wrangler and environment rules

Load the Wrangler guidance before running a Wrangler command. Use the app’s
`wrangler*.jsonc`/deploy config and the correct Worker rather than reusing a
different app’s binding. Keep public variables and secrets distinct; use
`wrangler secret put` or the documented bulk workflow for production secrets.

Important variable boundaries include:

- App/Admin: `SESSION_SECRET`, `BASE_URL`, audit/integration encryption keys,
  and internal command credentials.
- App: `TENANT_API_URL`, `TENANT_API_URL_KSA`, `JOBS_CRON_WORKER_URL`, and
  `MEDIA_TRANSFORM_BASE_URL`.
- Tenant API: `DATA_REGION`, `TENANT_DB_DIR`, `JWT_SECRET`, `AUTH_HMAC_SECRET`,
  `INTERNAL_COMMAND_TOKEN`, and `APP_URL`.
- Sites: `PUBLIC_TURNSTILE_SITE_KEY`; it must not receive tenant auth secrets.

Provider-specific variables belong to their owning runtime: storage, email,
payments, SSO, integrations, observability, and AI credentials should not be
copied into every app’s environment. Check the relevant package/app schema.

Validate required env values at startup. Never commit real secrets, reuse the
App JWT secret in tenant-api, or put `AUTH_HMAC_SECRET`/customer credentials in
Sites.

## Release safety

- Keep commits deployable and changes small enough to roll back.
- Add or update `/resources/healthcheck` for App/Admin and `/health` for
  tenant-api when dependencies change.
- Apply schema changes before code that requires them; prefer compatible
  migrations for rolling deploys.
- Confirm the affected Worker, Pages project, region, architecture, and data
  volume before deploying.
- Treat `wrangler.deploy.jsonc`, Docker/OCI config, and generated Worker
  configuration as target-specific; do not deploy with the local config by
  accident.
- For a failed release, use the provider’s documented rollback/redeploy path; do
  not delete databases or volumes as a first response.

## References

- [Deployment docs](../../deployment.md)
- [Deployment checklist](../../deployment-checklist.md)
- [Workers builds](../../workers-builds.md)
- [Tenant data residency](../../tenant-data-residency.md)
- [Monorepo skill](../project-monorepo/SKILL.md)
- [Tenant data skill](../project-tenant-data/SKILL.md)
