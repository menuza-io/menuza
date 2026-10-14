import { type LaborRules } from './rules.ts'
import {
	addDays,
	businessDateOf,
	businessDayStartMs,
	floorToMinute,
	minutesBetween,
	tzOffsetMs,
	weekStartFor,
} from './tz.ts'

/**
 * Time math: the single implementation behind schedule footers, timesheets,
 * reports, and exports, so they cannot disagree. Everything is in whole minutes
 * and integer basis points; money is integer minor units. Figures are
 * ESTIMATES (the result carries `estimate: true`): they are not payroll.
 *
 * Instants are epoch milliseconds. Business dates (`YYYY-MM-DD`) are in the
 * scope timezone and honor `rules.workdayStartMinute`.
 */

export type TimeBreak = {
	startAt: number
	/** `null` means the break is still open. */
	endAt: number | null
	paid: boolean
}

export type TimeEntryInput = {
	id: string
	scopeId: string
	clockInAt: number
	/** `null` means the entry is still open. */
	clockOutAt: number | null
	breaks?: readonly TimeBreak[]
	/** A person authorized to waive breaks suppresses the automatic deduction. */
	breakWaived?: boolean
	/** Rate snapshot in minor units per hour; absent means "no cost figure". */
	rateMinor?: number | null
	currency?: string | null
	/** Exempt staff accrue regular minutes only. */
	overtimeExempt?: boolean
}

export type TimeContext = {
	timeZone: string
	/** Used to measure open entries; without it an open entry counts as zero. */
	nowMs?: number
}

export type TimecardIssue =
	| 'open_entry'
	| 'open_break'
	| 'negative_duration'
	| 'long_shift'
	| 'break_outside_entry'
	| 'overlapping_breaks'
	| 'auto_break_deducted'

export type TimeSlice = {
	/** Business date this slice of worked time belongs to. */
	date: string
	startAt: number
	endAt: number
	minutes: number
}

export type Timecard = {
	entryId: string
	scopeId: string
	/** Business date of the (rounded) clock-in; null when nothing is computable. */
	businessDate: string | null
	clockInAt: number
	clockOutAt: number | null
	open: boolean
	/** Minutes from rounded clock-in to rounded clock-out, breaks included. */
	elapsedMinutes: number
	unpaidBreakMinutes: number
	paidBreakMinutes: number
	/** Paid worked minutes: elapsed minus unpaid breaks. */
	workedMinutes: number
	/** Worked time split at business-day boundaries. */
	slices: TimeSlice[]
	issues: TimecardIssue[]
}

type Interval = readonly [number, number]

const MS_PER_MINUTE = 60_000

/** Round an instant to an increment of local wall-clock minutes. */
export function roundInstant(
	ms: number,
	rounding: LaborRules['rounding'],
	timeZone: string,
): number {
	const base = floorToMinute(ms)
	if (rounding.mode === 'none' || rounding.incrementMinutes <= 1) return base
	const offset = tzOffsetMs(base, timeZone)
	const localMinutes = (base + offset) / MS_PER_MINUTE
	const inc = rounding.incrementMinutes
	const exact = ms + offset
	let rounded: number
	switch (rounding.mode) {
		case 'down':
			rounded = Math.floor(localMinutes / inc) * inc
			break
		case 'up':
			// Anything past the boundary, even by seconds, rounds up.
			rounded = Math.ceil(exact / MS_PER_MINUTE / inc) * inc
			break
		default:
			rounded = Math.round(exact / MS_PER_MINUTE / inc) * inc
	}
	return rounded * MS_PER_MINUTE - offset
}

function mergeIntervals(intervals: Interval[]): {
	merged: Interval[]
	overlapped: boolean
} {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])
	const merged: [number, number][] = []
	let overlapped = false
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1]
		if (last && start < last[1]) {
			overlapped = true
			last[1] = Math.max(last[1], end)
		} else if (last && start === last[1]) {
			last[1] = end
		} else {
			merged.push([start, end])
		}
	}
	return { merged, overlapped }
}

function subtractIntervals(
	base: Interval,
	holes: readonly Interval[],
): Interval[] {
	const result: Interval[] = []
	let cursor = base[0]
	for (const [start, end] of holes) {
		if (end <= cursor) continue
		if (start >= base[1]) break
		if (start > cursor) result.push([cursor, start])
		cursor = Math.max(cursor, end)
	}
	if (cursor < base[1]) result.push([cursor, base[1]])
	return result
}

/** Split an interval at business-day boundaries. */
function sliceByBusinessDate(
	[start, end]: Interval,
	timeZone: string,
	workdayStartMinute: number,
): TimeSlice[] {
	const slices: TimeSlice[] = []
	let cursor = start
	let date = businessDateOf(cursor, timeZone, workdayStartMinute)
	// A day is never shorter than 20 hours, so this bound only guards against a
	// misbehaving zone database.
	for (let guard = 0; cursor < end && guard < 400; guard++) {
		const nextStart = businessDayStartMs(
			addDays(date, 1),
			timeZone,
			workdayStartMinute,
		)
		const sliceEnd = Math.min(end, nextStart)
		if (sliceEnd > cursor) {
			slices.push({
				date,
				startAt: cursor,
				endAt: sliceEnd,
				minutes: minutesBetween(cursor, sliceEnd),
			})
		}
		cursor = Math.max(sliceEnd, cursor + 1)
		date = addDays(date, 1)
	}
	return slices
}

/**
 * Compute one time card. Rounding is applied here, at calculation time; the raw
 * punches stay untouched in the caller's data. Unpaid breaks are clipped to the
 * entry and merged; an unpaid break recorded by the clock suppresses the
 * automatic deduction.
 */
export function computeTimecard(
	entry: TimeEntryInput,
	rules: LaborRules,
	ctx: TimeContext,
): Timecard {
	const issues: TimecardIssue[] = []
	const open = entry.clockOutAt === null
	const rawEnd = open ? (ctx.nowMs ?? null) : entry.clockOutAt
	if (open) issues.push('open_entry')

	const clockInAt = roundInstant(entry.clockInAt, rules.rounding, ctx.timeZone)
	const empty = (clockOutAt: number | null): Timecard => ({
		entryId: entry.id,
		scopeId: entry.scopeId,
		businessDate: businessDateOf(
			clockInAt,
			ctx.timeZone,
			rules.workdayStartMinute,
		),
		clockInAt,
		clockOutAt,
		open,
		elapsedMinutes: 0,
		unpaidBreakMinutes: 0,
		paidBreakMinutes: 0,
		workedMinutes: 0,
		slices: [],
		issues,
	})

	if (rawEnd === null) return empty(null)
	const clockOutAt = roundInstant(rawEnd, rules.rounding, ctx.timeZone)
	if (clockOutAt < clockInAt) {
		issues.push('negative_duration')
		return empty(clockOutAt)
	}

	const window: Interval = [clockInAt, clockOutAt]
	const unpaid: Interval[] = []
	const paid: Interval[] = []
	for (const b of entry.breaks ?? []) {
		if (b.endAt === null) issues.push('open_break')
		const rawBreakEnd = b.endAt ?? rawEnd
		const start = floorToMinute(b.startAt)
		const end = floorToMinute(rawBreakEnd)
		if (start < window[0] || end > window[1]) issues.push('break_outside_entry')
		const clipped: Interval = [
			Math.max(start, window[0]),
			Math.min(end, window[1]),
		]
		if (clipped[1] <= clipped[0]) continue
		;(b.paid ? paid : unpaid).push(clipped)
	}

	const unpaidMerged = mergeIntervals(unpaid)
	if (unpaidMerged.overlapped) issues.push('overlapping_breaks')
	let unpaidIntervals = unpaidMerged.merged

	const elapsedMinutes = minutesBetween(clockInAt, clockOutAt)
	const auto = rules.autoBreakDeduction
	if (
		auto &&
		!entry.breakWaived &&
		unpaidIntervals.length === 0 &&
		elapsedMinutes >= auto.afterMinutes
	) {
		// Presume the break happened by the end of the qualifying stretch.
		const end = clockInAt + auto.afterMinutes * MS_PER_MINUTE
		const start = Math.max(clockInAt, end - auto.deductMinutes * MS_PER_MINUTE)
		unpaidIntervals = [[start, end]]
		issues.push('auto_break_deducted')
	}

	const unpaidBreakMinutes = unpaidIntervals.reduce(
		(sum, [s, e]) => sum + minutesBetween(s, e),
		0,
	)
	const paidBreakMinutes = mergeIntervals(paid).merged.reduce(
		(sum, [s, e]) => sum + minutesBetween(s, e),
		0,
	)

	const slices = subtractIntervals(window, unpaidIntervals).flatMap(
		(interval) =>
			sliceByBusinessDate(interval, ctx.timeZone, rules.workdayStartMinute),
	)
	const workedMinutes = slices.reduce((sum, s) => sum + s.minutes, 0)
	if (workedMinutes > rules.longShiftMinutes) issues.push('long_shift')

	return {
		entryId: entry.id,
		scopeId: entry.scopeId,
		businessDate: businessDateOf(
			clockInAt,
			ctx.timeZone,
			rules.workdayStartMinute,
		),
		clockInAt,
		clockOutAt,
		open,
		elapsedMinutes,
		unpaidBreakMinutes,
		paidBreakMinutes,
		workedMinutes,
		slices,
		issues: [...new Set(issues)],
	}
}

export type MinuteBuckets = {
	regular: number
	/** Daily plus weekly overtime. */
	overtime: number
	doubleTime: number
	holiday: number
	total: number
}

const emptyBuckets = (): MinuteBuckets => ({
	regular: 0,
	overtime: 0,
	doubleTime: 0,
	holiday: 0,
	total: 0,
})

export type WeekDay = MinuteBuckets & { date: string }

/**
 * What one entry cost in one week, before rounding. `units` is
 * minutes x (minor units per hour) x basis points; divide by
 * `COST_UNITS_PER_MINOR` for minor units. Summing units across entries and
 * rounding once keeps a person's total from drifting by a cent per card.
 */
export type EntryCost = {
	units: number
	currency: string | null
	/** Worked minutes of this entry that had no rate (or no currency). */
	unpricedMinutes: number
}

/** minutes x minor-per-hour x basis points => minor units: 60 x 10000. */
export const COST_UNITS_PER_MINOR = 600_000

export function costUnitsToMinor(units: number): number {
	return Math.round(units / COST_UNITS_PER_MINOR)
}

export type WeekSummary = MinuteBuckets & {
	/** Always true: these are estimates, never payroll. */
	estimate: true
	weekStartDate: string
	weekEndDate: string
	days: WeekDay[]
	entries: Record<string, MinuteBuckets>
	/** Per-entry cost for the minutes of that entry that fall in this week. */
	entryCost: Record<string, EntryCost>
	/** Estimated pay in minor units, never added across currencies. */
	payMinorByCurrency: Record<string, number>
	/** Worked minutes that had no rate (or no currency) and so no cost figure. */
	unpricedMinutes: number
	/** Minutes of entries that fall in other weeks (week-boundary spillover). */
	outsideWeekMinutes: number
	timecards: Timecard[]
}

type WorkSlice = TimeSlice & {
	entryId: string
	scopeId: string
	rateMinor: number | null
	currency: string | null
	exempt: boolean
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

/**
 * Compute one workweek for one person. `weekStartDate` must be the first day of
 * a workweek (use `weekStartFor`). Entries are split at business-day
 * boundaries, so a shift that crosses the week boundary contributes only its
 * in-week minutes here and the rest to the neighboring week.
 *
 * Allocation, in chronological order:
 *  1. Holiday dates: minutes are `holiday` and count toward no threshold.
 *  2. Daily: minutes past the daily overtime threshold are overtime, and past
 *     the double-time threshold are double time.
 *  3. Weekly: regular minutes past the weekly threshold become overtime. Minutes
 *     already paid as daily overtime are not counted twice.
 *  Exempt entries only ever accrue regular minutes.
 * With `aggregateOvertimeAcrossScopes` false, each scope is evaluated on
 * its own; with true, all scopes share one set of thresholds.
 */
export function computeWeek(
	entries: readonly TimeEntryInput[],
	rules: LaborRules,
	ctx: TimeContext & { weekStartDate: string },
): WeekSummary {
	if (
		weekStartFor(ctx.weekStartDate, rules.weekStartsOn) !== ctx.weekStartDate
	) {
		throw new RangeError(
			`weekStartDate ${ctx.weekStartDate} is not a week start for weekStartsOn=${rules.weekStartsOn}`,
		)
	}
	const dates = Array.from({ length: 7 }, (_, i) =>
		addDays(ctx.weekStartDate, i),
	)
	const dateSet = new Set(dates)
	const holidays = new Set(rules.holiday.dates)

	const timecards = entries.map((entry) => computeTimecard(entry, rules, ctx))
	const byId = new Map(entries.map((e) => [e.id, e]))

	const slices: WorkSlice[] = []
	let outsideWeekMinutes = 0
	for (const card of timecards) {
		const entry = byId.get(card.entryId)!
		for (const slice of card.slices) {
			if (!dateSet.has(slice.date)) {
				outsideWeekMinutes += slice.minutes
				continue
			}
			slices.push({
				...slice,
				entryId: card.entryId,
				scopeId: card.scopeId,
				rateMinor: entry.rateMinor ?? null,
				currency: entry.currency ?? null,
				exempt: entry.overtimeExempt === true,
			})
		}
	}
	slices.sort(
		(a, b) => a.startAt - b.startAt || a.entryId.localeCompare(b.entryId),
	)

	const days = new Map<string, WeekDay>(
		dates.map((date) => [date, { date, ...emptyBuckets() }]),
	)
	const entryBuckets: Record<string, MinuteBuckets> = {}
	const entryCost: Record<string, EntryCost> = {}
	const costUnits = new Map<string, number>()
	let unpricedMinutes = 0

	// Threshold state is per partition (per scope, or one shared partition).
	const dayTotals = new Map<string, number>()
	const weekRegular = new Map<string, number>()

	const dailyOt = rules.dailyOvertime
	const dailyDt = rules.dailyDoubleTime
	const weekly = rules.weeklyOvertime
	// Double time without a daily overtime rule still starts at its own threshold.
	const otStart =
		dailyOt?.thresholdMinutes ?? dailyDt?.thresholdMinutes ?? Infinity
	const dtStart = dailyDt?.thresholdMinutes ?? Infinity

	for (const slice of slices) {
		const partition = rules.aggregateOvertimeAcrossScopes
			? 'all'
			: slice.scopeId
		const dayKey = `${partition}|${slice.date}`
		const m = slice.minutes

		let regular = 0
		let dailyOtMinutes = 0
		let weeklyOtMinutes = 0
		let dt = 0
		let holiday = 0

		if (holidays.has(slice.date)) {
			holiday = m
		} else if (slice.exempt) {
			regular = m
		} else {
			const before = dayTotals.get(dayKey) ?? 0
			const after = before + m
			const regularDaily = clamp(otStart - before, 0, m)
			dt = clamp(after - Math.max(before, dtStart), 0, m)
			dailyOtMinutes = m - regularDaily - dt
			dayTotals.set(dayKey, after)

			if (weekly) {
				const used = weekRegular.get(partition) ?? 0
				const allowed = Math.max(0, weekly.thresholdMinutes - used)
				regular = Math.min(regularDaily, allowed)
				weeklyOtMinutes = regularDaily - regular
				weekRegular.set(partition, used + regular)
			} else {
				regular = regularDaily
			}
		}

		const overtime = dailyOtMinutes + weeklyOtMinutes
		for (const target of [
			days.get(slice.date)!,
			(entryBuckets[slice.entryId] ??= emptyBuckets()),
		]) {
			target.regular += regular
			target.overtime += overtime
			target.doubleTime += dt
			target.holiday += holiday
			target.total += m
		}

		const cost = (entryCost[slice.entryId] ??= {
			units: 0,
			currency: slice.currency,
			unpricedMinutes: 0,
		})
		if (slice.rateMinor === null || slice.currency === null) {
			unpricedMinutes += m
			cost.unpricedMinutes += m
		} else {
			const units =
				slice.rateMinor *
				(regular * 10_000 +
					dailyOtMinutes * (dailyOt?.multiplierBp ?? 10_000) +
					weeklyOtMinutes * (weekly?.multiplierBp ?? 10_000) +
					dt * (dailyDt?.multiplierBp ?? 10_000) +
					holiday * rules.holiday.multiplierBp)
			costUnits.set(
				slice.currency,
				(costUnits.get(slice.currency) ?? 0) + units,
			)
			cost.units += units
		}
	}

	const totals = emptyBuckets()
	for (const day of days.values()) {
		totals.regular += day.regular
		totals.overtime += day.overtime
		totals.doubleTime += day.doubleTime
		totals.holiday += day.holiday
		totals.total += day.total
	}

	const payMinorByCurrency: Record<string, number> = {}
	for (const [currency, units] of costUnits) {
		// minutes x (minor units per hour) x basis points => divide by 60 x 10000.
		payMinorByCurrency[currency] = costUnitsToMinor(units)
	}

	return {
		estimate: true,
		weekStartDate: ctx.weekStartDate,
		weekEndDate: dates[6]!,
		...totals,
		days: [...days.values()],
		entries: entryBuckets,
		entryCost,
		payMinorByCurrency,
		unpricedMinutes,
		outsideWeekMinutes,
		timecards,
	}
}
