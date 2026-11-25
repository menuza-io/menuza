import { plannedMinutes, planMissedWindows } from '@repo/common/missed-sales'
import {
	type ReportDefinition,
	type ReportRecord,
	resolveTimeframeRange,
} from '@repo/reports'
import { type TenantDatabase } from '@repo/tenant-db'
import { getOrderingHistory } from '../lib/ordering-history.ts'
import { estimateMissedSales } from './missed-sales-service.ts'

/**
 * Records for the Estimated missed online sales report (#176): one per staff
 * pause that started in the period, with the estimate of web and QR sales that
 * did not come in while it lasted (the same estimate the Orders page shows).
 * An estimate, never real sales: the subject says so and no total ever adds it
 * to a sales figure. A pause with fewer than two comparable weeks has no
 * estimate and shows "not enough history" as an empty figure. Busy mode is not
 * a pause and has no row.
 */

export class OrderingHistoryUnavailableError extends Error {
	constructor() {
		super('history_unavailable')
		this.name = 'OrderingHistoryUnavailableError'
	}
}

const WEEK_MS = 7 * 86_400_000
/** The estimate looks 4 weeks back; one more week of margin for the window edge. */
const LOOKBACK_MS = 5 * WEEK_MS

export async function loadMissedSalesRecords(
	ctx: {
		db: TenantDatabase
		orgId: string
		locationIds: readonly string[] | null
		now: Date
	},
	definition: ReportDefinition,
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		ctx.now,
		definition.timeframe,
	)
	const to = Math.min(range.end.getTime(), ctx.now.getTime())
	const from = range.start ? range.start.getTime() : to - 90 * 86_400_000
	if (to <= from) return { records: [], truncated: false }
	const history = await getOrderingHistory(ctx.orgId, {
		from: from - LOOKBACK_MS,
		to,
	})
	if (!history) throw new OrderingHistoryUnavailableError()
	const allowed = ctx.locationIds === null ? null : new Set(ctx.locationIds)
	const records: ReportRecord[] = []
	for (const location of history.locations) {
		if (allowed && !allowed.has(location.id)) continue
		const off = [...location.pauses, ...location.closures]
		for (const pause of location.pauses) {
			if (pause.from < from || pause.from > to) continue
			const plans = planMissedWindows({
				pause,
				openWindows: location.openWindows,
				otherOffWindows: off,
				timeZone: location.timezone,
				now: ctx.now.getTime(),
			})
			if (plans.length === 0) continue
			const answers = await estimateMissedSales(
				ctx.db,
				{
					orgId: ctx.orgId,
					locationId: location.id,
					currency: location.currency,
				},
				plans.map((plan, index) => ({
					id: String(index),
					from: plan.from,
					to: plan.to,
					weeks: plan.weeks,
				})),
			)
			const enough = answers.every((answer) => answer.enough)
			const record: ReportRecord = {
				startedAt: new Date(pause.from),
				location: location.name,
				locationId: location.id,
				currency: location.currency,
				minutesPaused: plannedMinutes(plans),
				weeksUsed: Math.min(...answers.map((answer) => answer.weeksUsed)),
			}
			if (enough) {
				record.estimatedOrders = answers.reduce(
					(sum, answer) => sum + (answer.enough ? answer.orders : 0),
					0,
				)
				record.estimatedSales =
					answers.reduce(
						(sum, answer) => sum + (answer.enough ? answer.salesMinor : 0),
						0,
					) / 100
			}
			records.push(record)
		}
	}
	return { records, truncated: false }
}
