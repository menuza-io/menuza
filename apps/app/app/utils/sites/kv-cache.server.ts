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

export async function purgeOrganizationSiteCache(
	orgId: string,
	slug?: string,
	host?: string | null,
) {
	if (!siteDataKv) return

	const prefixes = [`org:${orgId}:`]
	if (slug) prefixes.push(`org:${slug}:`)
	if (host) prefixes.push(`org:${host}:`)

	try {
		for (const prefix of prefixes) {
			let cursor: string | undefined = undefined
			do {
				const keysPage: KVNamespaceListResult<unknown, string> =
					await siteDataKv.list({ prefix, cursor })
				await Promise.allSettled(
					keysPage.keys.map((key) =>
						(siteDataKv as KVNamespace).delete(key.name).catch((e) => {
							console.error(`Failed to delete KV key ${key.name}`, e)
						}),
					),
				)
				cursor = 'cursor' in keysPage ? keysPage.cursor : undefined
			} while (cursor)
		}
	} catch (e) {
		console.error('Failed to purge site KV cache', e)
		throw e
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

export async function setCachedSiteData(key: string, data: unknown) {
	if (!siteDataKv) return
	try {
		await siteDataKv.put(key, JSON.stringify(data))
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
