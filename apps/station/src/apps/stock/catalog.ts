import { STATION_CATALOG_STALE_MS, type StationCatalog } from '@repo/inventory'
import { StockApiError, type StockApi } from './api.ts'
import {
	loadCachedCatalog,
	saveCachedCatalog,
	type CachedCatalog,
} from './local.ts'

/**
 * The catalogue the Stock app works from (items, units, areas in shelf order,
 * count lists, counts in progress, suppliers, expected deliveries, waste
 * reasons; never prices or on-hand figures), kept on the tablet per location.
 *
 * It is asked for with `If-None-Match: "<version>"`: an unchanged catalogue
 * is a 304 with no body and only moves "checked at" forward. An old copy
 * still counts: past 24 hours the screen says so, and goes on.
 */

export type CatalogRefresh =
	| { kind: 'updated'; cached: CachedCatalog }
	| { kind: 'unchanged'; cached: CachedCatalog }
	| { kind: 'failed'; code: string; status: number }

/** Asks the region whether the catalogue changed and keeps the answer. */
export async function refreshCatalog(
	api: StockApi,
	origin: string,
	locationId: string,
	now = Date.now(),
): Promise<CatalogRefresh> {
	const before = await loadCachedCatalog(origin, locationId)
	try {
		const answer = await api.catalog(
			locationId,
			before?.catalog.locationId === locationId ? before.catalog.version : null,
		)
		if (answer.status === 'not_modified' && before) {
			const cached = { ...before, checkedAt: now }
			await saveCachedCatalog(origin, locationId, cached)
			return { kind: 'unchanged', cached }
		}
		if (answer.status === 'ok') {
			// Another location's catalogue is never adopted (a terminal moved while a call was out).
			if (answer.catalog.locationId !== locationId)
				return { kind: 'failed', code: 'wrong_location', status: 0 }
			const cached = { catalog: answer.catalog, checkedAt: now }
			await saveCachedCatalog(origin, locationId, cached)
			return { kind: 'updated', cached }
		}
		// A 304 with nothing to keep it for: ask again without the version.
		const again = await api.catalog(locationId, null)
		if (again.status === 'ok' && again.catalog.locationId === locationId) {
			const cached = { catalog: again.catalog, checkedAt: now }
			await saveCachedCatalog(origin, locationId, cached)
			return { kind: 'updated', cached }
		}
		return { kind: 'failed', code: 'invalid_response', status: 502 }
	} catch (failure) {
		return failure instanceof StockApiError
			? { kind: 'failed', code: failure.code, status: failure.status }
			: { kind: 'failed', code: 'connection_lost', status: 0 }
	}
}

/** Whether the copy was last confirmed current more than 24 hours ago. A clock moved back counts as fresh. */
export function isStale(checkedAt: number, now = Date.now()): boolean {
	return now - checkedAt > STATION_CATALOG_STALE_MS
}

/** The count lists, items and everything else by id, for lookups on every row. */
export type CatalogIndex = {
	items: Map<string, StationCatalog['items'][number]>
}

export function indexCatalog(catalog: StationCatalog): CatalogIndex {
	return { items: new Map(catalog.items.map((item) => [item.id, item])) }
}
