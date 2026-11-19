/**
 * Website events (#184): one-off and repeating announcements (trivia
 * Tuesdays, live music, an iftar buffet). Pure: the App stores `SiteEvent`
 * rows, expands them here for the public site, and Sites renders them.
 *
 * Times are wall-clock values in the event's time zone (the location's): a
 * weekly event at 20:00 stays at 20:00 across daylight-saving changes,
 * because every occurrence is converted from its own local date and time with
 * `@repo/zoned-time`, never by adding 7 x 24 hours.
 *
 * Bookable experiences (reservations) are a different thing and are only
 * linked by id; nothing here books.
 */
import {
	addDays,
	dayOfWeek,
	formatDate,
	isValidTimeZone,
	localParts,
	parseDate,
	parseLocalTimestamp,
	tzOffsetMs,
} from '@repo/zoned-time'
import { z } from 'zod'

/** A repeating event without an end shows at most this many occurrences. */
export const MAX_LISTED_OCCURRENCES = 12
/** An occurrence lasts at most this long. */
export const MAX_EVENT_MINUTES = 24 * 60
/** A finished event's page answers 410 this long after its last occurrence. */
export const EVENT_GONE_AFTER_DAYS = 30
/** Safety cap on how far ahead a rule is walked. */
const MAX_WALK_DAYS = 3 * 366
const MS_PER_DAY = 86_400_000

const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const localDate = /^\d{4}-\d{2}-\d{2}$/
const localTime = /^\d{2}:\d{2}$/

export const siteEventRecurrenceSchema = z.discriminatedUnion('frequency', [
	z.object({ frequency: z.literal('none') }),
	z.object({
		frequency: z.literal('weekly'),
		/** 0 = Sunday ... 6 = Saturday. */
		weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
		interval: z.number().int().min(1).max(8).default(1),
		until: z.string().regex(localDate).nullish(),
		count: z.number().int().min(1).max(500).nullish(),
	}),
	z.object({
		frequency: z.literal('monthly'),
		/** `date`: same day of the month. `weekday`: e.g. "second Friday". */
		mode: z.enum(['date', 'weekday']),
		interval: z.number().int().min(1).max(12).default(1),
		until: z.string().regex(localDate).nullish(),
		count: z.number().int().min(1).max(500).nullish(),
	}),
	z.object({
		frequency: z.literal('dates'),
		/** Extra dates, besides the first one, at the same time of day. */
		dates: z.array(z.string().regex(localDate)).max(100),
	}),
])

export type SiteEventRecurrence = z.infer<typeof siteEventRecurrenceSchema>

export const siteEventExceptionsSchema = z.object({
	/** Dates (`YYYY-MM-DD`) on which the event does not happen. */
	skipped: z.array(z.string().regex(localDate)).max(200).default([]),
	/** One occurrence at another time, the series unchanged. */
	moved: z
		.array(
			z.object({
				date: z.string().regex(localDate),
				start: z.string().regex(localTime),
				end: z.string().regex(localTime),
			}),
		)
		.max(200)
		.default([]),
})

export type SiteEventExceptions = z.infer<typeof siteEventExceptionsSchema>

export type SiteEventSchedule = {
	/** First occurrence, wall clock: `YYYY-MM-DDTHH:mm`. */
	startLocal: string
	/** End of the first occurrence, wall clock. */
	endLocal: string
	timezone: string
	recurrence: SiteEventRecurrence
	exceptions?: SiteEventExceptions | null
}

export type SiteEventOccurrence = {
	/** Local date of the occurrence. */
	date: string
	startMs: number
	endMs: number
	/** ISO 8601 with the zone's offset, e.g. `2026-03-10T20:00:00-04:00`. */
	start: string
	end: string
	moved: boolean
}

export type SiteEventTimeError = 'invalid_event_time'

/** Wall-clock minutes between two `YYYY-MM-DDTHH:mm` values (no zone). */
function wallMinutes(from: string, to: string): number {
	const a = Date.parse(`${from}:00Z`)
	const b = Date.parse(`${to}:00Z`)
	return (b - a) / 60_000
}

function timeOf(local: string): string {
	return local.slice(11, 16)
}

/**
 * End after start and at most 24 hours later (`invalid_event_time`); a valid
 * IANA zone. Returns the occurrence length in minutes.
 */
export function validateEventTimes(input: {
	startLocal: string
	endLocal: string
	timezone: string
}): { ok: true; minutes: number } | { ok: false; error: SiteEventTimeError } {
	if (
		!localDateTime.test(input.startLocal) ||
		!localDateTime.test(input.endLocal) ||
		!isValidTimeZone(input.timezone)
	) {
		return { ok: false, error: 'invalid_event_time' }
	}
	try {
		parseLocalTimestamp(input.startLocal, input.timezone)
		parseLocalTimestamp(input.endLocal, input.timezone)
	} catch {
		return { ok: false, error: 'invalid_event_time' }
	}
	const minutes = wallMinutes(input.startLocal, input.endLocal)
	if (!(minutes > 0) || minutes > MAX_EVENT_MINUTES) {
		return { ok: false, error: 'invalid_event_time' }
	}
	return { ok: true, minutes }
}

/** ISO 8601 with the zone's offset at that instant. */
export function isoWithOffset(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone)
	const offsetMinutes = Math.round(tzOffsetMs(ms, timeZone) / 60_000)
	const sign = offsetMinutes < 0 ? '-' : '+'
	const abs = Math.abs(offsetMinutes)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${formatDate(p.year, p.month, p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function occurrenceAt(
	date: string,
	startTime: string,
	endTime: string | null,
	minutes: number,
	timeZone: string,
	moved: boolean,
): SiteEventOccurrence | null {
	try {
		const startMs = parseLocalTimestamp(`${date}T${startTime}`, timeZone)
		let endMs: number
		if (endTime) {
			const endDate = endTime > startTime ? date : addDays(date, 1)
			endMs = parseLocalTimestamp(`${endDate}T${endTime}`, timeZone)
		} else {
			// Same wall-clock length as the first occurrence: compute the local
			// end and convert it, so a DST change in between moves nothing.
			const startWall =
				Date.parse(`${date}T${startTime}:00Z`) + minutes * 60_000
			const end = new Date(startWall)
			const endLocal = `${formatDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())}T${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}`
			endMs = parseLocalTimestamp(endLocal, timeZone)
		}
		if (!(endMs > startMs)) return null
		return {
			date,
			startMs,
			endMs,
			start: isoWithOffset(startMs, timeZone),
			end: isoWithOffset(endMs, timeZone),
			moved,
		}
	} catch {
		return null
	}
}

function nthWeekdayOfMonth(
	year: number,
	month: number,
	weekday: number,
	nth: number,
): string | null {
	// nth 5 means "last".
	const first = formatDate(year, month, 1)
	const offset = (weekday - dayOfWeek(first) + 7) % 7
	let day = 1 + offset + (Math.min(nth, 5) - 1) * 7
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
	if (nth >= 5) {
		while (day > daysInMonth) day -= 7
	} else if (day > daysInMonth) {
		return null
	}
	return formatDate(year, month, day)
}

/**
 * Every date the rule produces, in order, before exceptions. Bounded by the
 * rule's `until` / `count` and by `MAX_WALK_DAYS` from the first date.
 */
function* ruleDates(
	firstDate: string,
	recurrence: SiteEventRecurrence,
	/** A rule without `count` may start walking here (a few days before). */
	aroundDate?: string,
): Generator<string> {
	if (recurrence.frequency === 'none') {
		yield firstDate
		return
	}
	if (recurrence.frequency === 'dates') {
		const dates = [...new Set([firstDate, ...recurrence.dates])]
			.filter((date) => date >= firstDate)
			.sort()
		yield* dates
		return
	}
	const until = recurrence.until ?? null
	const count = recurrence.count ?? null
	// Without a count nothing depends on the dates before the window, so an
	// endless rule walks from (just before) the window, not from its start.
	const jumpTo =
		count === null && aroundDate && aroundDate > firstDate
			? addDays(aroundDate, -2)
			: null
	const limit = addDays(jumpTo ?? firstDate, MAX_WALK_DAYS)
	let produced = 0
	const emit = (date: string) => {
		if (date < firstDate) return false
		if (until && date > until) return null
		if (date > limit) return null
		if (count !== null && produced >= count) return null
		produced++
		return true
	}

	if (recurrence.frequency === 'weekly') {
		const interval = recurrence.interval ?? 1
		const weekdays = [...new Set(recurrence.weekdays)].sort((a, b) => a - b)
		// Week of the first date, starting Sunday.
		let weekStart = addDays(firstDate, -dayOfWeek(firstDate))
		if (jumpTo) {
			const weeks = Math.floor(
				(Date.parse(`${jumpTo}T00:00:00Z`) -
					Date.parse(`${weekStart}T00:00:00Z`)) /
					(7 * MS_PER_DAY),
			)
			weekStart = addDays(
				weekStart,
				Math.floor(weeks / interval) * interval * 7,
			)
		}
		for (;;) {
			for (const weekday of weekdays) {
				const date = addDays(weekStart, weekday)
				const ok = emit(date)
				if (ok === null) return
				if (ok) yield date
			}
			weekStart = addDays(weekStart, 7 * interval)
		}
	}

	// Monthly.
	const interval = recurrence.interval ?? 1
	const first = parseDate(firstDate)
	const weekday = dayOfWeek(firstDate)
	const nth = Math.ceil(first.day / 7)
	let startStep = 0
	if (jumpTo) {
		const target = parseDate(jumpTo)
		const months =
			(target.year - first.year) * 12 + (target.month - first.month) - 1
		startStep = Math.max(0, Math.floor(months / interval))
	}
	for (let step = startStep; ; step++) {
		const monthIndex = first.month - 1 + step * interval
		const year = first.year + Math.floor(monthIndex / 12)
		const month = (monthIndex % 12) + 1
		let date: string | null
		if (recurrence.mode === 'date') {
			const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
			date =
				first.day <= daysInMonth ? formatDate(year, month, first.day) : null
		} else {
			date = nthWeekdayOfMonth(year, month, weekday, nth)
		}
		if (date === null) {
			if (formatDate(year, month, 1) > limit) return
			continue
		}
		const ok = emit(date)
		if (ok === null) return
		if (ok) yield date
	}
}

/**
 * Occurrences that have not ended at `fromMs` (an ongoing one is included),
 * earliest first, at most `limit`. Skipped dates are left out; a moved one
 * keeps its date but uses its own times.
 */
export function expandOccurrences(
	schedule: SiteEventSchedule,
	options: { fromMs: number; limit?: number; untilMs?: number },
): SiteEventOccurrence[] {
	const check = validateEventTimes(schedule)
	if (!check.ok) return []
	const limit = Math.min(options.limit ?? MAX_LISTED_OCCURRENCES, 500)
	const firstDate = schedule.startLocal.slice(0, 10)
	const startTime = timeOf(schedule.startLocal)
	const skipped = new Set(schedule.exceptions?.skipped ?? [])
	const moved = new Map(
		(schedule.exceptions?.moved ?? []).map((entry) => [entry.date, entry]),
	)
	const out: SiteEventOccurrence[] = []
	const aroundDate = Number.isFinite(options.fromMs)
		? new Date(options.fromMs).toISOString().slice(0, 10)
		: undefined
	for (const date of ruleDates(firstDate, schedule.recurrence, aroundDate)) {
		if (out.length >= limit) break
		if (
			options.untilMs !== undefined &&
			Date.parse(`${date}T00:00:00Z`) - MS_PER_DAY > options.untilMs
		) {
			break
		}
		if (skipped.has(date)) continue
		const change = moved.get(date)
		const occurrence = change
			? occurrenceAt(date, change.start, change.end, 0, schedule.timezone, true)
			: occurrenceAt(
					date,
					startTime,
					null,
					check.minutes,
					schedule.timezone,
					false,
				)
		if (!occurrence || occurrence.endMs <= options.fromMs) continue
		if (options.untilMs !== undefined && occurrence.startMs > options.untilMs)
			break
		out.push(occurrence)
	}
	return out
}

/**
 * When the last occurrence ends, or null when the event repeats without end.
 */
export function lastOccurrenceEndMs(
	schedule: SiteEventSchedule,
): number | null {
	const { recurrence } = schedule
	if (
		(recurrence.frequency === 'weekly' || recurrence.frequency === 'monthly') &&
		!recurrence.until &&
		!recurrence.count
	) {
		return null
	}
	const all = expandOccurrences(schedule, {
		fromMs: Number.NEGATIVE_INFINITY,
		limit: 500,
	})
	return all.length ? all[all.length - 1]!.endMs : 0
}

export type SiteEventPhase =
	/** Has an occurrence that has not ended. */
	| 'upcoming'
	/** Over, page still answers (with "this event has ended"). */
	| 'ended'
	/** Over for more than 30 days: the page answers 410. */
	| 'gone'

export function eventPhase(
	schedule: SiteEventSchedule,
	nowMs: number,
): SiteEventPhase {
	if (expandOccurrences(schedule, { fromMs: nowMs, limit: 1 }).length) {
		return 'upcoming'
	}
	const lastEnd = lastOccurrenceEndMs(schedule) ?? 0
	return nowMs - lastEnd > EVENT_GONE_AFTER_DAYS * MS_PER_DAY ? 'gone' : 'ended'
}

/** The next occurrence, or `event_ended`. */
export function nextOccurrence(
	schedule: SiteEventSchedule,
	nowMs: number,
):
	| { ok: true; occurrence: SiteEventOccurrence }
	| { ok: false; error: 'event_ended' } {
	const [occurrence] = expandOccurrences(schedule, { fromMs: nowMs, limit: 1 })
	return occurrence
		? { ok: true, occurrence }
		: { ok: false, error: 'event_ended' }
}

/** Parse stored JSON, falling back to a one-off event. */
export function parseRecurrence(value: unknown): SiteEventRecurrence {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			raw = null
		}
	}
	const parsed = siteEventRecurrenceSchema.safeParse(raw)
	return parsed.success ? parsed.data : { frequency: 'none' }
}

export function parseExceptions(value: unknown): SiteEventExceptions {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			raw = null
		}
	}
	const parsed = siteEventExceptionsSchema.safeParse(raw ?? {})
	return parsed.success ? parsed.data : { skipped: [], moved: [] }
}

/** URL slug from a title: lower-case letters, digits and hyphens. */
export function slugifyTitle(value: string, fallback = 'event'): string {
	const slug = value
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
		.replace(/-+$/g, '')
	return slug || fallback
}

function icsEscape(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/\r?\n/g, '\\n')
		.replace(/([,;])/g, '\\$1')
}

function icsUtc(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '')
}

/** Fold lines longer than 75 octets (RFC 5545 3.1). */
function fold(line: string): string {
	const bytes = new TextEncoder().encode(line)
	if (bytes.length <= 75) return line
	const parts: string[] = []
	let current = ''
	let size = 0
	for (const char of line) {
		const charSize = new TextEncoder().encode(char).length
		if (size + charSize > (parts.length ? 74 : 75)) {
			parts.push(current)
			current = ''
			size = 0
		}
		current += char
		size += charSize
	}
	parts.push(current)
	return parts.join('\r\n ')
}

/**
 * An `.ics` calendar file with one VEVENT per occurrence (UTC times, so no
 * VTIMEZONE is needed). Public event text only.
 */
export function buildEventIcs(input: {
	uid: string
	host: string
	title: string
	description?: string | null
	location?: string | null
	url?: string | null
	occurrences: readonly SiteEventOccurrence[]
	nowMs: number
}): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Menuza//Website events//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
	]
	for (const occurrence of input.occurrences) {
		lines.push(
			'BEGIN:VEVENT',
			`UID:${input.uid}-${occurrence.date}@${input.host}`,
			`DTSTAMP:${icsUtc(input.nowMs)}`,
			`DTSTART:${icsUtc(occurrence.startMs)}`,
			`DTEND:${icsUtc(occurrence.endMs)}`,
			`SUMMARY:${icsEscape(input.title)}`,
		)
		if (input.description)
			lines.push(`DESCRIPTION:${icsEscape(input.description)}`)
		if (input.location) lines.push(`LOCATION:${icsEscape(input.location)}`)
		if (input.url) lines.push(`URL:${input.url}`)
		lines.push('END:VEVENT')
	}
	lines.push('END:VCALENDAR')
	return `${lines.map(fold).join('\r\n')}\r\n`
}
