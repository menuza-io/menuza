import {
	type ReportDefinition,
	type ReportRecord,
	type ReportSubject,
	referencedFieldIds,
	resolveTimeframeRange,
} from '@repo/reports'
import {
	invSoldOut,
	menuAvailabilityEvents,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { readItemSales, type ItemSalesQuery } from './item-sales.ts'
import { type SalesReportContext } from './sales-report-records.ts'

/** Minimum sold units in the lookback window before showing a lost-sales estimate. */
export const SOLD_OUT_LOST_SALES_MIN_ORDERS = 10
export const SOLD_OUT_LOST_SALES_LOOKBACK_DAYS = 14

type Occurrence = {
	locationId: string
	entityType: string
	entityId: string
	source: 'automatic' | 'manual'
	startedAt: Date
	endedAt: Date | null
}

function locationFilter(
	locationIds: readonly string[] | null,
	column: typeof invSoldOut.locationId,
): SQL[] {
	if (locationIds === null) return []
	if (locationIds.length === 0) return [sql`0`]
	return [inArray(column, [...locationIds])]
}

function estimateLostSales(
	itemId: string,
	locationId: string,
	durationMinutes: number,
	ratePerMinuteMinor: number | undefined,
): number | null {
	if (!ratePerMinuteMinor || ratePerMinuteMinor <= 0) return null
	return Math.round(ratePerMinuteMinor * durationMinutes)
}

export async function loadSoldOutHistoryRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
	includeCost: boolean,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const fields = referencedFieldIds(subject, definition)
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	const occurrences: Occurrence[] = []

	const invRows = await ctx.db
		.select()
		.from(invSoldOut)
		.where(
			and(
				...locationFilter(ctx.locationIds, invSoldOut.locationId),
				lte(invSoldOut.soldAt, range.end),
				range.start ? gte(invSoldOut.soldAt, range.start) : undefined,
			),
		)

	for (const row of invRows) {
		const startedAt = new Date(row.soldAt)
		const endedAt =
			row.state === 'undone' && row.undoneAt
				? new Date(row.undoneAt)
				: row.state === 'out'
					? null
					: new Date(row.updatedAt)
		occurrences.push({
			locationId: row.locationId,
			entityType: row.entityType,
			entityId: row.entityId,
			source: 'automatic',
			startedAt,
			endedAt,
		})
	}

	const eventRows = await ctx.db
		.select()
		.from(menuAvailabilityEvents)
		.where(
			and(
				...locationFilter(ctx.locationIds, menuAvailabilityEvents.locationId),
				lte(menuAvailabilityEvents.occurredAt, range.end),
				range.start
					? gte(menuAvailabilityEvents.occurredAt, range.start)
					: undefined,
			),
		)
		.orderBy(menuAvailabilityEvents.occurredAt)

	const openManual = new Map<string, Date>()
	for (const event of eventRows) {
		const key = `${event.locationId}\0${event.entityType}\0${event.entityId}`
		if (event.event === 'unavailable') {
			openManual.set(key, event.occurredAt)
		} else if (event.event === 'available') {
			const start = openManual.get(key)
			if (start) {
				occurrences.push({
					locationId: event.locationId,
					entityType: event.entityType,
					entityId: event.entityId,
					source: 'manual',
					startedAt: start,
					endedAt: event.occurredAt,
				})
				openManual.delete(key)
			}
		}
	}
	for (const [key, startedAt] of openManual) {
		const [locationId, entityType, entityId] = key.split('\0') as [
			string,
			string,
			string,
		]
		occurrences.push({
			locationId,
			entityType,
			entityId,
			source: 'manual',
			startedAt,
			endedAt: null,
		})
	}

	const lookbackEnd = range.end.toISOString().slice(0, 10)
	const lookbackStart = new Date(
		range.end.getTime() - SOLD_OUT_LOST_SALES_LOOKBACK_DAYS * 86_400_000,
	)
		.toISOString()
		.slice(0, 10)
	const salesByItem = new Map<string, { quantity: number; netMinor: number }>()
	if (includeCost && fields.has('lostSalesEstimate')) {
		const sales = await readItemSales(ctx.db, {
			fromDate: lookbackStart,
			toDate: lookbackEnd,
		})
		for (const row of sales.items) {
			const key = `${row.locationId}\0${row.itemId}`
			const existing = salesByItem.get(key) ?? { quantity: 0, netMinor: 0 }
			existing.quantity += row.quantity
			existing.netMinor += row.netSalesMinor
			salesByItem.set(key, existing)
		}
	}

	const records: ReportRecord[] = []
	for (const occurrence of occurrences) {
		const ended = occurrence.endedAt ?? ctx.now
		const durationMinutes = Math.max(
			0,
			Math.round((ended.getTime() - occurrence.startedAt.getTime()) / 60_000),
		)
		const record: ReportRecord = {
			startedAt: occurrence.startedAt,
			endedAt: occurrence.endedAt,
			locationId: occurrence.locationId,
			location: occurrence.locationId,
			entityType: occurrence.entityType,
			entityId: occurrence.entityId,
			source: occurrence.source,
			durationMinutes,
			currency: 'USD',
		}
		if (includeCost && fields.has('lostSalesEstimate')) {
			const stats = salesByItem.get(
				`${occurrence.locationId}\0${occurrence.entityId}`,
			)
			const rate =
				stats && stats.quantity >= SOLD_OUT_LOST_SALES_MIN_ORDERS
					? stats.netMinor /
						stats.quantity /
						(SOLD_OUT_LOST_SALES_LOOKBACK_DAYS * 24 * 60)
					: undefined
			const estimate = estimateLostSales(
				occurrence.entityId,
				occurrence.locationId,
				durationMinutes,
				rate,
			)
			if (estimate !== null) record.lostSalesEstimate = estimate / 100
		}
		records.push(record)
	}
	return { records, truncated: false }
}
