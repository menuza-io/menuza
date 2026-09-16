---
name: project-monorepo
description:
  Guide workspace navigation, Turbo task boundaries, shared packages, app
  selection, generated artifacts, and cross-app changes in this project.
---

# Project monorepo

## When to use this skill

Use this skill when a change crosses apps/packages, adding a shared package,
changing workspace scripts, debugging Turbo dependencies, or deciding where a
feature belongs.

## Repository shape

`apps/*` are deployable or runnable products: App/Admin operator surfaces, Astro
web/sites, regional tenant-api, jobs-cron, docs/studio, Expo mobile, native
iOS/Android tenant apps, email, and the browser extension. `packages/*` contain
shared contracts and services such as auth, database, tenant-db, cache,
security, storage, email, marketing, payments, integrations, SSO, UI, i18n,
observability, and test utilities.

Put reusable, runtime-appropriate behavior in a package only when it has a real
consumer beyond one route. Keep server-only code out of browser/mobile packages
and do not make a package depend on an app. Preserve the control-plane versus
tenant-data dependency boundary.

## Find the owning layer

- Route/view orchestration belongs in the owning app.
- Cross-app contracts, schemas, security primitives, and provider abstractions
  belong in the relevant `@repo/*` package.
- Operator auth/database/permissions belong to App/Admin and control plane.
- Customer auth/PII/forms/shop/journeys belong to tenant-api/tenant-db.
- Public CMS rendering belongs to Sites/Web; Sites must not become a PII BFF.
- Scheduled orchestration belongs to jobs-cron; domain logic stays in App or
  tenant-api.

The repository’s current tree has no separate CMS application. Treat App’s
website editor, public Sites renderer, and related storage/marketing packages as
the current CMS surface; do not invent a deployment target for a missing app.

Before adding a helper, search existing exports and call sites with `rg`, then
follow the package’s public `index.ts` instead of importing private internals.
Update all consumers and tests when changing a shared type or schema.

## Turbo and npm workflow

The root is an npm-workspace Turborepo with Node 22. Use package filters while
iterating and root scripts for final validation:

```sh
npm run dev:app
npm run typecheck -- --filter=app
npx --no-install turbo run test --filter=@repo/security
npm run validate
```

Build dependencies and cache behavior are defined in `turbo.json`. Native iOS
and Android tasks are intentionally opt-in and do not provide normal Turbo
build/test/typecheck tasks. Do not add a root dependency or script merely to
make one app convenient if it breaks platform-independent CI.

## Conventions and generated files

Use TypeScript/ESM, strict types, Zod at input boundaries, inline type imports,
the established import ordering, `@repo/*`/`#app/*` aliases, and existing
lint/format rules. Treat generated route types, env declarations, icons,
coverage/dist/.turbo/.wrangler outputs, and generated native tenant properties
as artifacts unless the repository explicitly tracks them.

When changing env variables, update the owning `.env.schema`, runtime config,
and any generated declaration/build config as required. When changing shared
database schemas, update the correct migration set and affected fixtures.

## Cross-app change checklist

1. Identify the data/runtime boundary and owning package/app.
2. Search consumers, env schemas, route registrations, and tests.
3. Preserve public API compatibility or update all call sites in one change.
4. Add focused tests in each affected runtime, including region/security cases.
5. Run lint, typecheck, targeted tests, then the appropriate workspace validate
   commands.

## References

- [Getting started](../../getting-started.md)
- [Guiding principles](../../guiding-principles.md)
- [Testing](../../testing.md)
- [Build configuration](../../../turbo.json)
