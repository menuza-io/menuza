import {
	type ReportDefinition,
	type ReportRecord,
	type ReportSubject,
	referencedFieldIds,
	resolveTimeframeRange,
} from '@repo/reports'
import { invSoldOut, menuAvailabilityEvents } from '@repo/tenant-db'
import { and, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { readItemSales } from './item-sales.ts'
import { type SalesReportContext } from './sales-report-records.ts'

/** Minimum sold units in the lookback window before showing a lost-sales estimate. */
export const SOLD_OUT_LOST_SALES_MIN_ORDERS = 10
export const SOLD_OUT_LOST_SALES_LOOKBACK_DAYS = 14

export type SoldOutOccurrence = {
	locationId: string
	entityType: string
	entityId: string
	source: 'automatic' | 'manual'
	startedAt: Date
	endedAt: Date | null
}

export type ManualAvailabilityEventRow = {
	locationId: string
	entityType: string
	entityId: string
	event: 'unavailable' | 'available'
	occurredAt: Date
}

/** Pairs manual unavailable/available events into sold-out windows. */
export function manualSoldOutOccurrencesFromEvents(
	eventRows: readonly ManualAvailabilityEventRow[],
): SoldOutOccurrence[] {
	const occurrences: SoldOutOccurrence[] = []
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
	return occurrences
}

function locationFilter(
	locationIds: readonly string[] | null,
	column:
		typeof invSoldOut.locationId | typeof menuAvailabilityEvents.locationId,
): SQL[] {
	if (locationIds === null) return []
	if (locationIds.length === 0) return [sql`0`]
	// bounded: analytics token locationIds mirror control-plane locations (well under 100).
	return [inArray(column, [...locationIds])]
}

function windowOf(definition: ReportDefinition, now: Date) {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	return {
		startMs: range.start ? range.start.getTime() : null,
		endMs: range.end.getTime(),
	}
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

/**
 * The sold-out windows (stock-driven and manual) at the token's locations.
 * By default the ones that started inside the window, as the history report
 * lists them. With `overlapping`, every one that was on at any time in it,
 * including one that began earlier (the slow sellers and uptime reports ask
 * how long a dish could not be ordered, not when it ran out). That read goes
 * back `OVERLAP_LOOKBACK_MS` before the window so a long sold-out is still
 * paired with its start.
 */
export const OVERLAP_LOOKBACK_MS = 90 * 86_400_000

export async function loadSoldOutOccurrences(
	ctx: SalesReportContext,
	window: { startMs: number | null; endMs: number },
	options: { overlapping?: boolean } = {},
): Promise<SoldOutOccurrence[]> {
	const readFrom =
		window.startMs === null
			? null
			: options.overlapping
				? window.startMs - OVERLAP_LOOKBACK_MS
				: window.startMs
	const occurrences: SoldOutOccurrence[] = []

	const invRows = await ctx.db
		.select()
		.from(invSoldOut)
		.where(
			and(
				...locationFilter(ctx.locationIds, invSoldOut.locationId),
				lte(invSoldOut.soldAt, window.endMs),
				readFrom !== null ? gte(invSoldOut.soldAt, readFrom) : undefined,
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
				lte(menuAvailabilityEvents.occurredAt, new Date(window.endMs)),
				readFrom !== null
					? gte(menuAvailabilityEvents.occurredAt, new Date(readFrom))
					: undefined,
			),
		)
		.orderBy(menuAvailabilityEvents.occurredAt)

	occurrences.push(
		...manualSoldOutOccurrencesFromEvents(
			eventRows.map((event) => ({
				locationId: event.locationId,
				entityType: event.entityType,
				entityId: event.entityId,
				event: event.event,
				occurredAt: event.occurredAt,
			})),
		),
	)
	if (!options.overlapping || window.startMs === null) return occurrences
	return occurrences.filter(
		(occurrence) =>
			occurrence.endedAt === null || occurrence.endedAt.getTime() >= window.startMs!,
	)
}

export async function loadSoldOutHistoryRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
	includeCost: boolean,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const fields = referencedFieldIds(subject, definition)
	const window = windowOf(definition, ctx.now)
	const occurrences = await loadSoldOutOccurrences(ctx, window)

	const lookbackEnd = new Date(window.endMs).toISOString().slice(0, 10)
	const lookbackStart = new Date(
		window.endMs - SOLD_OUT_LOST_SALES_LOOKBACK_DAYS * 86_400_000,
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
