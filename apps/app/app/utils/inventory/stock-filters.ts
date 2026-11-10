/**
 * The Stock list's filters live in the URL, so a link, a reload and the back
 * button all keep them: `?q=chick&category=meat&area=<id>&low=1&limit=100`.
 * The location picker's `locationId` is kept untouched.
 */

export const STOCK_PAGE_SIZE = 50
export const STOCK_MAX_LIMIT = 200

export type StockFilters = {
	q: string
	category: string
	areaId: string
	/** "Low or out": items that need ordering. */
	lowOnly: boolean
	limit: number
}

export const NO_FILTER = 'all'

export function parseStockFilters(params: URLSearchParams): StockFilters {
	const rawLimit = Number(params.get('limit'))
	const limit =
		Number.isInteger(rawLimit) && rawLimit >= STOCK_PAGE_SIZE
			? Math.min(rawLimit, STOCK_MAX_LIMIT)
			: STOCK_PAGE_SIZE
	return {
		q: (params.get('q') ?? '').slice(0, 80),
		category: params.get('category') ?? NO_FILTER,
		areaId: params.get('area') ?? NO_FILTER,
		lowOnly: params.get('low') === '1',
		limit,
	}
}

export function hasActiveStockFilters(filters: StockFilters): boolean {
	return (
		filters.q.trim() !== '' ||
		filters.category !== NO_FILTER ||
		filters.areaId !== NO_FILTER ||
		filters.lowOnly
	)
}

/** `GET /items` path for the current filters at a location. */
export function stockListPath(
	filters: StockFilters,
	locationId: string,
): string {
	const params = new URLSearchParams({ locationId })
	if (filters.q.trim()) params.set('q', filters.q.trim())
	if (filters.category !== NO_FILTER) params.set('category', filters.category)
	if (filters.areaId !== NO_FILTER) params.set('areaId', filters.areaId)
	if (filters.lowOnly) params.set('status', 'attention')
	params.set('limit', String(filters.limit))
	return `/items?${params.toString()}`
}

export type StockFilterPatch = Partial<
	Pick<StockFilters, 'q' | 'category' | 'areaId' | 'lowOnly' | 'limit'>
>

/**
 * The next URL params after a filter change. Changing a filter goes back to
 * the first page; only an explicit `limit` ("Show more") keeps going.
 */
export function applyStockFilterPatch(
	current: URLSearchParams,
	patch: StockFilterPatch,
): URLSearchParams {
	const next = new URLSearchParams(current)
	const setOrDelete = (key: string, value: string | null) => {
		if (value === null || value === '') next.delete(key)
		else next.set(key, value)
	}
	if (patch.q !== undefined) setOrDelete('q', patch.q.trim() || null)
	if (patch.category !== undefined) {
		setOrDelete(
			'category',
			patch.category === NO_FILTER ? null : patch.category,
		)
	}
	if (patch.areaId !== undefined) {
		setOrDelete('area', patch.areaId === NO_FILTER ? null : patch.areaId)
	}
	if (patch.lowOnly !== undefined)
		setOrDelete('low', patch.lowOnly ? '1' : null)
	if (patch.limit !== undefined) {
		setOrDelete(
			'limit',
			patch.limit <= STOCK_PAGE_SIZE
				? null
				: String(Math.min(patch.limit, STOCK_MAX_LIMIT)),
		)
	} else {
		next.delete('limit')
	}
	return next
}

/** Clears every Stock filter and keeps the rest (for example `locationId`). */
export function clearStockFilters(current: URLSearchParams): URLSearchParams {
	const next = new URLSearchParams(current)
	for (const key of ['q', 'category', 'area', 'low', 'limit']) next.delete(key)
	return next
}
