import {
	type KVNamespace,
	type KVNamespaceListResult,
} from '@cloudflare/workers-types'
import {
	PUBLIC_FORM_CACHE_TTL_SECONDS,
	publicFormKvKey,
	type PublicFormProjection,
} from '@repo/common/public-form'

let siteDataKv: KVNamespace | null = null

/**
 * Bind the SITES_DATA_KV KV namespace at Worker startup.
 * Must be called from the Worker fetch handler before any request is handled.
 */
export function bindSiteDataKV(kv: KVNamespace | null | undefined) {
	if (kv) siteDataKv = kv
}

/**
 * Cached site data is keyed by a per-organization version that every purge
 * replaces. A request that read the database before a publish can still write
 * its result after the purge, but only under the old version, which no later
 * request looks up. Deleting by prefix alone let that write serve the old page
 * for the whole TTL.
 */
function siteCacheVersionKey(orgId: string) {
	return `site-version:${orgId}`
}

/** `null` when there is no KV or it cannot be read: do not cache then. */
export async function getSiteCacheVersion(
	orgId: string,
): Promise<string | null> {
	if (!siteDataKv) return null
	try {
		return (await siteDataKv.get(siteCacheVersionKey(orgId))) ?? '0'
	} catch {
		return null
	}
}

export function getSiteKvKey(
	type: 'org' | 'page',
	id: string,
	queryHash: string,
	version: string,
) {
	return `org:${id}:v${version}:${type}:${queryHash}`
}

/**
 * Drops the cached public site data of an organization. It never throws: every
 * caller runs it after its database change committed, so a KV outage must not
 * turn a saved change into an error for the operator. A failed purge only means
 * the cache serves older data until its TTL ends (`setCachedSiteData`, 24 hours
 * by default). Failures are logged with the organization id, which prefix kind
 * failed (`id`, `slug` or `host`) and the error name and message only.
 *
 * Returns `false` when anything could not be purged (a list or delete error; a
 * failure part-way through a long listing leaves the rest of that prefix
 * un-deleted), so a caller that unpublishes or hides content can tell the
 * operator or retry. Most callers ignore it. `true` when everything was dropped
 * or there is no KV to purge.
 */
export async function purgeOrganizationSiteCache(
	orgId: string,
	slug?: string,
	host?: string | null,
): Promise<boolean> {
	const kv = siteDataKv
	if (!kv) return true

	// Retire every key written under the current version first: this is what
	// keeps a request that raced the change from caching what it read.
	let purged = true
	try {
		await kv.put(siteCacheVersionKey(orgId), crypto.randomUUID())
	} catch (e) {
		purged = false
		console.error(
			`Failed to bump site KV cache version for organization ${orgId}`,
			e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error',
		)
	}

	// Old keys also expire on their own; deleting them just frees space sooner.
	const prefixes: { kind: 'id' | 'slug' | 'host'; prefix: string }[] = [
		{ kind: 'id', prefix: `org:${orgId}:` },
	]
	if (slug) prefixes.push({ kind: 'slug', prefix: `org:${slug}:` })
	if (host) prefixes.push({ kind: 'host', prefix: `org:${host}:` })

	// Each prefix is purged on its own, so one that fails (a list error, say) never
	// leaves the others (slug, host) stale.
	for (const { kind, prefix } of prefixes) {
		try {
			let cursor: string | undefined = undefined
			do {
				const keysPage: KVNamespaceListResult<unknown, string> = await kv.list({
					prefix,
					cursor,
				})
				await Promise.allSettled(
					keysPage.keys.map((key) =>
						kv.delete(key.name).catch((e) => {
							purged = false
							console.error(`Failed to delete KV key ${key.name}`, e)
						}),
					),
				)
				cursor = 'cursor' in keysPage ? keysPage.cursor : undefined
			} while (cursor)
		} catch (e) {
			purged = false
			console.error(
				`Failed to purge site KV cache (${kind} prefix) for organization ${orgId}`,
				e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error',
			)
		}
	}
	return purged
}

export async function getCachedSiteData(key: string) {
	if (!siteDataKv) return null
	try {
		const data = await siteDataKv.get(key, 'json')
		return data
	} catch {
		return null
	}
}

/**
 * Stores `data` under `key` (from `getSiteKvKey` with `version`) unless the
 * organization's version changed while the data was being read.
 */
export async function setCachedSiteData(
	key: string,
	data: unknown,
	guard: { orgId: string; version: string },
	ttlSeconds = 60 * 60 * 24, // 24 hours default expiration
) {
	if (!siteDataKv) return
	try {
		if ((await getSiteCacheVersion(guard.orgId)) !== guard.version) return
		await siteDataKv.put(key, JSON.stringify(data), {
			expirationTtl: ttlSeconds,
		})
	} catch {}
}

export async function setCachedPublicForm(
	organizationId: string,
	form: PublicFormProjection,
) {
	if (!siteDataKv) return
	const key = publicFormKvKey(organizationId, form.id)
	try {
		const current = await siteDataKv.get<PublicFormProjection>(key, 'json')
		if (current && current.revision > form.revision) return
		await siteDataKv.put(key, JSON.stringify(form), {
			expirationTtl: PUBLIC_FORM_CACHE_TTL_SECONDS,
		})
	} catch (error) {
		console.error(`Failed to cache public form ${form.id}`, error)
	}
}

export async function deleteCachedPublicForm(
	organizationId: string,
	formId: string,
) {
	if (!siteDataKv) return
	try {
		await siteDataKv.delete(publicFormKvKey(organizationId, formId))
	} catch (error) {
		console.error(`Failed to delete cached public form ${formId}`, error)
	}
}
