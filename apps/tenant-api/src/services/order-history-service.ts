import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	type SQL,
} from 'drizzle-orm'
import { z } from 'zod'

import { csvLines, EXPORT_CHUNK_ROWS } from '@repo/reports/export'
import {
	getTenantDb,
	restaurantOrders,
	type RestaurantOrder,
} from '@repo/tenant-db'

import { orderFailure, type OrderServiceResult } from './order-service.ts'

/**
 * Search, filter, paginate and export past orders (#224).
 *
 * Runs strictly in the regional tenant DB: search text (guest name, phone,
 * order number, dish name) never reaches the US App. Exports reuse the
 * formula-safe CSV writer from `@repo/reports/export`, omit guest name/phone
 * unless the operator holds the customer read grant, cap date ranges at 366
 * days and exports at 50,000 rows, and never total money across currencies.
 */

export const ORDER_HISTORY_MAX_DAYS = 366
export const ORDER_HISTORY_MAX_SPAN_MS = ORDER_HISTORY_MAX_DAYS * 86_400_000
export const ORDER_HISTORY_DEFAULT_PAGE_SIZE = 50
export const ORDER_HISTORY_EXPORT_MAX_ROWS = 50_000

export const ORDER_HISTORY_SORT_VALUES = [
	'created_desc',
	'created_asc',
	'total_desc',
	'total_asc',
] as const
export type OrderHistorySort = (typeof ORDER_HISTORY_SORT_VALUES)[number]

export const orderHistoryQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).optional(),
	status: z.string().trim().min(1).max(40).optional(),
	from: z.string().trim().min(1).max(40).optional(),
	to: z.string().trim().min(1).max(40).optional(),
	q: z.string().trim().max(120).optional(),
	fulfillment: z.enum(['pickup', 'delivery', 'dine_in']).optional(),
	channel: z.enum(['online', 'qr', 'catering']).optional(),
	paymentMethod: z.enum(['online', 'handoff']).optional(),
	taxExempt: z.enum(['true', 'false']).optional(),
	/** Card last four digits filter (#423), gated by `readPayments`. */
	cardLast4: z
		.string()
		.trim()
		.regex(/^\d{4}$/)
		.optional(),
	locationId: z.string().trim().min(1).max(100).optional(),
	sort: z.enum(ORDER_HISTORY_SORT_VALUES).optional(),
	cursor: z.string().trim().min(1).max(200).optional(),
})
export type OrderHistoryQuery = z.infer<typeof orderHistoryQuerySchema>

function parseDateBound(raw: string, endOfDay: boolean): Date | null {
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		return new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
	}
	const d = new Date(raw)
	return Number.isNaN(d.getTime()) ? null : d
}

function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString(
		'base64url',
	)
}

function decodeCursor(raw: string | undefined): number {
	if (!raw) return 0
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, 'base64url').toString('utf8'),
		) as { o?: unknown }
		if (
			typeof parsed.o === 'number' &&
			Number.isInteger(parsed.o) &&
			parsed.o >= 0
		) {
			return parsed.o
		}
	} catch {
		// ignore invalid cursor
	}
	return 0
}

function orderMatchesSearch(
	order: RestaurantOrder,
	qLower: string,
	canSearchCard: boolean,
): boolean {
	if (order.number.toLowerCase().includes(qLower)) return true
	if (order.contactName.toLowerCase().includes(qLower)) return true
	if (order.contactPhone.toLowerCase().includes(qLower)) return true
	const digitsOnly = qLower.replace(/\D/g, '')
	if (
		digitsOnly.length >= 4 &&
		order.contactPhone.replace(/\D/g, '').includes(digitsOnly)
	) {
		return true
	}
	if (
		canSearchCard &&
		digitsOnly.length === 4 &&
		order.cardLast4 &&
		order.cardLast4 === digitsOnly
	) {
		return true
	}
	if (Array.isArray(order.lines)) {
		for (const line of order.lines as Array<Record<string, unknown>>) {
			const name = String(line.itemName ?? line.name ?? '').toLowerCase()
			if (name.includes(qLower)) return true
		}
	}
	return false
}

function orderChannelOf(order: RestaurantOrder): 'online' | 'qr' | 'catering' {
	if (order.isCatering) return 'catering'
	if (order.tabId || order.fulfillment === 'dine_in') return 'qr'
	return 'online'
}

export type OrderHistoryPage = {
	orders: RestaurantOrder[]
	nextCursor: string | null
	totalCount: number
}

export async function queryOrderHistory(input: {
	orgId: string
	locationIds: string[] | null
	query: OrderHistoryQuery
	maxRows?: number
	/** Whether the caller holds payments read access (#423). */
	canSearchCard?: boolean
}): Promise<OrderServiceResult<OrderHistoryPage>> {
	const { orgId, locationIds, query, canSearchCard = false } = input

	const fromDate = query.from ? parseDateBound(query.from, false) : null
	const toDate = query.to ? parseDateBound(query.to, true) : null
	if (query.from && !fromDate) {
		return orderFailure(400, 'invalid_date', 'Invalid `from` date.')
	}
	if (query.to && !toDate) {
		return orderFailure(400, 'invalid_date', 'Invalid `to` date.')
	}
	if (fromDate && toDate) {
		if (toDate.getTime() < fromDate.getTime()) {
			return orderFailure(
				400,
				'invalid_date_range',
				'End date must be on or after start date.',
			)
		}
		if (toDate.getTime() - fromDate.getTime() > ORDER_HISTORY_MAX_SPAN_MS) {
			return orderFailure(
				422,
				'date_range_too_large',
				`Date range cannot exceed ${ORDER_HISTORY_MAX_DAYS} days.`,
			)
		}
	}

	// Enforce location scope strictly: a location-scoped operator cannot see
	// other locations' orders even if they pass another `locationId` in the query.
	let allowedLocations: string[] | null = locationIds
	if (query.locationId) {
		if (locationIds !== null && !locationIds.includes(query.locationId)) {
			return { ok: true, data: { orders: [], nextCursor: null, totalCount: 0 } }
		}
		allowedLocations = [query.locationId]
	}
	if (allowedLocations !== null && allowedLocations.length === 0) {
		return { ok: true, data: { orders: [], nextCursor: null, totalCount: 0 } }
	}

	const conditions: SQL[] = []
	if (allowedLocations !== null) {
		// bounded: the token's locations mirror the control plane's (well under 100).
		conditions.push(inArray(restaurantOrders.locationId, allowedLocations))
	}
	if (query.status) {
		conditions.push(
			eq(restaurantOrders.status, query.status as RestaurantOrder['status']),
		)
	}
	if (query.fulfillment) {
		conditions.push(eq(restaurantOrders.fulfillment, query.fulfillment))
	}
	if (query.paymentMethod) {
		conditions.push(eq(restaurantOrders.paymentMethod, query.paymentMethod))
	}
	if (query.taxExempt === 'true') {
		conditions.push(isNotNull(restaurantOrders.taxExemptRef))
	} else if (query.taxExempt === 'false') {
		conditions.push(isNull(restaurantOrders.taxExemptRef))
	}
	if (query.cardLast4 && canSearchCard) {
		conditions.push(eq(restaurantOrders.cardLast4, query.cardLast4))
	}
	if (fromDate) {
		conditions.push(gte(restaurantOrders.createdAt, fromDate))
	}
	if (toDate) {
		conditions.push(lte(restaurantOrders.createdAt, toDate))
	}
	if (query.channel === 'catering') {
		conditions.push(eq(restaurantOrders.isCatering, true))
	} else if (query.channel === 'qr') {
		conditions.push(isNotNull(restaurantOrders.tabId))
	} else if (query.channel === 'online') {
		conditions.push(eq(restaurantOrders.isCatering, false))
		conditions.push(isNull(restaurantOrders.tabId))
	}

	const sort = query.sort ?? 'created_desc'
	const orderBy =
		sort === 'created_asc'
			? [asc(restaurantOrders.createdAt), asc(restaurantOrders.id)]
			: sort === 'total_desc'
				? [desc(restaurantOrders.totalCents), desc(restaurantOrders.id)]
				: sort === 'total_asc'
					? [asc(restaurantOrders.totalCents), asc(restaurantOrders.id)]
					: [desc(restaurantOrders.createdAt), desc(restaurantOrders.id)]

	const db = await getTenantDb(orgId)
	const whereClause = conditions.length > 0 ? and(...conditions) : undefined

	const qLower = query.q?.trim().toLowerCase() ?? ''

	// Without a text search the database pages the rows itself: a page (and
	// every chunk of an export) reads only its own rows, never the whole view.
	if (!qLower && input.maxRows === undefined) {
		const pageSize = query.limit ?? ORDER_HISTORY_DEFAULT_PAGE_SIZE
		const offset = decodeCursor(query.cursor)
		const [counted] = await db
			.select({ n: count() })
			.from(restaurantOrders)
			.where(whereClause)
		const totalCount = Math.min(
			Number(counted?.n ?? 0),
			ORDER_HISTORY_EXPORT_MAX_ROWS + 1,
		)
		const page = await db
			.select()
			.from(restaurantOrders)
			.where(whereClause)
			.orderBy(...orderBy)
			.limit(pageSize)
			.offset(offset)
		return {
			ok: true,
			data: {
				orders: page,
				nextCursor:
					offset + pageSize < totalCount ? encodeCursor(offset + pageSize) : null,
				totalCount,
			},
		}
	}

	const rawRows = await db
		.select()
		.from(restaurantOrders)
		.where(whereClause)
		.orderBy(...orderBy)
		.limit((input.maxRows ?? ORDER_HISTORY_EXPORT_MAX_ROWS) + 1)

	const filtered = qLower
		? rawRows.filter((row) => orderMatchesSearch(row, qLower, canSearchCard))
		: rawRows

	if (input.maxRows !== undefined) {
		return {
			ok: true,
			data: {
				orders: filtered.slice(0, input.maxRows),
				nextCursor: null,
				totalCount: filtered.length,
			},
		}
	}

	const pageSize = query.limit ?? ORDER_HISTORY_DEFAULT_PAGE_SIZE
	const offset = decodeCursor(query.cursor)
	const page = filtered.slice(offset, offset + pageSize)
	const nextCursor =
		offset + pageSize < filtered.length ? encodeCursor(offset + pageSize) : null

	return {
		ok: true,
		data: {
			orders: page,
			nextCursor,
			totalCount: filtered.length,
		},
	}
}

function centsToMajorString(cents: number): string {
	return (cents / 100).toFixed(2)
}

function formatOrderDateParts(order: RestaurantOrder): {
	date: string
	time: string
	timeZone: string
} {
	const tz = order.locationTimezone || 'UTC'
	const d = order.createdAt ?? new Date()
	try {
		const date = new Intl.DateTimeFormat('en-CA', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(d)
		const time = new Intl.DateTimeFormat('en-GB', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		}).format(d)
		return { date, time, timeZone: tz }
	} catch {
		const iso = d.toISOString()
		return { date: iso.slice(0, 10), time: iso.slice(11, 19), timeZone: 'UTC' }
	}
}

function extractCouponCode(order: RestaurantOrder): string {
	const attr = order.attribution as { couponCode?: string } | null
	if (attr?.couponCode) return attr.couponCode
	if (Array.isArray(order.discounts)) {
		const withCode = order.discounts.find((d) => d.code)
		if (withCode?.code) return withCode.code
	}
	return ''
}

export type OrderHistoryExportResult = {
	csv: string
	rowCount: number
	truncated: boolean
}

const ORDER_EXPORT_MONEY_HEADER = [
	'Subtotal',
	'Discount',
	'Loyalty Reward',
	'Delivery Fee',
	'Service Fee',
	'Tax',
	'Tip',
	'Total',
]

export function orderExportHeader(includeCustomerPii: boolean): string[] {
	return [
		'Date',
		'Time',
		'Time Zone',
		'Order Number',
		'Status',
		'Type',
		'Channel',
		...(includeCustomerPii ? ['Guest Name', 'Guest Phone'] : []),
		...ORDER_EXPORT_MONEY_HEADER,
		'Payment Method',
		'Coupon Code',
		'Tax Exempt Ref',
		'Currency',
	]
}

export function orderExportRow(
	order: RestaurantOrder,
	includeCustomerPii: boolean,
): string[] {
	const { date, time, timeZone } = formatOrderDateParts(order)
	return [
		date,
		time,
		timeZone,
		order.number,
		order.status,
		order.fulfillment,
		orderChannelOf(order),
		...(includeCustomerPii ? [order.contactName, order.contactPhone] : []),
		centsToMajorString(order.subtotalCents),
		centsToMajorString(order.discountCents),
		centsToMajorString(order.loyaltyDiscountCents),
		centsToMajorString(order.deliveryFeeCents),
		centsToMajorString(order.serviceFeeCents),
		centsToMajorString(order.taxCents),
		centsToMajorString(order.tipCents),
		centsToMajorString(order.totalCents),
		order.paymentMethod,
		extractCouponCode(order),
		order.taxExemptRef ?? '',
		order.currency.toUpperCase(),
	]
}

/**
 * The closing rows of an export: a totals row (money is NEVER totalled across
 * currencies, #224) and, when the cap cut the result, the note saying so.
 */
export function orderExportFooter(input: {
	rows: readonly RestaurantOrder[]
	includeCustomerPii: boolean
	truncated: boolean
	limit: number
	matching: number
}): string[][] {
	const footer: string[][] = []
	const currencies = new Set(input.rows.map((o) => o.currency.toUpperCase()))
	if (input.rows.length > 0 && currencies.size === 1) {
		const sum = (pick: (o: RestaurantOrder) => number) =>
			centsToMajorString(input.rows.reduce((acc, o) => acc + pick(o), 0))
		footer.push([
			'Totals',
			'',
			'',
			String(input.rows.length),
			'',
			'',
			'',
			...(input.includeCustomerPii ? ['', ''] : []),
			sum((o) => o.subtotalCents),
			sum((o) => o.discountCents),
			sum((o) => o.loyaltyDiscountCents),
			sum((o) => o.deliveryFeeCents),
			sum((o) => o.serviceFeeCents),
			sum((o) => o.taxCents),
			sum((o) => o.tipCents),
			sum((o) => o.totalCents),
			'',
			'',
			'',
			[...currencies][0]!,
		])
	}
	if (input.truncated) {
		footer.push([
			`Export truncated to ${input.limit} rows. Narrow your date range or filters to export all ${input.matching} matching orders.`,
		])
	}
	return footer
}

export async function exportOrderHistoryCsv(input: {
	orgId: string
	locationIds: string[] | null
	query: OrderHistoryQuery
	includeCustomerPii: boolean
	maxRows?: number
}): Promise<OrderServiceResult<OrderHistoryExportResult>> {
	const limit = Math.min(
		input.maxRows ?? ORDER_HISTORY_EXPORT_MAX_ROWS,
		ORDER_HISTORY_EXPORT_MAX_ROWS,
	)
	const queried = await queryOrderHistory({
		orgId: input.orgId,
		locationIds: input.locationIds,
		query: input.query,
		maxRows: limit,
	})
	if (!queried.ok) return queried

	const truncated = queried.data.totalCount > limit
	const rows = queried.data.orders
	const body = [
		...rows.map((order) => orderExportRow(order, input.includeCustomerPii)),
		...orderExportFooter({
			rows,
			includeCustomerPii: input.includeCustomerPii,
			truncated,
			limit,
			matching: queried.data.totalCount,
		}),
	]
	return {
		ok: true,
		data: {
			csv: csvLines([orderExportHeader(input.includeCustomerPii), ...body]),
			rowCount: rows.length,
			truncated,
		},
	}
}

export type OrderHistoryExportChunk = {
	header: string[]
	rows: string[][]
	nextCursor: string | null
	total: number
	matching: number
	truncated: boolean
	footer: string[][] | null
}

/**
 * One page of the order history export (#386): the same rows, header and
 * closing rows as the one-shot file, read `chunkRows` at a time so the
 * browser can show progress and cancel. The footer (totals, the cut-off note)
 * rides on the last page and is computed over the whole capped view.
 */
export async function exportOrderHistoryChunk(input: {
	orgId: string
	locationIds: string[] | null
	query: OrderHistoryQuery
	includeCustomerPii: boolean
	canSearchCard?: boolean
	cursor?: string
	chunkRows?: number
	maxRows?: number
}): Promise<OrderServiceResult<OrderHistoryExportChunk>> {
	const cap = Math.min(
		input.maxRows ?? ORDER_HISTORY_EXPORT_MAX_ROWS,
		ORDER_HISTORY_EXPORT_MAX_ROWS,
	)
	const chunkRows = Math.min(
		Math.max(input.chunkRows ?? EXPORT_CHUNK_ROWS, 1),
		EXPORT_CHUNK_ROWS,
	)
	const offset = Math.min(decodeCursor(input.cursor), cap)
	const size = Math.min(chunkRows, cap - offset)
	const header = orderExportHeader(input.includeCustomerPii)

	const page = await queryOrderHistory({
		orgId: input.orgId,
		locationIds: input.locationIds,
		query: { ...input.query, limit: Math.max(size, 1), cursor: input.cursor },
		canSearchCard: input.canSearchCard,
	})
	if (!page.ok) return page
	const matching = page.data.totalCount
	const total = Math.min(matching, cap)
	const rows = size > 0 ? page.data.orders : []
	const done = offset + rows.length >= total || page.data.nextCursor === null
	const nextCursor = done ? null : encodeCursor(offset + rows.length)

	let footer: string[][] | null = null
	if (done) {
		// Totals cover the whole capped view, so the last page reads it once.
		const all = await queryOrderHistory({
			orgId: input.orgId,
			locationIds: input.locationIds,
			query: input.query,
			canSearchCard: input.canSearchCard,
			maxRows: cap,
		})
		if (!all.ok) return all
		footer = orderExportFooter({
			rows: all.data.orders,
			includeCustomerPii: input.includeCustomerPii,
			truncated: matching > cap,
			limit: cap,
			matching,
		})
	}
	return {
		ok: true,
		data: {
			header,
			rows: rows.map((order) =>
				orderExportRow(order, input.includeCustomerPii),
			),
			nextCursor,
			total,
			matching,
			truncated: matching > cap,
			footer,
		},
	}
}
