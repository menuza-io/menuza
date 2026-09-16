---
name: project-react-patterns
description:
  Guide React 19, React Router 8 data APIs, rendering performance, component
  composition, and TypeScript patterns in this project.
---

# Project React patterns

## When to use this skill

Use this skill when building React components, route modules, data fetching,
loading/error states, client interactions, bundle boundaries, or performance
optimizations in App/Admin, the extension, or Expo mobile. Astro/Svelte-style
site rendering and native Swift/Kotlin UI should follow their app-specific
patterns instead.

## Prefer the router data model

Load route data in React Router loaders and perform mutations in actions. Do not
fetch server data in `useEffect` when a loader, `useFetcher`, or a route action
owns the operation.

```typescript
import { useLoaderData } from 'react-router'
import { type Route } from './+types/dashboard'

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	return { summary: await loadSummary(userId) }
}

export default function Dashboard() {
	const { summary } = useLoaderData<typeof loader>()
	return <SummaryCard summary={summary} />
}
```

Use `useFetcher` for in-place actions, pending states, and revalidation without
unnecessary navigation. Keep server-only imports out of client modules and place
browser-only code behind `.client.*` or a client component boundary.

React Router type generation is part of App/Admin `typecheck`; do not hand-write
route argument types when generated `./+types/*` types are available. App/Admin
server entrypoints may run in Node or Cloudflare Worker mode, so avoid Node-only
APIs in code reachable from the Worker build.

## Component design

- Compose focused components around the shared primitives in `@repo/ui`.
- Keep route components responsible for orchestration and move reusable UI or
  domain operations to the appropriate app/package.
- Use controlled state only when the browser needs immediate local interaction;
  do not mirror loader data into state without a clear reason.
- Give every async action a pending, success, empty, and recoverable error
  state.
- Use stable keys from domain IDs, not array indexes for reorderable or mutable
  collections.
- Keep TypeScript strict. Use generated route types and inline type imports;
  avoid `any` and type assertions that conceal an invalid response.

## Performance that fits this stack

Avoid waterfalls by loading independent data together in a loader or with
parallel promises. Select only required DB fields and cache only measured,
safe-to-cache results through `@repo/cache`.

Use route-level code splitting and lazy boundaries where a large feature is not
needed for the first view. Prefer CSS transforms/opacity for motion, respect
reduced-motion preferences, and avoid expensive work during render. Memoization
is useful when profiling shows repeated expensive work; it is not a default
substitute for simpler component/data design.

For images/media, use the existing storage/resource helpers and responsive media
contracts. For marketing email, render on the server and persist the result; do
not pull React Email or server-only data into a browser bundle.

Do not optimize by moving customer PII into a US loader/cache. Sites Astro code
and tenant-api Hono code have different runtime boundaries; preserve the direct
browser-to-regional-API flow.

## Errors and accessibility

Use route error boundaries and existing error components to present a useful
fallback without leaking internals. Render semantic HTML and accessible names;
use `@repo/ui` primitives rather than rebuilding focus, keyboard, and dialog
behavior. Keep validation errors connected to their fields.

## Imports and paths

Follow the repository order: external packages, `@repo/*`, `#app/*`/`#tests/*`,
then relative imports. Use aliases such as `#app/*` and `@repo/*`; do not add a
second import convention. Components use PascalCase names and files generally
use the repository’s kebab-case convention.

## References

- [Routing docs](../../routing.md)
- [Caching docs](../../caching.md)
- [UI guidelines](../project-ui-guidelines/SKILL.md)
- [TypeScript/import decisions](../../decisions/001-typescript-only.md)
