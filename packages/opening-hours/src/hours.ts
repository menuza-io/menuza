import {
	addDays,
	dayOfWeek,
	isValidTimeZone,
	localParts,
	zonedLocalToUtc,
} from '@repo/zoned-time'

/**
 * Opening and online-ordering hours for every channel. Stored JSON shapes mirror
 * `packages/common/src/location-types.ts` (`WeeklySchedule`, `SpecialHour`).
 *
 * Reservations pass `malformedPolicy: 'open'` (missing hours never close the
 * location). Ordering uses `'closed'` (malformed hours are treated as closed).
 */

export const LOCATION_DAY_NAMES = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
] as const
export type LocationDayName = (typeof LOCATION_DAY_NAMES)[number]

export type LocationTimeSlot = { start: string; end: string }
export type LocationWeeklyDay = {
	day: LocationDayName
	isOpen: boolean
	slots: LocationTimeSlot[]
}
export type LocationSpecialHour = {
	id: string
	date: string
	isOpen: boolean
	slots: LocationTimeSlot[]
	note?: string
}

export type MalformedHoursPolicy = 'open' | 'closed'

export type LocationHours = {
	timeZone: string
	isActive: boolean
	/** `null` or empty: no weekly schedule configured (open when policy is `open`). */
	storeHours: LocationWeeklyDay[] | null
	/** Custom online ordering pattern; `null` uses `storeHours`. */
	onlineHours: LocationWeeklyDay[] | null
	/** `null` or empty: no dated overrides. */
	specialHours: LocationSpecialHour[] | null
}

export type HoursScheduleKind = 'store' | 'online'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function hhmmToMinutes(value: string): number | null {
	const m = HHMM.exec(value)
	return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function maybeJson(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw
	const trimmed = raw.trim()
	if (!trimmed) return null
	try {
		return JSON.parse(trimmed)
	} catch {
		return undefined
	}
}

function parseSlots(raw: unknown): LocationTimeSlot[] | null {
	if (raw === undefined || raw === null) return []
	if (!Array.isArray(raw)) return null
	const out: LocationTimeSlot[] = []
	for (const item of raw) {
		if (!item || typeof item !== 'object') return null
		const { start, end } = item as Record<string, unknown>
		if (typeof start !== 'string' || typeof end !== 'string') return null
		if (hhmmToMinutes(start) === null || hhmmToMinutes(end) === null) {
			return null
		}
		out.push({ start, end })
	}
	return out
}

export type ParsedHoursField<T> = {
	value: T | null
	/** True when a non-empty value was present but unusable (the field fails open). */
	malformed: boolean
}

/** Tolerant parser for the stored weekly hours (array, or the raw JSON string). */
export function parseWeeklyHours(
	raw: unknown,
): ParsedHoursField<LocationWeeklyDay[]> {
	const value = maybeJson(raw)
	if (value === null) return { value: null, malformed: false }
	if (!Array.isArray(value)) return { value: null, malformed: true }
	const out: LocationWeeklyDay[] = []
	for (const item of value) {
		if (!item || typeof item !== 'object')
			return { value: null, malformed: true }
		const { day, isOpen, slots } = item as Record<string, unknown>
		const dayName = typeof day === 'string' ? day.toLowerCase() : ''
		if (
			!(LOCATION_DAY_NAMES as readonly string[]).includes(dayName) ||
			typeof isOpen !== 'boolean'
		) {
			return { value: null, malformed: true }
		}
		const parsedSlots = parseSlots(slots)
		if (!parsedSlots) return { value: null, malformed: true }
		out.push({
			day: dayName as LocationDayName,
			isOpen,
			slots: parsedSlots,
		})
	}
	return { value: out.length > 0 ? out : null, malformed: false }
}

/** Tolerant parser for the stored special hours (array, or the raw JSON string). */
export function parseSpecialHours(
	raw: unknown,
): ParsedHoursField<LocationSpecialHour[]> {
	const value = maybeJson(raw)
	if (value === null) return { value: null, malformed: false }
	if (!Array.isArray(value)) return { value: null, malformed: true }
	const out: LocationSpecialHour[] = []
	for (const item of value) {
		if (!item || typeof item !== 'object')
			return { value: null, malformed: true }
		const { id, date, isOpen, slots, note } = item as Record<string, unknown>
		if (
			typeof date !== 'string' ||
			!DATE.test(date) ||
			typeof isOpen !== 'boolean'
		) {
			return { value: null, malformed: true }
		}
		const parsedSlots = parseSlots(slots)
		if (!parsedSlots) return { value: null, malformed: true }
		out.push({
			id: typeof id === 'string' ? id : date,
			date,
			isOpen,
			slots: parsedSlots,
			...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
		})
	}
	return { value: out.length > 0 ? out : null, malformed: false }
}

export type LocationHoursParseResult = {
	hours: LocationHours
	/** Number of fields (0..3) that were present but unusable and failed open. */
	malformedCount: number
}

/**
 * Builds `LocationHours` from the raw context fields. A malformed value fails
 * open for that location only; the caller logs `malformedCount`.
 */
function closedWeek(): LocationWeeklyDay[] {
	return LOCATION_DAY_NAMES.map((day) => ({
		day,
		isOpen: false,
		slots: [],
	}))
}

function resolveWeekly(
	parsed: ParsedHoursField<LocationWeeklyDay[]>,
	policy: MalformedHoursPolicy,
): LocationWeeklyDay[] | null {
	if (parsed.malformed) {
		return policy === 'closed' ? closedWeek() : null
	}
	return parsed.value
}

export function parseLocationHours(
	raw: {
		timeZone: string
		isActive?: boolean | null
		storeHours?: unknown
		onlineHours?: unknown
		specialHours?: unknown
	},
	options: { malformedPolicy?: MalformedHoursPolicy } = {},
): LocationHoursParseResult {
	const policy = options.malformedPolicy ?? 'open'
	const weekly =
		raw.storeHours === undefined
			? ({ value: null, malformed: false } as ParsedHoursField<
					LocationWeeklyDay[]
				>)
			: parseWeeklyHours(raw.storeHours)
	const online =
		raw.onlineHours === undefined
			? ({ value: null, malformed: false } as ParsedHoursField<
					LocationWeeklyDay[]
				>)
			: parseWeeklyHours(raw.onlineHours)
	const special =
		raw.specialHours === undefined
			? ({ value: null, malformed: false } as ParsedHoursField<
					LocationSpecialHour[]
				>)
			: parseSpecialHours(raw.specialHours)
	const specialValue =
		special.malformed && policy === 'closed'
			? []
			: special.malformed
				? null
				: special.value
	return {
		hours: {
			timeZone: raw.timeZone,
			isActive: raw.isActive !== false,
			storeHours: resolveWeekly(weekly, policy),
			onlineHours: resolveWeekly(online, policy),
			specialHours: specialValue,
		},
		malformedCount:
			(weekly.malformed ? 1 : 0) +
			(online.malformed ? 1 : 0) +
			(special.malformed ? 1 : 0),
	}
}

/** Counts malformed `storeHours` / `specialHours` values in a raw context payload (for logging only). */
export function countMalformedLocationHours(rawContext: unknown): number {
	const locations = (rawContext as { locations?: unknown } | null)?.locations
	if (!Array.isArray(locations)) return 0
	let count = 0
	for (const loc of locations) {
		if (!loc || typeof loc !== 'object') continue
		const { storeHours, specialHours } = loc as Record<string, unknown>
		if (parseWeeklyHours(storeHours).malformed) count++
		if (parseSpecialHours(specialHours).malformed) count++
	}
	return count
}

/** True when the location has any weekly schedule or special entry at all. */
export function hasConfiguredHours(hours: LocationHours): boolean {
	return (
		(hours.storeHours?.length ?? 0) > 0 || (hours.onlineHours?.length ?? 0) > 0
	)
}

/** True when a stored weekly schedule has at least one open day with a slot. */
export function weeklyScheduleHasOpenDay(raw: unknown): boolean {
	const parsed = parseWeeklyHours(raw)
	return (
		parsed.value?.some(
			(day) => day.isOpen && Array.isArray(day.slots) && day.slots.length > 0,
		) ?? false
	)
}

export type LocationClosedReason =
	'inactive' | 'special_closed' | 'closed_weekday' | 'outside_hours'

export type LocationOpenResult = {
	open: boolean
	reason: LocationClosedReason | null
	note?: string
}

export type OpenInterval = { startMs: number; endMs: number }

type DayRule =
	| { kind: 'unrestricted' }
	| { kind: 'closed'; reason: LocationClosedReason; note?: string }
	| { kind: 'slots'; slots: LocationTimeSlot[]; note?: string }

function weeklyForKind(
	hours: LocationHours,
	kind: HoursScheduleKind,
): LocationWeeklyDay[] | null {
	if (kind === 'online') {
		return hours.onlineHours?.length ? hours.onlineHours : hours.storeHours
	}
	return hours.storeHours
}

/** Effective rule for one calendar date: special entry first, else the weekday pattern. */
export function ruleForDate(
	hours: LocationHours,
	date: string,
	kind: HoursScheduleKind = 'store',
): DayRule {
	const special = hours.specialHours?.find((s) => s.date === date)
	if (special) {
		if (!special.isOpen) {
			return {
				kind: 'closed',
				reason: 'special_closed',
				...(special.note ? { note: special.note } : {}),
			}
		}
		return {
			kind: 'slots',
			slots: special.slots,
			...(special.note ? { note: special.note } : {}),
		}
	}
	const weekly = weeklyForKind(hours, kind)
	if (!weekly || weekly.length === 0) {
		return { kind: 'unrestricted' }
	}
	const name = LOCATION_DAY_NAMES[dayOfWeek(date)]!
	const day = weekly.find((d) => d.day === name)
	if (!day || !day.isOpen || day.slots.length === 0) {
		return { kind: 'closed', reason: 'closed_weekday' }
	}
	return { kind: 'slots', slots: day.slots }
}

/**
 * A slot is minute-granular with an inclusive end (`23:59` covers the last
 * minute of the day). For **online** ordering, a single `22:00-02:00` row is
 * invalid (split at midnight). Store / reservation hours still accept it as
 * overnight.
 */
function slotSegments(
	slot: LocationTimeSlot,
	kind: HoursScheduleKind,
): {
	todayFrom: number
	todayTo: number
	tailTo: number | null
} | null {
	const start = hhmmToMinutes(slot.start)
	const end = hhmmToMinutes(slot.end)
	if (start === null || end === null) return null
	if (end < start) {
		if (kind === 'online') return null
		return { todayFrom: start, todayTo: 1439, tailTo: end }
	}
	return { todayFrom: start, todayTo: end, tailTo: null }
}

/** Open ranges (minutes since local midnight, end inclusive) of `date`, including overnight tails from the day before. */
export function rangesForDate(
	hours: LocationHours,
	date: string,
	kind: HoursScheduleKind = 'store',
): { ranges: Array<[number, number]>; rule: DayRule } {
	const rule = ruleForDate(hours, date, kind)
	const ranges: Array<[number, number]> = []
	if (rule.kind === 'unrestricted') return { ranges: [[0, 1439]], rule }
	if (rule.kind === 'slots') {
		for (const slot of rule.slots) {
			const seg = slotSegments(slot, kind)
			if (seg) ranges.push([seg.todayFrom, seg.todayTo])
		}
	}
	// Overnight tail from the previous date, unless this date is closed outright.
	if (!(rule.kind === 'closed' && rule.reason === 'special_closed')) {
		const prev = ruleForDate(hours, addDays(date, -1), kind)
		if (prev.kind === 'slots') {
			for (const slot of prev.slots) {
				const seg = slotSegments(slot, kind)
				if (seg && seg.tailTo !== null) ranges.push([0, seg.tailTo])
			}
		}
	}
	return { ranges, rule }
}

/** Calendar date and minute-of-day of an instant in the location's zone. */
export function locationLocalClock(
	instantMs: number,
	timeZone: string,
): { date: string; minute: number } {
	const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
	const p = localParts(instantMs, zone)
	const pad = (n: number) => String(n).padStart(2, '0')
	return {
		date: `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`,
		minute: p.hour * 60 + p.minute,
	}
}

/**
 * Is the location open at `instantMs`? The instant is converted to the
 * location's local date and clock time, so the reservation time zone and the
 * `dayStartMin` business-day offset are irrelevant here (a slot at 01:00 belongs
 * to the previous business date but is checked by its real local clock).
 */
export function isLocationOpenAt(
	hours: LocationHours,
	instantMs: number,
	kind: HoursScheduleKind = 'store',
): LocationOpenResult {
	if (hours.isActive === false) return { open: false, reason: 'inactive' }
	const { date, minute } = locationLocalClock(instantMs, hours.timeZone)
	const { ranges, rule } = rangesForDate(hours, date, kind)
	if (rule.kind === 'unrestricted') return { open: true, reason: null }
	if (ranges.some(([from, to]) => minute >= from && minute <= to)) {
		return { open: true, reason: null }
	}
	if (rule.kind === 'closed') {
		return {
			open: false,
			reason: rule.reason,
			...(rule.note ? { note: rule.note } : {}),
		}
	}
	return {
		open: false,
		reason: 'outside_hours',
		...(rule.kind === 'slots' && rule.note ? { note: rule.note } : {}),
	}
}

/**
 * Merged open intervals (as instants) for the local dates `fromDate..toDate`
 * inclusive. `null` means unrestricted (no hours configured: fail open).
 * Inactive locations have no intervals.
 */
export function locationOpenIntervals(
	hours: LocationHours,
	fromDate: string,
	toDate: string,
	kind: HoursScheduleKind = 'store',
): OpenInterval[] | null {
	if (hours.isActive === false) return []
	if (!hasConfiguredHours(hours) && !(hours.specialHours?.length ?? 0)) {
		return null
	}
	const zone = isValidTimeZone(hours.timeZone) ? hours.timeZone : 'UTC'
	const out: OpenInterval[] = []
	let date = fromDate
	let guard = 0
	while (date <= toDate && guard++ < 400) {
		const { ranges, rule } = rangesForDate(hours, date, kind)
		if (rule.kind === 'unrestricted') {
			// A special entry elsewhere in the list but no weekly pattern: open outside it.
			const [y, m, d] = date.split('-').map(Number) as [number, number, number]
			out.push({
				startMs: zonedLocalToUtc(y, m, d, 0, 0, zone),
				endMs: zonedLocalToUtc(y, m, d, 24, 0, zone),
			})
		} else {
			const [y, m, d] = date.split('-').map(Number) as [number, number, number]
			for (const [from, to] of ranges) {
				out.push({
					startMs: zonedLocalToUtc(
						y,
						m,
						d,
						Math.floor(from / 60),
						from % 60,
						zone,
					),
					// End is inclusive at minute granularity: the interval is half-open past it.
					endMs: zonedLocalToUtc(y, m, d, 0, to + 1, zone),
				})
			}
		}
		date = addDays(date, 1)
	}
	out.sort((a, b) => a.startMs - b.startMs)
	const merged: OpenInterval[] = []
	for (const iv of out) {
		const last = merged[merged.length - 1]
		if (last && iv.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, iv.endMs)
		} else {
			merged.push({ ...iv })
		}
	}
	return merged
}

/** True when `instantMs` lies inside one of `intervals` (`null` = unrestricted). */
export function instantInIntervals(
	intervals: readonly OpenInterval[] | null,
	instantMs: number,
): boolean {
	if (intervals === null) return true
	return intervals.some((iv) => instantMs >= iv.startMs && instantMs < iv.endMs)
}

/** 2024-01-07 is a Sunday: a reference calendar week for weekly-pattern checks. */
const REFERENCE_SUNDAY = '2024-01-07'

/**
 * Is the location open at `minute` (`0..2879`) after midnight of a weekday
 * (`0` = Sunday), looking at the weekly pattern only (special hours ignored)?
 * Minutes past 1439 fall on the next weekday, overnight tails included.
 */
export function weeklyOpenAtMinute(
	hours: LocationHours,
	weekday: number,
	minute: number,
): boolean {
	if (!hours.storeHours || hours.storeHours.length === 0) return true
	const weeklyOnly: LocationHours = { ...hours, specialHours: null }
	const date = addDays(REFERENCE_SUNDAY, weekday + Math.floor(minute / 1440))
	const clock = ((minute % 1440) + 1440) % 1440
	const { ranges, rule } = rangesForDate(weeklyOnly, date)
	if (rule.kind === 'unrestricted') return true
	return ranges.some(([from, to]) => clock >= from && clock <= to)
}

/** True when the weekly pattern has the weekday open at all (any slot). */
export function weeklyDayHasHours(
	hours: LocationHours,
	weekday: number,
): boolean {
	if (!hours.storeHours || hours.storeHours.length === 0) return true
	const name = LOCATION_DAY_NAMES[weekday]!
	const day = hours.storeHours.find((d) => d.day === name)
	return Boolean(day && day.isOpen && day.slots.length > 0)
}
