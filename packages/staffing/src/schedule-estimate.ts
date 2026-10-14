import { type LaborRules } from './rules.ts'
import { localDateOf, startOfLocalDay } from './schedule-time.ts'
import {
	computeWeek,
	type TimeBreak,
	type TimeEntryInput,
	type WeekSummary,
} from './time-math.ts'
import { addDays, weekStartFor } from './tz.ts'

/**
 * Scheduled hours, overtime and cost, estimated by the same `computeWeek` the
 * timesheets use, so a schedule footer and a payroll summary cannot disagree on
 * how overtime is allocated. A scheduled shift is treated as a time card that
 * has not happened yet. Figures are estimates, never payroll.
 */

const MS_PER_MINUTE = 60_000

export type EstimateShift = {
	id: string
	scopeId: string
	startsAt: number
	endsAt: number
	unpaidBreakMinutes: number
	/** Rate in minor units per hour; absent means "no cost figure". */
	rateMinor?: number | null
	currency?: string | null
	overtimeExempt?: boolean
}

/**
 * The scope's labor rules, adjusted for planning: no rounding (nothing was
 * punched) and no automatic break deduction (the shift states its own unpaid
 * break), and no long-shift flag.
 */
export function planningRules(rules: LaborRules): LaborRules {
	return {
		...rules,
		rounding: { mode: 'none', incrementMinutes: 1 },
		autoBreakDeduction: null,
		longShiftMinutes: 48 * 60,
	}
}

/** A shift as a time card. Its unpaid break sits in the middle of the shift. */
export function shiftToEntry(shift: EstimateShift): TimeEntryInput {
	const duration = Math.max(
		0,
		Math.round((shift.endsAt - shift.startsAt) / MS_PER_MINUTE),
	)
	const breakMinutes = Math.min(Math.max(shift.unpaidBreakMinutes, 0), duration)
	const breaks: TimeBreak[] = []
	if (breakMinutes > 0) {
		const startAt =
			shift.startsAt + Math.floor((duration - breakMinutes) / 2) * MS_PER_MINUTE
		breaks.push({
			startAt,
			endAt: startAt + breakMinutes * MS_PER_MINUTE,
			paid: false,
		})
	}
	return {
		id: shift.id,
		scopeId: shift.scopeId,
		clockInAt: shift.startsAt,
		clockOutAt: shift.endsAt,
		breaks,
		rateMinor: shift.rateMinor ?? null,
		currency: shift.currency ?? null,
		overtimeExempt: shift.overtimeExempt ?? false,
	}
}

/** Paid minutes of a shift: its length minus the unpaid break. */
export function paidMinutesOf(shift: {
	startsAt: number
	endsAt: number
	unpaidBreakMinutes: number
}): number {
	const duration = Math.round((shift.endsAt - shift.startsAt) / MS_PER_MINUTE)
	return Math.max(0, duration - Math.max(0, shift.unpaidBreakMinutes))
}

/**
 * One workweek of one person's shifts, across every scope (so thresholds
 * that aggregate across scopes are right; the rules decide). Shifts that
 * start in an earlier week but run into this one count for their in-week part.
 */
export function estimateWeek(
	shifts: readonly EstimateShift[],
	rules: LaborRules,
	timeZone: string,
	weekStart: string,
): WeekSummary {
	const planning = planningRules(rules)
	return computeWeek(shifts.map(shiftToEntry), planning, {
		timeZone,
		weekStartDate: weekStart,
	})
}

/** Every workweek a set of shifts touches (by start and by end). */
export function weeksTouched(
	shifts: readonly { startsAt: number; endsAt: number }[],
	rules: Pick<LaborRules, 'weekStartsOn'>,
	timeZone: string,
): string[] {
	const weeks = new Set<string>()
	for (const shift of shifts) {
		weeks.add(
			weekStartFor(localDateOf(shift.startsAt, timeZone), rules.weekStartsOn),
		)
		weeks.add(
			weekStartFor(
				localDateOf(Math.max(shift.startsAt, shift.endsAt - 1), timeZone),
				rules.weekStartsOn,
			),
		)
	}
	return [...weeks].sort()
}

/**
 * Overtime minutes each shift contributes under the rules, summed over every
 * workweek the person's shifts touch. Only shifts with overtime appear.
 */
export function overtimeMinutesByShift(
	shifts: readonly EstimateShift[],
	rules: LaborRules,
	timeZone: string,
): Map<string, number> {
	const result = new Map<string, number>()
	if (shifts.length === 0) return result
	for (const week of weeksTouched(shifts, rules, timeZone)) {
		const summary = estimateWeek(shifts, rules, timeZone, week)
		for (const [id, buckets] of Object.entries(summary.entries)) {
			if (buckets.overtime + buckets.doubleTime > 0) {
				result.set(
					id,
					(result.get(id) ?? 0) + buckets.overtime + buckets.doubleTime,
				)
			}
		}
	}
	return result
}

/** Dates (`YYYY-MM-DD`) of the seven days from `weekStart`. */
export function weekDates(weekStart: string): string[] {
	return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

export type ShiftEstimate = {
	/** Overtime and double time minutes the shift contributes. */
	overtimeMinutes: number
	/** Cost in cost units (`COST_UNITS_PER_MINOR` per minor unit), by currency. */
	costUnitsByCurrency: Record<string, number>
	/** Paid minutes with no rate, so no cost. */
	unpricedMinutes: number
}

/**
 * Overtime and cost of each shift, summed over every workweek the person's
 * shifts touch. Cost stays in cost units so a caller can add shifts up and round
 * once; a shift without a rate or currency reports its minutes as unpriced.
 */
export function estimatePerShift(
	shifts: readonly EstimateShift[],
	rules: LaborRules,
	timeZone: string,
): Map<string, ShiftEstimate> {
	const result = new Map<string, ShiftEstimate>()
	for (const shift of shifts) {
		result.set(shift.id, {
			overtimeMinutes: 0,
			costUnitsByCurrency: {},
			unpricedMinutes: 0,
		})
	}
	if (shifts.length === 0) return result
	for (const week of weeksTouched(shifts, rules, timeZone)) {
		const summary = estimateWeek(shifts, rules, timeZone, week)
		for (const [id, buckets] of Object.entries(summary.entries)) {
			const estimate = result.get(id)
			if (estimate) {
				estimate.overtimeMinutes += buckets.overtime + buckets.doubleTime
			}
		}
		for (const [id, cost] of Object.entries(summary.entryCost)) {
			const estimate = result.get(id)
			if (!estimate) continue
			estimate.unpricedMinutes += cost.unpricedMinutes
			if (cost.currency !== null && cost.units !== 0) {
				estimate.costUnitsByCurrency[cost.currency] =
					(estimate.costUnitsByCurrency[cost.currency] ?? 0) + cost.units
			}
		}
	}
	return result
}

/**
 * Splits a shift's paid minutes over the local dates it touches (minutes after
 * midnight count on the next date), in proportion to the real time on each
 * date. The pieces always add up to the shift's paid minutes: rounding is
 * settled on the first date.
 */
export function allocatePaidMinutesByDay(
	shift: { startsAt: number; endsAt: number; unpaidBreakMinutes: number },
	timeZone: string,
): Array<{ date: string; minutes: number }> {
	const paid = paidMinutesOf(shift)
	if (paid <= 0 || shift.endsAt <= shift.startsAt) return []
	const pieces: Array<{ date: string; elapsed: number }> = []
	let date = localDateOf(shift.startsAt, timeZone)
	let cursor = shift.startsAt
	for (let guard = 0; cursor < shift.endsAt && guard < 4; guard++) {
		const next = startOfLocalDay(addDays(date, 1), timeZone)
		const end = Math.min(shift.endsAt, next)
		pieces.push({ date, elapsed: (end - cursor) / MS_PER_MINUTE })
		cursor = end
		date = addDays(date, 1)
	}
	const totalElapsed = pieces.reduce((sum, p) => sum + p.elapsed, 0)
	const out = pieces.map((p) => ({
		date: p.date,
		minutes: Math.floor((paid * p.elapsed) / totalElapsed),
	}))
	const assigned = out.reduce((sum, p) => sum + p.minutes, 0)
	if (out[0]) out[0].minutes += paid - assigned
	return out
}
