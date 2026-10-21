import {
	addDays,
	type BookedUnitFact,
	computeForecastGap,
	type ForecastDemandSource,
	type ForecastGapView,
	type ForecastQuery,
	type ForecastShiftFact,
	ORDERS_SOURCE_ID,
	startOfLocalDay,
} from '@repo/staffing'
import { loadLaborSettings } from './labor-data.ts'
import { type DemandSource, listDemandSources } from './demand-sources.ts'
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
 * The demand forecast against the schedule, for the week that holds `date`.
 * Each registered demand source (orders, visits) is forecast in its own unit:
 * the expected units of each hour are the demand guide's weekday median, never
 * fewer than what is already booked for that hour; the manager's standards per
 * unit turn them into the people each position needs, and the live schedule says who is there. All the
 * arithmetic is `computeForecastGap` in `@repo/staffing`.
 *
 * It carries no money and no names (people are counted, not listed), so it
 * needs the schedule and labor grants but not the pay grant. Drafts count: the
 * point is to see a gap before the week is published.
 */

/** Units already booked for a future hour of one registered demand source. */
async function loadBookedUnits(
	ctx: Pick<ScheduleContext, 'db' | 'now'>,
	source: DemandSource,
	scopeId: string,
	timeZone: string,
	weekStart: string,
): Promise<BookedUnitFact[]> {
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

	const registered = listDemandSources()
	const [settings, sources, rows] = await Promise.all([
		loadLaborSettings(ctx.db, query.scopeId),
		Promise.all(
			registered.map(async (source) => {
				const [guide, booked] = await Promise.all([
					loadDemandGuide(ctx, frame, weekStart, false, source.id),
					loadBookedUnits(
						ctx,
						source,
						query.scopeId,
						frame.timeZone,
						weekStart,
					),
				])
				return { source, guide, booked }
			}),
		),
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

	// Only positions the manager gave a standard to are forecast, per unit. With
	// no demand source registered (the generic module) the orders guide is still
	// shown, empty, as before.
	const inputs: ForecastDemandSource[] =
		sources.length > 0
			? sources.map(({ source, guide, booked }) => ({
					id: source.id,
					unit: source.unit,
					guide,
					booked,
					standards: settings.demandPerLaborHour[source.id] ?? {},
				}))
			: [
					{
						id: ORDERS_SOURCE_ID,
						unit: 'orders',
						guide: await loadDemandGuide(ctx, frame, weekStart, false),
						booked: [],
						standards: settings.ordersPerLaborHour,
					},
				]
	return ok(
		computeForecastGap({
			sources: inputs,
			shifts,
			timeZone: frame.timeZone,
		}),
	)
}
