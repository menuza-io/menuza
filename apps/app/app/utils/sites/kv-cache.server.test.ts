import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	bindSiteDataKV,
	purgeOrganizationSiteCache,
} from './kv-cache.server.ts'

function kv(overrides: Partial<Record<'list' | 'delete', unknown>> = {}) {
	return {
		list: vi.fn(async () => ({ keys: [], list_complete: true })),
		delete: vi.fn(async () => {}),
		...overrides,
	}
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
