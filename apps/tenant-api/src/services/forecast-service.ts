import {
	addDays,
	type BookedOrderFact,
	computeForecastGap,
	type ForecastGapView,
	type ForecastQuery,
	type ForecastShiftFact,
	startOfLocalDay,
} from '@repo/staffing'
import { loadLaborSettings } from './labor-data.ts'
import { getOrderSource } from './order-source.ts'
import {
	effectiveShift,
	FrameCache,
	isLive,
	loadScopeShifts,
	requireFrame,
	type ScheduleContext,
	type ScheduleResult,
	snapWeekStart,
} from './schedule-shared.ts'
import { loadDemandGuide } from './schedule-week-service.ts'
import { ok } from './timesheet-shared.ts'

/**
 * The orders-based forecast against the schedule, for the week that holds
 * `date`. The expected orders of each hour are the demand guide's weekday
 * median, never fewer than the paid, active orders already booked for that
 * hour; the manager's orders-per-labor-hour standards turn them into the people
 * each position needs, and the live schedule says who is there. All the
 * arithmetic is `computeForecastGap` in `@repo/staffing`.
 *
 * It carries no money and no names (people are counted, not listed), so it
 * needs the schedule and labor grants but not the pay grant. Drafts count: the
 * point is to see a gap before the week is published.
 */

/** Orders already placed for a future hour, from the registered order source (none by default). */
async function loadBookedOrders(
	ctx: Pick<ScheduleContext, 'db' | 'now'>,
	scopeId: string,
	timeZone: string,
	weekStart: string,
): Promise<BookedOrderFact[]> {
	const source = getOrderSource()
	if (!source) return []
	const nowSeconds = Math.floor(ctx.now / 1000)
	const fromSeconds = Math.max(
		nowSeconds,
		Math.floor(startOfLocalDay(weekStart, timeZone) / 1000),
	)
	const toSeconds = Math.ceil(
		startOfLocalDay(addDays(weekStart, 7), timeZone) / 1000,
	)
	if (toSeconds <= fromSeconds) return []
	return source.loadBooked(ctx.db, scopeId, {
		fromSeconds,
		toSeconds,
		timeZone,
	})
}

export async function loadForecastGap(
	ctx: ScheduleContext,
	query: ForecastQuery,
): Promise<ScheduleResult<ForecastGapView>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const frame = framed.value
	const weekStart = snapWeekStart(query.date, frame)
	const weekEnd = addDays(weekStart, 6)

	const [guide, settings, booked, rows] = await Promise.all([
		loadDemandGuide(ctx, frame, weekStart, false),
		loadLaborSettings(ctx.db, query.scopeId),
		loadBookedOrders(ctx, query.scopeId, frame.timeZone, weekStart),
		// The day before is read too: a shift that runs past midnight puts people
		// on the clock on the first morning.
		loadScopeShifts(ctx.db, query.scopeId, addDays(weekStart, -1), weekEnd),
	])
	const shifts: ForecastShiftFact[] = rows
		.map(effectiveShift)
		.filter(isLive)
		.map((shift) => ({
			staffId: shift.staffId,
			positionId: shift.positionId,
			startsAt: shift.startsAt,
			endsAt: shift.endsAt,
			unpaidBreakMinutes: shift.unpaidBreakMinutes,
		}))

	// Only positions the manager gave a standard to are forecast.
	return ok(
		computeForecastGap({
			guide,
			booked,
			standards: settings.ordersPerLaborHour,
			shifts,
			timeZone: frame.timeZone,
		}),
	)
}
