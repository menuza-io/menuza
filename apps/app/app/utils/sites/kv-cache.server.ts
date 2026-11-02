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

export function getSiteKvKey(
	type: 'org' | 'page',
	id: string,
	queryHash: string,
) {
	return `org:${id}:${type}:${queryHash}`
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

	const prefixes: { kind: 'id' | 'slug' | 'host'; prefix: string }[] = [
		{ kind: 'id', prefix: `org:${orgId}:` },
	]
	if (slug) prefixes.push({ kind: 'slug', prefix: `org:${slug}:` })
	if (host) prefixes.push({ kind: 'host', prefix: `org:${host}:` })
	let purged = true

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

/**
 * Every organization's cached public menu carries this generation in its key
 * (see `resources+/sites.menu.ts`). A change that can alter all menus at once,
 * such as a system-level discount flag, bumps it: each menu is then rebuilt on
 * its next request, with no list-and-delete over every organization's keys
 * (which a Worker request could not finish for many organizations). It lives
 * outside every `org:` prefix, so an organization purge never drops it.
 */
const MENU_GENERATION_KEY = 'sites:menu-generation'
/** Edge cache for the generation read: a bump shows within about a minute. */
const MENU_GENERATION_CACHE_TTL_SECONDS = 60
const MENU_GENERATION_PATTERN = /^[a-z0-9]{1,16}$/

/** The current menu generation, or `'0'` before the first bump or without KV. */
export async function getMenuCacheGeneration(): Promise<string> {
	if (!siteDataKv) return '0'
	try {
		const value = await siteDataKv.get(MENU_GENERATION_KEY, {
			cacheTtl: MENU_GENERATION_CACHE_TTL_SECONDS,
		})
		return value && MENU_GENERATION_PATTERN.test(value) ? value : '0'
	} catch {
		return '0'
	}
}

/**
 * Starts a new menu generation, so every organization's cached menu is
 * rebuilt. Never throws; false when KV is missing or the write failed.
 */
export async function bumpMenuCacheGeneration(
	now: number = Date.now(),
): Promise<boolean> {
	if (!siteDataKv) return false
	try {
		await siteDataKv.put(MENU_GENERATION_KEY, now.toString(36))
		return true
	} catch (error) {
		console.error(
			'Failed to start a new menu cache generation',
			error instanceof Error ? error.message : 'unknown error',
		)
		return false
	}
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

export async function setCachedSiteData(
	key: string,
	data: unknown,
	ttlSeconds = 60 * 60 * 24, // 24 hours default expiration
) {
	if (!siteDataKv) return
	try {
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
