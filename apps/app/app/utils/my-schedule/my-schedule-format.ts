import { addDays } from '@repo/staffing'
import { type MyShift } from './my-schedule-api.ts'

/**
 * Dates and times for the "my schedule" page. Shifts are shown in the zone the
 * workplace keeps them in (a shift at 9 is at 9 on the wall of the workplace, not
 * in the phone's zone). Arabic uses Western digits, like the emails and the
 * time clock, so a time reads the same on every screen a person sees.
 */

export function intlLocale(locale: string): string {
	return locale.startsWith('ar') ? 'ar-u-nu-latn' : locale
}

function safeZone(timeZone: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone })
		return timeZone
	} catch {
		return 'UTC'
	}
}

/** "9 AM" or "9:30 AM". */
export function formatTime(
	ms: number,
	timeZone: string,
	locale: string,
): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: safeZone(timeZone),
	}).format(ms)
}

/** "9:00 AM – 5:00 PM". The caller wraps it in `<bdi>`. */
export function formatRange(
	startsAt: number,
	endsAt: number,
	timeZone: string,
	locale: string,
): string {
	return `${formatTime(startsAt, timeZone, locale)} – ${formatTime(endsAt, timeZone, locale)}`
}

function dateAsUtc(date: string): number {
	const [y = 2000, m = 1, d = 1] = date.split('-').map(Number)
	return Date.UTC(y, m - 1, d, 12)
}

/** "Mon, Mar 2" for a calendar date (no zone shift). */
export function formatDay(
	date: string,
	locale: string,
	options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	},
): string {
	try {
		return new Intl.DateTimeFormat(intlLocale(locale), {
			...options,
			timeZone: 'UTC',
		}).format(dateAsUtc(date))
	} catch {
		return date
	}
}

/** "Mar 2 – Mar 8". */
export function formatSpan(from: string, to: string, locale: string): string {
	try {
		return new Intl.DateTimeFormat(intlLocale(locale), {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		}).formatRange(dateAsUtc(from), dateAsUtc(to))
	} catch {
		return `${from} – ${to}`
	}
}

/** A date and time in the workplace's time zone: "Mar 2, 9:14 AM". */
export function formatStamp(
	ms: number,
	timeZone: string,
	locale: string,
): string {
	return new Intl.DateTimeFormat(intlLocale(locale), {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZone: safeZone(timeZone),
	}).format(ms)
}

/** "7 h 30 min", "45 min". */
export function formatPaid(minutes: number, locale: string): string {
	const total = Math.max(0, Math.round(minutes))
	const h = Math.floor(total / 60)
	const m = total % 60
	const ar = locale.startsWith('ar')
	const hUnit = ar ? 'س' : 'h'
	const mUnit = ar ? 'د' : 'min'
	if (h === 0) return `${m} ${mUnit}`
	return m === 0 ? `${h} ${hUnit}` : `${h} ${hUnit} ${m} ${mUnit}`
}

/** "+0:30" or "-1:15", for a change in hours. */
export function formatDelta(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+'
	const abs = Math.abs(Math.round(minutes))
	return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

/** The calendar date `today` is in the given zone. */
export function todayIn(now: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: safeZone(timeZone),
	}).format(now)
	return parts
}

export type DayGroup = { date: string; shifts: MyShift[] }

/** Shifts grouped by their business date, in time order. */
export function groupByDay(shifts: readonly MyShift[]): DayGroup[] {
	const sorted = [...shifts].sort(
		(a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id),
	)
	const groups: DayGroup[] = []
	for (const shift of sorted) {
		const last = groups[groups.length - 1]
		if (last && last.date === shift.localDate) last.shifts.push(shift)
		else groups.push({ date: shift.localDate, shifts: [shift] })
	}
	return groups
}

/** The first shift that has not ended yet. */
export function nextShift(
	shifts: readonly MyShift[],
	now: number,
): MyShift | null {
	let found: MyShift | null = null
	for (const shift of shifts) {
		if (shift.endsAt <= now) continue
		if (!found || shift.startsAt < found.startsAt) found = shift
	}
	return found
}

/** The window `days` long that starts `offsetDays` from `from`. */
export function windowFrom(
	from: string,
	offsetDays: number,
	days: number,
): { from: string; to: string } {
	const start = addDays(from, offsetDays)
	return { from: start, to: addDays(start, days - 1) }
}
