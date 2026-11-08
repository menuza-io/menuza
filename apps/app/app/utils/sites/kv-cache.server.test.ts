import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	bindSiteDataKV,
	getCachedSiteData,
	getSiteCacheVersion,
	getSiteKvKey,
	purgeOrganizationSiteCache,
	setCachedSiteData,
} from './kv-cache.server.ts'

function kv(
	overrides: Partial<Record<'list' | 'delete' | 'get' | 'put', unknown>> = {},
) {
	return {
		list: vi.fn(async () => ({ keys: [], list_complete: true })),
		delete: vi.fn(async () => {}),
		get: vi.fn(async () => null),
		put: vi.fn(async () => {}),
		...overrides,
	}
}

/** A KV namespace backed by a Map (no listing). */
function memoryKv() {
	const store = new Map<string, string>()
	return kv({
		get: vi.fn(async (key: string, type?: string) => {
			const value = store.get(key)
			if (value === undefined) return null
			return type === 'json' ? JSON.parse(value) : value
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
	})
}

afterEach(() => vi.restoreAllMocks())

describe('purgeOrganizationSiteCache', () => {
	it('deletes the keys under the organization prefixes', async () => {
		const store = kv({
			list: vi.fn(async ({ prefix }: { prefix: string }) => ({
				keys: [{ name: `${prefix}page:abc` }],
				list_complete: true,
			})),
		})
		bindSiteDataKV(store as never)
		await expect(purgeOrganizationSiteCache('org_1', 'acme')).resolves.toBe(
			true,
		)
		expect(store.delete).toHaveBeenCalledWith('org:org_1:page:abc')
		expect(store.delete).toHaveBeenCalledWith('org:acme:page:abc')
	})

	it('reports true when there is nothing to purge it with', async () => {
		bindSiteDataKV(kv() as never)
		await expect(purgeOrganizationSiteCache('org_1')).resolves.toBe(true)
	})

	it('reports false when a key could not be deleted', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		bindSiteDataKV(
			kv({
				list: vi.fn(async () => ({
					keys: [{ name: 'org:org_1:page:abc' }],
					list_complete: true,
				})),
				delete: vi.fn(async () => {
					throw new Error('KV unavailable')
				}),
			}) as never,
		)
		await expect(purgeOrganizationSiteCache('org_1')).resolves.toBe(false)
	})

	it('does not throw when KV is down, and logs the id and message only', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		bindSiteDataKV(
			kv({
				list: vi.fn(async () => {
					throw new Error('KV unavailable')
				}),
			}) as never,
		)
		await expect(purgeOrganizationSiteCache('org_1', 'acme')).resolves.toBe(
			false,
		)
		// One log per prefix that failed (organization id and slug here), saying
		// which kind of prefix it was.
		expect(error).toHaveBeenCalledTimes(2)
		expect(error.mock.calls[0]).toEqual([
			'Failed to purge site KV cache (id prefix) for organization org_1',
			'Error: KV unavailable',
		])
		expect(error.mock.calls[1]?.[0]).toContain('(slug prefix)')
	})

	it('still purges the slug and host prefixes when the organization id prefix fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const store = kv({
			list: vi.fn(async ({ prefix }: { prefix: string }) => {
				if (prefix === 'org:org_1:') throw new Error('KV unavailable')
				return { keys: [{ name: `${prefix}page:abc` }], list_complete: true }
			}),
		})
		bindSiteDataKV(store as never)
		await expect(
			purgeOrganizationSiteCache('org_1', 'acme', 'shop.example.com'),
		).resolves.toBe(false)
		expect(store.delete).toHaveBeenCalledWith('org:acme:page:abc')
		expect(store.delete).toHaveBeenCalledWith('org:shop.example.com:page:abc')
		expect(store.delete).not.toHaveBeenCalledWith('org:org_1:page:abc')
	})
})

describe('site cache versioning', () => {
	it('a read that raced a publish cannot cache the old page after the purge', async () => {
		bindSiteDataKV(memoryKv() as never)
		// A visitor misses the cache and reads the page before the publish.
		const version = await getSiteCacheVersion('org_1')
		expect(version).not.toBeNull()
		const key = getSiteKvKey('page', 'org_1', 'home', version!)
		expect(await getCachedSiteData(key)).toBeNull()
		const oldPage = { title: 'Old' }

		// The publish commits and purges before the visitor stores its copy.
		await expect(purgeOrganizationSiteCache('org_1')).resolves.toBe(true)
		await setCachedSiteData(key, oldPage, { orgId: 'org_1', version: version! })

		// The next visitor must not get the old page.
		const next = await getSiteCacheVersion('org_1')
		expect(
			await getCachedSiteData(getSiteKvKey('page', 'org_1', 'home', next!)),
		).toBeNull()
	})

	it('caches and serves a page when nothing changed', async () => {
		bindSiteDataKV(memoryKv() as never)
		const version = (await getSiteCacheVersion('org_1'))!
		const key = getSiteKvKey('page', 'org_1', 'home', version)
		await setCachedSiteData(key, { title: 'Home' }, { orgId: 'org_1', version })
		expect(await getCachedSiteData(key)).toEqual({ title: 'Home' })
	})

	it('reports false when the version cannot be bumped', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		bindSiteDataKV(
			kv({
				put: vi.fn(async () => {
					throw new Error('KV unavailable')
				}),
			}) as never,
		)
		await expect(purgeOrganizationSiteCache('org_1')).resolves.toBe(false)
	})
})
