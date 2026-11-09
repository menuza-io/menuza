import 'fake-indexeddb/auto'
import { STATION_CATALOG_STALE_MS } from '@repo/inventory'
import { beforeEach, describe, expect, it } from 'vitest'
import { StockApiError } from './api.ts'
import { isStale, refreshCatalog } from './catalog.ts'
import { loadCachedCatalog } from './local.ts'
import { catalog, fakeApi, ORIGIN, resetStock } from './testing.ts'

beforeEach(resetStock)

describe('the catalogue copy on the tablet', () => {
	it('keeps the first answer and asks again with its version', async () => {
		const seen: Array<string | null> = []
		const api = fakeApi({
			async catalog(_location, version) {
				seen.push(version)
				return version === catalog.version
					? { status: 'not_modified' }
					: { status: 'ok', catalog }
			},
		})
		const first = await refreshCatalog(api, ORIGIN, 'main', 1_000)
		expect(first).toMatchObject({
			kind: 'updated',
			cached: { checkedAt: 1_000 },
		})
		const second = await refreshCatalog(api, ORIGIN, 'main', 9_000)
		expect(second).toMatchObject({
			kind: 'unchanged',
			cached: { checkedAt: 9_000 },
		})
		expect(seen).toEqual([null, catalog.version])
		const cached = await loadCachedCatalog(ORIGIN, 'main')
		expect(cached?.catalog.version).toBe(catalog.version)
		expect(cached?.checkedAt).toBe(9_000)
	})

	it('adopts a changed catalogue and forgets the old one', async () => {
		const api = fakeApi()
		await refreshCatalog(api, ORIGIN, 'main', 1)
		const changed = { ...catalog, version: 'cat-newversion01', items: [] }
		const next = fakeApi({
			async catalog() {
				return { status: 'ok', catalog: changed }
			},
		})
		await refreshCatalog(next, ORIGIN, 'main', 2)
		expect((await loadCachedCatalog(ORIGIN, 'main'))?.catalog.items).toEqual([])
	})

	it('keeps the copy when the refresh fails, and says why', async () => {
		await refreshCatalog(fakeApi(), ORIGIN, 'main', 1)
		const down = fakeApi({
			async catalog() {
				throw new StockApiError('service_unavailable', 503)
			},
		})
		expect(await refreshCatalog(down, ORIGIN, 'main', 2)).toEqual({
			kind: 'failed',
			code: 'service_unavailable',
			status: 503,
		})
		const cached = await loadCachedCatalog(ORIGIN, 'main')
		expect(cached).toMatchObject({ checkedAt: 1 })
	})

	it('never adopts another location’s catalogue', async () => {
		const api = fakeApi({
			async catalog() {
				return { status: 'ok', catalog: { ...catalog, locationId: 'other' } }
			},
		})
		expect(await refreshCatalog(api, ORIGIN, 'main', 1)).toMatchObject({
			kind: 'failed',
			code: 'wrong_location',
		})
		expect(await loadCachedCatalog(ORIGIN, 'main')).toBeUndefined()
	})

	it('keeps one copy per restaurant and location', async () => {
		await refreshCatalog(fakeApi(), ORIGIN, 'main', 1)
		expect(
			await loadCachedCatalog('https://other.test|x', 'main'),
		).toBeUndefined()
		expect(await loadCachedCatalog(ORIGIN, 'branch')).toBeUndefined()
	})

	it('warns past 24 hours, still usable, and never for a clock moved back', () => {
		const now = 10 * STATION_CATALOG_STALE_MS
		expect(isStale(now - STATION_CATALOG_STALE_MS + 1, now)).toBe(false)
		expect(isStale(now - STATION_CATALOG_STALE_MS - 1, now)).toBe(true)
		expect(isStale(now + 5_000, now)).toBe(false)
	})
})
