---
name: project-routing
description:
  Guide React Router 8 flat routes, layouts, resource/API routes, loaders,
  actions, and multi-app routing in this project.
---

# Project routing

## When to use this skill

Use this skill when adding pages, layouts, dynamic organization routes, resource
endpoints, API routes, redirects, or route-level data mutations.

## App routing model

`apps/app/app/routes.ts` configures `remix-flat-routes`. Route filenames are the
source of truth and test files/server-only helpers are ignored by the route
adapter.

Common conventions:

- `_auth+` contains public authentication layouts and flows.
- `_app+` contains the authenticated operator shell.
- `$orgSlug_+` scopes organization features and its nested settings/website/
  marketing routes.
- `resources+` contains resource routes such as health checks, downloads,
  search, jobs, site JSON, and media.
- `api+` contains JSON/API endpoints and should set explicit status and cache
  headers.
- `organizations+` contains organization-level routes outside the slug shell.
- `$param` is a dynamic segment; bracket escapes such as `[.]well-known` and
  `[.]xml` preserve literal dots.
- Route-based dialogs use the project’s route/modal convention; keep URL state
  and back-button behavior consistent instead of introducing local modal state
  for navigable flows.

Route modules should be colocated with tests and route-specific server/client
helpers, using `.server.*`/`.client.*` when a file must be excluded from route
discovery.

## Loaders and actions

Keep request data on the server boundary:

```typescript
import { type Route } from './+types/example'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const data = await loadData({ userId, slug: params.orgSlug })
	return { data }
}

export async function action({ request }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	// authorize, parse with Zod, mutate, then redirect or return errors
	return redirect('/success')
}
```

Loaders should fetch the data required to render the route; actions should own
mutations and return typed success/error results. Use `useFetcher` for local
mutations or background interactions that do not need navigation. Preserve
redirect return paths only through safe redirect helpers.

Authenticate and authorize before protected reads/mutations. Resolve org slugs
to control-plane organization IDs, then scope every query and cache key to that
organization. Do not use client search params or hidden form fields as access
control.

## Resource and API routes

Resource routes have no UI component. Return a `Response` with explicit content
type, status, security, and cache headers. Validate every JSON/body/query input
with Zod. Health routes must remain cheap and unauthenticated as designed; jobs,
provisioning, and internal routes require their configured command token.

`apps/sites` is Astro and `apps/tenant-api` is Hono; their routes are separate
from App’s React Router tree. In particular, Sites must not gain an auth BFF or
proxy regional customer PII. Browser customer calls belong on the regional
tenant-api.

For Site routes, preserve host resolution, locale rewrites, published-content
cache behavior, CSP headers, and the distinction between public `/api/*`
endpoints and App resource proxies. For tenant-api routes, register the route on
the shared Hono app so Node and Worker/Durable Object runtimes expose the same
contract, then test CORS, region matching, auth, and rate limits.

## References

- [Routing docs](../../routing.md)
- [Route config](../../../apps/app/app/routes.ts)
- [Tenant data residency](../../tenant-data-residency.md)
