import { z } from 'zod'
import { addDays, businessDateOf, weekStartFor } from './tz.ts'

/**
 * Hour caps (#527): the most paid time a person may be scheduled in a day and a
 * week. Pure and data-driven: a rule pack or a scope's labor policy carries the
 * numbers, a person may have their own, and a person who follows the Ramadan
 * limit gets the Ramadan numbers on Ramadan days. Nothing here refuses a
 * schedule: callers show a warning and, when publishing, ask for a reason.
 *
 * No place words, no legal claims: a cap is a number the organization chose or
 * accepted from a pack, and every figure is an estimate.
 */

const MINUTES_PER_DAY = 24 * 60

const capMinutes = (max: number) => z.number().int().min(60).max(max).nullable()

export const hourCapsSchema = z
	.object({
		/** Most paid minutes in one business day; null is no cap. */
		dailyMinutes: capMinutes(MINUTES_PER_DAY),
		/** Most paid minutes in one workweek; null is no cap. */
		weeklyMinutes: capMinutes(7 * MINUTES_PER_DAY),
		/** The daily cap on Ramadan days, for people who follow the Ramadan limit. */
		ramadanDailyMinutes: capMinutes(MINUTES_PER_DAY),
		/** The weekly cap in a workweek with a Ramadan day, for the same people. */
		ramadanWeeklyMinutes: capMinutes(7 * MINUTES_PER_DAY),
	})
	.strict()
export type HourCaps = z.infer<typeof hourCapsSchema>

export const NO_HOUR_CAPS: HourCaps = {
	dailyMinutes: null,
	weeklyMinutes: null,
	ramadanDailyMinutes: null,
	ramadanWeeklyMinutes: null,
}

/** A person's own limits, which replace the scope's caps (part-time, minors). */
export const personHourLimitsSchema = z
	.object({
		dailyMinutes: capMinutes(MINUTES_PER_DAY),
		weeklyMinutes: capMinutes(7 * MINUTES_PER_DAY),
		/**
		 * Whether the person follows the Ramadan limit. Optional, private to
		 * managers with access to private staff details, never shown to other
		 * staff.
		 */
		followsRamadan: z.boolean(),
	})
	.strict()
export type PersonHourLimits = z.infer<typeof personHourLimitsSchema>

export const NO_PERSON_HOUR_LIMITS: PersonHourLimits = {
	dailyMinutes: null,
	weeklyMinutes: null,
	followsRamadan: false,
}

// ---------------------------------------------------------------------------
// Hijri calendar
// ---------------------------------------------------------------------------

let hijriFormatter: Intl.DateTimeFormat | null | undefined
const hijriCache = new Map<string, number | null>()
const HIJRI_CACHE_LIMIT = 2048

function formatterForHijri(): Intl.DateTimeFormat | null {
	if (hijriFormatter === undefined) {
		try {
			hijriFormatter = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
				month: 'numeric',
				timeZone: 'UTC',
			})
		} catch {
			hijriFormatter = null
		}
	}
	return hijriFormatter
}

/** The Hijri month (1-12) of a business date; null when the platform has no such calendar. */
export function hijriMonthOf(date: string): number | null {
	if (hijriCache.has(date)) return hijriCache.get(date) ?? null
	let month: number | null = null
	const [year, mon, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	if (year && mon && day) {
		try {
			const part = formatterForHijri()
				?.formatToParts(new Date(Date.UTC(year, mon - 1, day, 12)))
				.find((p) => p.type === 'month')?.value
			const parsed = part ? Number(part) : Number.NaN
			month =
				Number.isInteger(parsed) && parsed >= 1 && parsed <= 12 ? parsed : null
		} catch {
			month = null
		}
	}
	if (hijriCache.size >= HIJRI_CACHE_LIMIT) hijriCache.clear()
	hijriCache.set(date, month)
	return month
}

/** Ramadan is the ninth month of the Hijri calendar, the same rule prep uses. */
export function isRamadanDate(date: string): boolean {
	return hijriMonthOf(date) === 9
}

// ---------------------------------------------------------------------------
// Which caps apply
// ---------------------------------------------------------------------------

function tighter(a: number | null, b: number | null): number | null {
	if (a === null) return b
	if (b === null) return a
	return Math.min(a, b)
}

/** The daily cap in force for a person on a business date; null is none. */
export function dailyCapFor(
	caps: HourCaps,
	person: PersonHourLimits,
	date: string,
): number | null {
	const base = person.dailyMinutes ?? caps.dailyMinutes
	return person.followsRamadan && isRamadanDate(date)
		? tighter(base, caps.ramadanDailyMinutes)
		: base
}

/**
 * The weekly cap for the workweek starting `weekStart`: the Ramadan cap when
 * any day of the week is a Ramadan day and the person follows the limit.
 */
export function weeklyCapFor(
	caps: HourCaps,
	person: PersonHourLimits,
	weekStart: string,
): number | null {
	const base = person.weeklyMinutes ?? caps.weeklyMinutes
	if (!person.followsRamadan) return base
	for (let i = 0; i < 7; i++) {
		if (isRamadanDate(addDays(weekStart, i))) {
			return tighter(base, caps.ramadanWeeklyMinutes)
		}
	}
	return base
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type CapShift = {
	id: string
	startsAt: number
	endsAt: number
	unpaidBreakMinutes: number
}

export type HourCapBreach = {
	kind: 'daily' | 'weekly'
	/** The shift that takes the person over the cap. */
	shiftId: string
	/** Business date for a daily breach, the workweek's first date for a weekly one. */
	date: string
	capMinutes: number
	/** Paid minutes scheduled in the day or week up to and including this shift. */
	scheduledMinutes: number
}

const MS_PER_MINUTE = 60_000

function paidMinutes(shift: CapShift): number {
	const duration = Math.round((shift.endsAt - shift.startsAt) / MS_PER_MINUTE)
	return Math.max(0, duration - Math.max(0, shift.unpaidBreakMinutes))
}

/**
 * Every shift that takes a person over a daily or weekly cap, judged on all of
 * the person's shifts (across scopes). A shift's paid time counts on the
 * business date it starts. Shifts are taken in start order, and every shift
 * from the one that crosses the cap onward is reported, so the manager sees
 * which shift to move. `only` limits what is reported (not what is counted).
 */
export function detectHourCapBreaches(input: {
	shifts: readonly CapShift[]
	caps: HourCaps
	person: PersonHourLimits
	timeZone: string
	weekStartsOn: number
	workdayStartMinute: number
	only?: ReadonlySet<string>
}): HourCapBreach[] {
	const { caps, person } = input
	const sorted = [...input.shifts].sort(
		(a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id),
	)
	const dayTotal = new Map<string, number>()
	const weekTotal = new Map<string, number>()
	const out: HourCapBreach[] = []
	for (const shift of sorted) {
		const date = businessDateOf(
			shift.startsAt,
			input.timeZone,
			input.workdayStartMinute,
		)
		const weekStart = weekStartFor(date, input.weekStartsOn)
		const minutes = paidMinutes(shift)
		const day = (dayTotal.get(date) ?? 0) + minutes
		const week = (weekTotal.get(weekStart) ?? 0) + minutes
		dayTotal.set(date, day)
		weekTotal.set(weekStart, week)
		if (input.only && !input.only.has(shift.id)) continue
		const dailyCap = dailyCapFor(caps, person, date)
		if (dailyCap !== null && day > dailyCap) {
			out.push({
				kind: 'daily',
				shiftId: shift.id,
				date,
				capMinutes: dailyCap,
				scheduledMinutes: day,
			})
		}
		const weeklyCap = weeklyCapFor(caps, person, weekStart)
		if (weeklyCap !== null && week > weeklyCap) {
			out.push({
				kind: 'weekly',
				shiftId: shift.id,
				date: weekStart,
				capMinutes: weeklyCap,
				scheduledMinutes: week,
			})
		}
	}
	return out
}
