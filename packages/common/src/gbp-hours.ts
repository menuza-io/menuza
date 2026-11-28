/**
 * Google Business Profile hours (#87). Pure conversion and comparison of
 * Menuza's weekly schedule and special hours with Google's `regularHours`
 * and `specialHours`. No I/O.
 *
 * Both sides are reduced to the same canonical form first: intervals of
 * minutes in a Monday-based week (0 to 10080). Slots that touch (a split at
 * midnight, `18:00-23:59` then `00:00-02:30`) are merged, so an overnight
 * stretch is ONE period on both sides and never shows up as a difference.
 */
import {
	expandSpecialHours,
	findSpecialHourForDate,
	specialHoursHorizonEnd,
} from '@repo/opening-hours'
import {
	DAYS_OF_WEEK,
	SHORT_DAY_LABELS,
	type DayOfWeek,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
} from './location-types.ts'

export const GOOGLE_DAYS = [
	'MONDAY',
	'TUESDAY',
	'WEDNESDAY',
	'THURSDAY',
	'FRIDAY',
	'SATURDAY',
	'SUNDAY',
] as const
export type GoogleDay = (typeof GOOGLE_DAYS)[number]

export type GoogleTimeOfDay = { hours?: number; minutes?: number }
export type GooglePeriod = {
	openDay: string
	openTime: GoogleTimeOfDay
	closeDay: string
	closeTime: GoogleTimeOfDay
}
export type GoogleDate = { year: number; month: number; day: number }
export type GoogleSpecialHourPeriod = {
	startDate: GoogleDate
	endDate?: GoogleDate
	openTime?: GoogleTimeOfDay
	closeTime?: GoogleTimeOfDay
	closed?: boolean
}

const MINUTES_PER_DAY = 1440
const WEEK = 7 * MINUTES_PER_DAY

export type Interval = { start: number; end: number }

function parseHHMM(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) return null
	return hours * 60 + minutes
}

function formatHHMM(minuteOfDay: number): string {
	const wrapped = minuteOfDay === MINUTES_PER_DAY ? 0 : minuteOfDay
	const hours = Math.floor(wrapped / 60)
	const minutes = wrapped % 60
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function dayIndex(day: string): number {
	return GOOGLE_DAYS.indexOf(day.toUpperCase() as GoogleDay)
}

function timeOfDay(value: GoogleTimeOfDay | undefined): number {
	return (value?.hours ?? 0) * 60 + (value?.minutes ?? 0)
}

/** Slots of a day as `[start, end)` minutes of that day; end may pass 1440. */
function slotInterval(slot: TimeSlot): { start: number; end: number } | null {
	const start = parseHHMM(slot.start)
	const end = parseHHMM(slot.end)
	if (start === null || end === null) return null
	if (start === end) return null
	// An end before the start is an overnight slot closing the next day.
	return { start, end: end < start ? end + MINUTES_PER_DAY : end }
}

/**
 * Merges touching or overlapping intervals of a (circular) week. A slot that
 * ends at `23:59` is taken to run to midnight only when the next day opens at
 * `00:00`, which is how a split overnight stretch was stored.
 */
export function mergeIntervals(input: Interval[]): Interval[] {
	const sorted = input
		.filter((interval) => interval.end > interval.start)
		.map((interval) => ({ ...interval }))
		.sort((a, b) => a.start - b.start || a.end - b.end)
	const merged: Interval[] = []
	for (const interval of sorted) {
		const last = merged[merged.length - 1]
		const closesAtMidnightMinusOne = last
			? last.end % MINUTES_PER_DAY === 1439
			: false
		const touchesNext =
			last &&
			closesAtMidnightMinusOne &&
			interval.start === last.end + 1 &&
			interval.start % MINUTES_PER_DAY === 0
		if (last && (interval.start <= last.end || touchesNext)) {
			if (touchesNext) last.end += 1
			last.end = Math.max(last.end, interval.end)
		} else {
			merged.push(interval)
		}
	}
	// Sunday night into Monday morning: join the last interval to the first.
	const first = merged[0]
	const last = merged[merged.length - 1]
	if (
		merged.length > 1 &&
		first &&
		last &&
		first.start === 0 &&
		(last.end >= WEEK || last.end === WEEK - 1)
	) {
		const joinedEnd = WEEK + first.end
		merged.pop()
		merged.shift()
		merged.push({ start: last.start, end: joinedEnd })
	}
	return merged
}

/** Menuza's schedule as canonical week intervals (Monday = 0). */
export function scheduleIntervals(schedule: WeeklySchedule | null): Interval[] {
	if (!schedule) return []
	const raw: Interval[] = []
	for (const day of schedule) {
		if (!day.isOpen) continue
		const base = DAYS_OF_WEEK.indexOf(day.day) * MINUTES_PER_DAY
		if (base < 0) continue
		for (const slot of day.slots) {
			const interval = slotInterval(slot)
			if (!interval) continue
			raw.push({ start: base + interval.start, end: base + interval.end })
		}
	}
	return mergeIntervals(raw)
}

/** Google's periods as canonical week intervals. */
export function periodsIntervals(
	periods: readonly GooglePeriod[] | null | undefined,
): Interval[] {
	if (!periods) return []
	const raw: Interval[] = []
	for (const period of periods) {
		const openDay = dayIndex(period.openDay)
		const closeDay = dayIndex(period.closeDay)
		if (openDay < 0 || closeDay < 0) continue
		const start = openDay * MINUTES_PER_DAY + timeOfDay(period.openTime)
		let end = closeDay * MINUTES_PER_DAY + timeOfDay(period.closeTime)
		if (end <= start) end += WEEK
		raw.push({ start, end })
	}
	return mergeIntervals(raw)
}

function googleTime(minuteOfDay: number): GoogleTimeOfDay {
	return { hours: Math.floor(minuteOfDay / 60), minutes: minuteOfDay % 60 }
}

/**
 * Menuza hours as Google `regularHours.periods`. A stretch past midnight is
 * one period whose `closeDay` is the next day; closing exactly at midnight is
 * `24:00` on the same day.
 */
export function weeklyToGooglePeriods(
	schedule: WeeklySchedule | null,
): GooglePeriod[] {
	return scheduleIntervals(schedule).map((interval) => {
		const start = interval.start % WEEK
		const openDay = Math.floor(start / MINUTES_PER_DAY)
		const openMinute = start % MINUTES_PER_DAY
		const closeAbsolute = interval.end
		if (closeAbsolute % MINUTES_PER_DAY === 0) {
			const closeDay = Math.floor((closeAbsolute - 1) / MINUTES_PER_DAY) % 7
			return {
				openDay: GOOGLE_DAYS[openDay]!,
				openTime: googleTime(openMinute),
				closeDay: GOOGLE_DAYS[closeDay]!,
				closeTime: { hours: 24, minutes: 0 },
			}
		}
		const closeDay = Math.floor(closeAbsolute / MINUTES_PER_DAY) % 7
		return {
			openDay: GOOGLE_DAYS[openDay]!,
			openTime: googleTime(openMinute),
			closeDay: GOOGLE_DAYS[closeDay]!,
			closeTime: googleTime(closeAbsolute % MINUTES_PER_DAY),
		}
	})
}

/** One line per differing day for the Needs attention text and the history. */
function daySummary(intervals: Interval[]): Map<DayOfWeek, string> {
	const byDay = new Map<DayOfWeek, string[]>()
	for (const interval of intervals) {
		const startDay = Math.floor((interval.start % WEEK) / MINUTES_PER_DAY)
		const day = DAYS_OF_WEEK[startDay]!
		const open = formatHHMM(interval.start % MINUTES_PER_DAY)
		const close = formatHHMM(interval.end % MINUTES_PER_DAY)
		const list = byDay.get(day) ?? []
		list.push(`${open}-${close}`)
		byDay.set(day, list)
	}
	return new Map([...byDay].map(([day, list]) => [day, list.join(', ')]))
}

export type HoursDifference = {
	day: DayOfWeek
	label: string
	menuza: string
	google: string
}

/** Days whose hours differ; an empty list means the two agree. */
export function diffWeeklyHours(
	menuza: WeeklySchedule | null,
	googlePeriods: readonly GooglePeriod[] | null | undefined,
): HoursDifference[] {
	const mine = daySummary(scheduleIntervals(menuza))
	const theirs = daySummary(periodsIntervals(googlePeriods))
	const differences: HoursDifference[] = []
	for (const day of DAYS_OF_WEEK) {
		const left = mine.get(day) ?? ''
		const right = theirs.get(day) ?? ''
		if (left !== right) {
			differences.push({
				day,
				label: SHORT_DAY_LABELS[day],
				menuza: left || 'Closed',
				google: right || 'Closed',
			})
		}
	}
	return differences
}

/** Whether two sets of hours mean the same thing. */
export function weeklyHoursEqual(
	menuza: WeeklySchedule | null,
	googlePeriods: readonly GooglePeriod[] | null | undefined,
): boolean {
	return diffWeeklyHours(menuza, googlePeriods).length === 0
}

// ---------------------------------------------------------------------------
// Special hours
// ---------------------------------------------------------------------------

function parseIsoDate(value: string): GoogleDate | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (!match) return null
	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
	}
}

export function isoFromGoogleDate(date: GoogleDate): string {
	return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

function addDaysIso(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`)
	date.setUTCDate(date.getUTCDate() + days)
	return date.toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` of `now` in a time zone. */
export function localDateIso(now: Date, timeZone: string): string {
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(now)
		const get = (type: string) =>
			parts.find((part) => part.type === type)?.value ?? ''
		return `${get('year')}-${get('month')}-${get('day')}`
	} catch {
		return now.toISOString().slice(0, 10)
	}
}

/**
 * Special hours to send: today and future dates only (past dates are left
 * alone). A closed day is `closed: true`; an open day lists each slot, and a
 * slot past midnight ends the next date.
 */
export function specialHoursToGoogle(
	special: readonly SpecialHour[] | null | undefined,
	today: string,
): GoogleSpecialHourPeriod[] {
	const periods: GoogleSpecialHourPeriod[] = []
	// Yearly repeats (#242) become one dated entry per occurrence in the next
	// year, so Google gets the same dates the rest of the product enforces.
	const sorted = expandSpecialHours(
		special,
		today,
		specialHoursHorizonEnd(today),
	)
	for (const entry of sorted) {
		if (entry.date < today) continue
		const startDate = parseIsoDate(entry.date)
		if (!startDate) continue
		if (!entry.isOpen || entry.slots.length === 0) {
			periods.push({ startDate, closed: true })
			continue
		}
		for (const slot of entry.slots) {
			const interval = slotInterval(slot)
			if (!interval) continue
			const overnight = interval.end > MINUTES_PER_DAY
			const closesAtMidnight = interval.end === MINUTES_PER_DAY
			const endDate = overnight
				? parseIsoDate(addDaysIso(entry.date, 1))
				: startDate
			periods.push({
				startDate,
				endDate: endDate ?? startDate,
				openTime: googleTime(interval.start),
				closeTime: closesAtMidnight
					? { hours: 24, minutes: 0 }
					: googleTime(interval.end % MINUTES_PER_DAY),
			})
		}
	}
	return periods
}

/** Canonical text of one special day, `closed` or `11:00-22:00, 23:00-01:00`. */
function specialDayText(periods: GoogleSpecialHourPeriod[]): string {
	if (periods.some((period) => period.closed)) return 'closed'
	return periods
		.map((period) => {
			const open = formatHHMM(timeOfDay(period.openTime))
			const closeRaw = timeOfDay(period.closeTime)
			return `${open}-${formatHHMM(closeRaw)}`
		})
		.sort()
		.join(', ')
}

function groupSpecialByDate(
	periods: readonly GoogleSpecialHourPeriod[],
	today: string,
): Map<string, string> {
	const byDate = new Map<string, GoogleSpecialHourPeriod[]>()
	for (const period of periods) {
		const iso = isoFromGoogleDate(period.startDate)
		if (iso < today) continue
		const list = byDate.get(iso) ?? []
		list.push(period)
		byDate.set(iso, list)
	}
	return new Map(
		[...byDate].map(([date, list]) => [date, specialDayText(list)]),
	)
}

export type SpecialHoursDifference = {
	date: string
	menuza: string
	google: string
}

/** Dates (today and later) where Menuza and Google disagree. */
export function diffSpecialHours(
	menuza: readonly SpecialHour[] | null | undefined,
	google: readonly GoogleSpecialHourPeriod[] | null | undefined,
	today: string,
): SpecialHoursDifference[] {
	const mine = groupSpecialByDate(specialHoursToGoogle(menuza, today), today)
	const theirs = groupSpecialByDate(google ?? [], today)
	const dates = [...new Set([...mine.keys(), ...theirs.keys()])].sort()
	const differences: SpecialHoursDifference[] = []
	for (const date of dates) {
		const left = mine.get(date) ?? ''
		const right = theirs.get(date) ?? ''
		if (left !== right) {
			differences.push({
				date,
				menuza: left || 'Not set',
				google: right || 'Not set',
			})
		}
	}
	return differences
}

/** Google special periods back to Menuza's shape ("Use Google's value"). */
export function googleSpecialToMenuza(
	google: readonly GoogleSpecialHourPeriod[] | null | undefined,
	today: string,
	existing: readonly SpecialHour[] = [],
): SpecialHour[] {
	const byDate = new Map<string, SpecialHour>()
	for (const period of google ?? []) {
		const date = isoFromGoogleDate(period.startDate)
		if (date < today) continue
		const entry = byDate.get(date) ?? {
			id: existing.find((item) => item.date === date)?.id ?? `gbp-${date}`,
			date,
			isOpen: true,
			slots: [],
			note: existing.find((item) => item.date === date)?.note,
			...(existing.find((item) => item.date === date)?.repeatsYearly
				? { repeatsYearly: true }
				: {}),
		}
		if (period.closed) {
			entry.isOpen = false
			entry.slots = []
		} else {
			entry.slots.push({
				start: formatHHMM(timeOfDay(period.openTime)),
				end: formatHHMM(timeOfDay(period.closeTime)),
			})
		}
		byDate.set(date, entry)
	}
	// A repeating entry (#242) already covers later years: Google's copy of a
	// later occurrence with the same hours is not a new entry, and the repeat
	// flag survives on the entry's own date. A different value stays a one-off
	// that overrides the repeat for that year.
	const repeating = existing.filter((item) => item.repeatsYearly)
	const sameDay = (a: SpecialHour, b: SpecialHour) =>
		a.isOpen === b.isOpen &&
		a.slots.map((slot) => `${slot.start}-${slot.end}`).join(',') ===
			b.slots.map((slot) => `${slot.start}-${slot.end}`).join(',')
	for (const [date, entry] of byDate) {
		const base = findSpecialHourForDate(repeating, date)
		if (!base || !sameDay(base, entry)) continue
		if (base.date === date) entry.repeatsYearly = true
		else byDate.delete(date)
	}
	// Past dates are left alone: keep Menuza's own past entries untouched.
	const past = existing.filter((item) => item.date < today)
	return [
		...past,
		...[...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
	]
}

// ---------------------------------------------------------------------------
// Open or closed (temporary closure)
// ---------------------------------------------------------------------------

export type GoogleOpenStatus = 'OPEN' | 'CLOSED_TEMPORARILY'

/** Whether Menuza's temporary closure is in force at `now`. */
export function isTemporarilyClosed(
	location: { temporarilyClosed: boolean; temporarilyClosedUntil: Date | null },
	now: Date,
): boolean {
	if (!location.temporarilyClosed) return false
	if (!location.temporarilyClosedUntil) return true
	return location.temporarilyClosedUntil.getTime() > now.getTime()
}

export function desiredOpenStatus(
	location: { temporarilyClosed: boolean; temporarilyClosedUntil: Date | null },
	now: Date,
): GoogleOpenStatus {
	return isTemporarilyClosed(location, now) ? 'CLOSED_TEMPORARILY' : 'OPEN'
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/** Digits only (with a leading `+` kept), so `+1 (555) 010-0` equals `+1-555-0100`. */
export function normalizePhone(value: string | null | undefined): string {
	if (!value) return ''
	const trimmed = value.trim()
	const digits = trimmed.replace(/\D/g, '')
	return trimmed.startsWith('+') ? `+${digits}` : digits
}

export function phonesEqual(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const a = normalizePhone(left)
	const b = normalizePhone(right)
	if (a === b) return true
	// A national number equals the same number with its country code.
	if (!a || !b) return false
	const strip = (value: string) => value.replace(/^\+/, '')
	return strip(a).endsWith(strip(b)) || strip(b).endsWith(strip(a))
}

// ---------------------------------------------------------------------------
// Fingerprints (outbox bookkeeping)
// ---------------------------------------------------------------------------

/** Stable JSON: object keys sorted, so equal values give equal text. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object')
		return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** FNV-1a (32 bit) of the stable text; short enough to keep per field. */
export function fingerprint(value: unknown): string {
	const text = stableStringify(value)
	let hash = 0x811c9dc5
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}
