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
		await purgeOrganizationSiteCache('org_1', 'acme')
		expect(store.delete).toHaveBeenCalledWith('org:org_1:page:abc')
		expect(store.delete).toHaveBeenCalledWith('org:acme:page:abc')
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
		await expect(
			purgeOrganizationSiteCache('org_1', 'acme'),
		).resolves.toBeUndefined()
		// One log per prefix that failed (organization id and slug here).
		expect(error).toHaveBeenCalledTimes(2)
		expect(error.mock.calls[0]).toEqual([
			'Failed to purge site KV cache for organization org_1',
			'KV unavailable',
		])
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
		).resolves.toBeUndefined()
		expect(store.delete).toHaveBeenCalledWith('org:acme:page:abc')
		expect(store.delete).toHaveBeenCalledWith('org:shop.example.com:page:abc')
		expect(store.delete).not.toHaveBeenCalledWith('org:org_1:page:abc')
	})
})
