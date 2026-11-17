import { SALES_BASIS_VALUES } from '@repo/common/sales-report-facts'
import { z } from 'zod'

/** A location the Today block can show, with the zone its business day follows. */
export type HomeLocation = { id: string; name: string; timeZone: string }

/**
 * Which Today tiles the viewer may see and where the numbers come from.
 * Control-plane facts only: the figures come from the regional tenant-api,
 * fetched by the browser with the reports token.
 */
export type TodayAccess = {
	available: boolean
	/** Sales, orders, average order value and guests: the order report grant. */
	orders: boolean
	/** Covers: Reservations on and `read:reservation:any`. */
	covers: boolean
	locations: HomeLocation[]
	/** Locations the covers tile may read (the viewer's reservation locations). */
	coverLocationIds: string[]
	tokenUrl: string
	tenantApiUrl: string | null
	/** The viewer's saved gross or net preference (#331). */
	reportSalesBasis: (typeof SALES_BASIS_VALUES)[number]
	reportSalesBasisUrl: string
}

export const NO_TODAY_ACCESS: TodayAccess = {
	available: false,
	orders: false,
	covers: false,
	locations: [],
	coverLocationIds: [],
	tokenUrl: '',
	tenantApiUrl: null,
	reportSalesBasis: 'net',
	reportSalesBasisUrl: '',
}

const currencyTotalsSchema = z.object({
	currency: z.string().min(1).max(8),
	salesMinor: z.number().finite(),
	orders: z.number().int().nonnegative(),
})
export type CurrencyTotals = z.infer<typeof currencyTotalsSchema>

export const todayTotalsSchema = z.object({
	today: z.array(currencyTotalsSchema),
	yesterday: z.array(currencyTotalsSchema),
	lastWeek: z.array(currencyTotalsSchema),
	guests: z.object({
		total: z.number().int().nonnegative(),
		firstTime: z.number().int().nonnegative(),
		returning: z.number().int().nonnegative(),
	}),
	asOf: z.string().optional(),
})
export type TodayTotals = z.infer<typeof todayTotalsSchema>

/** Where the home location picker is remembered, per user and organization. */
export function homeLocationStorageKey(userId: string, organizationId: string) {
	return `home-location:${userId}:${organizationId}`
}

/** The value `localStorage` keeps for "All locations". */
export const ALL_LOCATIONS = 'all'

/**
 * The locations a picker value stands for: one location, or every location
 * the viewer may see. A stale value (a location since removed or out of the
 * viewer's scope) falls back to all.
 */
export function selectedLocations<T extends { id: string }>(
	locations: readonly T[],
	selection: string | null | undefined,
): T[] {
	if (selection && selection !== ALL_LOCATIONS) {
		const match = locations.find((location) => location.id === selection)
		if (match) return [match]
	}
	return [...locations]
}

export type SalesComparison =
	{ kind: 'none' } | { kind: 'change'; percent: number }

/**
 * Today's sales in one currency against an earlier period. With no sales in
 * that currency then, there is nothing to compare: "No sales then", never a
 * percentage.
 */
export function compareSales(
	today: number,
	earlier: readonly CurrencyTotals[],
	currency: string,
): SalesComparison {
	const before = earlier.find((row) => row.currency === currency)?.salesMinor
	if (!before) return { kind: 'none' }
	return {
		kind: 'change',
		percent: Math.round(((today - before) / before) * 100),
	}
}

/** Average order value in minor units, or null with no orders. */
export function averageOrderMinor(row: CurrencyTotals): number | null {
	return row.orders > 0 ? Math.round(row.salesMinor / row.orders) : null
}

/** Orders across currencies: a count, so it may be added up. */
export function totalOrders(rows: readonly CurrencyTotals[]): number {
	return rows.reduce((sum, row) => sum + row.orders, 0)
}

/**
 * The query for `GET /analytics/today`: each location with its own zone, so
 * the region counts each location's own business day.
 */
export function todayQuery(
	locations: readonly HomeLocation[],
	salesBasis: (typeof SALES_BASIS_VALUES)[number] = 'net',
): string {
	return new URLSearchParams({
		locationIds: locations.map((location) => location.id).join(','),
		timeZones: locations.map((location) => location.timeZone).join(','),
		salesBasis,
	}).toString()
}
