---
name: project-caching
description:
  Guide cache selection, cachified usage, invalidation, and cache safety across
  this multi-app project.
---

# Project caching

## When to use this skill

Use this skill when caching database or external API results, adding
stale-while- revalidate behavior, invalidating organization/site data, or
diagnosing cache freshness and performance.

## Choose the smallest useful cache

Measure or identify a real cost before adding caching. Fix an inefficient query,
missing index, unnecessary render, or waterfall first when that is the actual
cause. Never cache secrets, password hashes, OTPs, access tokens, refresh
tokens, or mutable authorization decisions without an explicit short-lived
design.

The shared package exposes two common backends:

- `cache` from `@repo/cache`: durable cache backed by SQLite locally/with the
  Node deployment and by the configured Worker KV backend in Workers.
- `lruCache` from `@repo/cache`: process-local memory for short-lived values,
  deduplication, and bounded hot data. It disappears on restart and is not
  shared between instances.

There are also site-specific KV helpers in
`apps/app/app/utils/sites/kv-cache.server.ts`. Keep public site cache keys
organization- and host-scoped when the host affects resolution or the response,
and purge them after CMS mutations.

Astro Sites has a separate edge/public-form cache lifecycle; read
[project-public-sites](../project-public-sites/SKILL.md) before changing its
middleware or cache headers. Do not assume an App cache key or backend is valid
for Sites.

## Use `cachified` through the shared package

```typescript
import { cachified, cache } from '@repo/cache'

const result = await cachified({
	key: `organization:${organizationId}:summary`,
	cache,
	getFreshValue: () => loadOrganizationSummary(organizationId),
	checkValue: OrganizationSummarySchema,
	ttl: 1000 * 60 * 5,
	staleWhileRevalidate: 1000 * 60 * 60,
})
```

- Use stable, namespaced keys such as `user:${id}:security` or
  `site:${orgId}:page:${host}:${pageSlug}:${home}:${locale}:${queryVariant}`.
- For the public-site page flow in
  `apps/app/app/routes/resources+/sites.page.ts`, include `host` in every
  generated `queryHash`, including host-only requests where the host is what
  resolves the organization. Preserve every tenant, locale, permission-sensitive
  input, and query variant that changes the result in the key.
- Validate fresh and cached data with Zod when the value crosses a trust or
  deployment boundary.
- Set TTL from acceptable staleness, not from convenience. Use `null` only for
  intentionally permanent data with a deliberate invalidation path.
- Pass the route’s `Timings` object when a route already records server timing;
  `@repo/cache` integrates cache retrieval with the shared timing utilities.

## Invalidation is part of the feature

Every mutation that changes cached data should invalidate the exact keys or a
documented namespace. Existing helpers include `invalidateUserCache`,
`invalidateUserSecurityCache`, and `invalidateUserOrganizationsCache`. Website
page/form/redirect mutations also purge the organization’s public site cache.

Invalidate after the database write succeeds. If invalidation is best-effort,
log the failure with the key/organization ID but never include credentials or
PII. Do not use a broad cache clear for a single organization update.

## Runtime and privacy boundaries

- Worker and Node runtimes do not necessarily share the same cache backend or
  process lifetime; correctness must not depend on an LRU hit.
- Public site payloads may be cached only after they are confirmed public and
  organization-scoped.
- Customer PII belongs to the regional tenant API. Do not create a US cache of
  KSA customer records or tenant auth responses.
- Responses containing private operator data should use conservative cache
  headers and should not be shared by a browser/CDN unless explicitly safe.

## References

- [Caching docs](../../caching.md)
- [Server timing](../../server-timing.md)
- [Tenant data residency](../../tenant-data-residency.md)
