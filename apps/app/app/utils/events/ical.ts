/**
 * Reads an iCalendar feed (a Google Calendar's public or secret address) into
 * event occurrences for the website's events (#319). Pure and read-only: it
 * parses text and never fetches or writes anything.
 *
 * - Every text field is untrusted. It is cut to a length, stripped of control
 *   characters and kept as PLAIN TEXT: markup in a title or description stays
 *   inert text and is never interpreted or rendered as HTML.
 * - Recurring events are expanded for a window (the next 90 days) on the
 *   calendar's own wall clock with `@repo/zoned-time`, so a weekly 20:00 event
 *   stays at 20:00 across a daylight-saving change.
 * - A cancelled event (`STATUS:CANCELLED`), a cancelled instance (`EXDATE`) and
 *   a moved instance (`RECURRENCE-ID`) are applied; a cancelled one is simply
 *   not in the result, so it disappears from the site at the next update.
 * - Limits keep a hostile or huge feed cheap: size, number of events, length
 *   of every field and a cap on occurrences.
 */
import {
	addDays,
	dayOfWeek,
	formatDate,
	isValidTimeZone,
	localParts,
	parseDate,
	parseLocalTimestamp,
} from '@repo/zoned-time'

export const ICAL_MAX_BYTES = 2 * 1024 * 1024
export const ICAL_MAX_EVENTS = 2000
export const ICAL_MAX_OCCURRENCES = 200
export const ICAL_WINDOW_DAYS = 90
export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 2000
export const LOCATION_MAX = 300
const MAX_EVENT_MINUTES = 24 * 60
/** Safety cap on how many rule steps one event may walk. */
const MAX_RULE_STEPS = 4000

export type CalendarOccurrence = {
	/** The calendar's own id for this occurrence: `UID` plus the instance. */
	key: string
	title: string
	description: string
	location: string
	/** Wall clock in `timezone`: `YYYY-MM-DDTHH:mm`. */
	startLocal: string
	endLocal: string
	timezone: string
}

export type ParsedCalendar = {
	ok: true
	name: string | null
	timezone: string | null
	occurrences: CalendarOccurrence[]
	/** Events in the feed that could not be read (bad dates, unsupported rules). */
	skipped: number
}

export type ParseError = { ok: false; error: 'invalid_calendar' | 'too_large' }

type Property = { name: string; params: Map<string, string>; value: string }

/** Unfold continuation lines and split into properties. */
function readProperties(text: string): Property[] {
	const lines: string[] = []
	for (const raw of text.replace(/\r\n?/gu, '\n').split('\n')) {
		if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) {
			lines[lines.length - 1] += raw.slice(1)
		} else {
			lines.push(raw)
		}
	}
	const out: Property[] = []
	for (const line of lines) {
		if (!line) continue
		const colon = findValueColon(line)
		if (colon < 1) continue
		const [name, ...rawParams] = line.slice(0, colon).split(';')
		const params = new Map<string, string>()
		for (const param of rawParams) {
			const eq = param.indexOf('=')
			if (eq > 0) {
				params.set(
					param.slice(0, eq).toUpperCase(),
					param.slice(eq + 1).replace(/^"|"$/gu, ''),
				)
			}
		}
		out.push({
			name: name!.toUpperCase(),
			params,
			value: line.slice(colon + 1),
		})
	}
	return out
}

/** The colon that ends the name and parameters (not one inside quotes). */
function findValueColon(line: string) {
	let quoted = false
	for (let i = 0; i < line.length; i++) {
		const char = line[i]
		if (char === '"') quoted = !quoted
		else if (char === ':' && !quoted) return i
	}
	return -1
}

/** Plain text: iCalendar escapes undone, controls and bidi tricks removed, cut to a length. */
export function plainText(value: string, max: number): string {
	return (
		value
			.replace(/\\n/giu, '\n')
			.replace(/\\([,;\\])/gu, '$1')
			// Control characters (but not a line break) and invisible direction
			// overrides, which can disguise text.
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/gu, '')
			.replace(/[ \t]+/gu, ' ')
			.replace(/\n{3,}/gu, '\n\n')
			.trim()
			.slice(0, max)
	)
}

/** A title or place is one line: a line break in it would break a file or a list. */
function singleLine(value: string) {
	return value.replace(/\s*\n\s*/gu, ' ').trim()
}

type When =
	| { kind: 'date'; date: string }
	| { kind: 'local'; local: string; timezone: string | null }
	| { kind: 'utc'; ms: number }

/** DTSTART, DTEND, EXDATE, RECURRENCE-ID values. */
function readWhen(property: Property): When | null {
	const value = property.value.trim()
	if (property.params.get('VALUE') === 'DATE' || /^\d{8}$/u.test(value)) {
		const match = /^(\d{4})(\d{2})(\d{2})/u.exec(value)
		if (!match) return null
		const date = `${match[1]}-${match[2]}-${match[3]}`
		return validDate(date) ? { kind: 'date', date } : null
	}
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/u.exec(
		value,
	)
	if (!match) return null
	const date = `${match[1]}-${match[2]}-${match[3]}`
	if (!validDate(date)) return null
	const hour = Number(match[4])
	const minute = Number(match[5])
	if (hour > 23 || minute > 59) return null
	const local = `${date}T${match[4]}:${match[5]}`
	if (match[7]) {
		try {
			return { kind: 'utc', ms: parseLocalTimestamp(local, 'UTC') }
		} catch {
			return null
		}
	}
	const tzid = property.params.get('TZID')
	return {
		kind: 'local',
		local,
		timezone: tzid && isValidTimeZone(tzid) ? tzid : null,
	}
}

function validDate(date: string) {
	const { year, month, day } = parseDate(date)
	const d = new Date(Date.UTC(year, month - 1, day))
	return (
		year >= 1970 &&
		year <= 2100 &&
		d.getUTCMonth() === month - 1 &&
		d.getUTCDate() === day
	)
}

type Wall = { date: string; time: string; timezone: string }

/** A moment on the wall clock of `zone` (UTC moments are converted). */
function toWall(when: When, fallbackZone: string): Wall | null {
	if (when.kind === 'date') {
		return { date: when.date, time: '00:00', timezone: fallbackZone }
	}
	if (when.kind === 'utc') {
		const p = localParts(when.ms, fallbackZone)
		return {
			date: formatDate(p.year, p.month, p.day),
			time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
			timezone: fallbackZone,
		}
	}
	return {
		date: when.local.slice(0, 10),
		time: when.local.slice(11, 16),
		timezone: when.timezone ?? fallbackZone,
	}
}

function wallMinutes(
	a: { date: string; time: string },
	b: { date: string; time: string },
) {
	return (
		(Date.parse(`${b.date}T${b.time}:00Z`) -
			Date.parse(`${a.date}T${a.time}:00Z`)) /
		60_000
	)
}

type Rule = {
	freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
	interval: number
	count: number | null
	until: string | null
	byDay: Array<{ ordinal: number | null; day: number }>
	byMonthDay: number[]
	byMonth: number[]
}

const DAY_CODES: Record<string, number> = {
	SU: 0,
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
}

function readRule(value: string): Rule | null {
	const parts = new Map<string, string>()
	for (const part of value.split(';')) {
		const eq = part.indexOf('=')
		if (eq > 0) parts.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1))
	}
	const freq = parts.get('FREQ')
	if (
		freq !== 'DAILY' &&
		freq !== 'WEEKLY' &&
		freq !== 'MONTHLY' &&
		freq !== 'YEARLY'
	) {
		return null
	}
	const interval = Math.max(
		1,
		Math.min(52, Number(parts.get('INTERVAL') ?? 1) || 1),
	)
	const countRaw = parts.get('COUNT')
	const count = countRaw
		? Math.max(1, Math.min(1000, Number(countRaw) || 1))
		: null
	let until: string | null = null
	const untilRaw = parts.get('UNTIL')
	if (untilRaw) {
		const m = /^(\d{4})(\d{2})(\d{2})/u.exec(untilRaw)
		if (m) until = `${m[1]}-${m[2]}-${m[3]}`
	}
	const byDay: Rule['byDay'] = []
	for (const token of (parts.get('BYDAY') ?? '').split(',')) {
		const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/u.exec(
			token.trim().toUpperCase(),
		)
		if (m)
			byDay.push({
				ordinal: m[1] ? Number(m[1]) : null,
				day: DAY_CODES[m[2]!]!,
			})
	}
	const numbers = (key: string, min: number, max: number) =>
		(parts.get(key) ?? '')
			.split(',')
			.map(Number)
			.filter((n) => Number.isInteger(n) && n >= min && n <= max && n !== 0)
	return {
		freq,
		interval,
		count,
		until,
		byDay,
		byMonthDay: numbers('BYMONTHDAY', -31, 31),
		byMonth: numbers('BYMONTH', 1, 12),
	}
}

function daysInMonth(year: number, month: number) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The nth weekday of a month (`ordinal` 1..5, or -1 for the last). */
function nthWeekday(year: number, month: number, day: number, ordinal: number) {
	const total = daysInMonth(year, month)
	if (ordinal > 0) {
		const first = dayOfWeek(formatDate(year, month, 1))
		const date = 1 + ((day - first + 7) % 7) + (ordinal - 1) * 7
		return date <= total ? date : null
	}
	const last = dayOfWeek(formatDate(year, month, total))
	const date = total - ((last - day + 7) % 7) + (ordinal + 1) * 7
	return date >= 1 ? date : null
}

/**
 * Local dates of a rule from its first date, in order. Walks calendar dates,
 * never adds 24 hours, and stops at the end of the window or a safety cap.
 */
function* ruleDates(
	first: string,
	rule: Rule,
	lastDate: string,
): Generator<string> {
	let produced = 0
	let steps = 0
	const emit = (date: string) => {
		if (date < first) return false
		if (rule.until && date > rule.until) return null
		if (date > lastDate) return null
		produced++
		return rule.count !== null && produced > rule.count ? null : true
	}
	const start = parseDate(first)
	if (rule.freq === 'DAILY') {
		for (
			let d = first;
			steps < MAX_RULE_STEPS;
			d = addDays(d, rule.interval), steps++
		) {
			const verdict = emit(d)
			if (verdict === null) return
			if (verdict) yield d
		}
		return
	}
	if (rule.freq === 'WEEKLY') {
		const days = rule.byDay.length
			? rule.byDay.map((d) => d.day)
			: [dayOfWeek(first)]
		// Week starts on Monday: step whole weeks from the week of `first`.
		const weekStart = addDays(first, -((dayOfWeek(first) + 6) % 7))
		for (
			let week = weekStart;
			steps < MAX_RULE_STEPS;
			week = addDays(week, 7 * rule.interval), steps++
		) {
			if (week > lastDate) return
			const dates = days.map((day) => addDays(week, (day + 6) % 7)).sort()
			for (const date of dates) {
				const verdict = emit(date)
				if (verdict === null) return
				if (verdict) yield date
			}
		}
		return
	}
	if (rule.freq === 'MONTHLY') {
		let year = start.year
		let month = start.month
		for (; steps < MAX_RULE_STEPS; steps++) {
			if (formatDate(year, month, 1) > lastDate) return
			const dates: string[] = []
			if (rule.byDay.length) {
				for (const entry of rule.byDay) {
					if (entry.ordinal === null) {
						for (let day = 1; day <= daysInMonth(year, month); day++) {
							if (dayOfWeek(formatDate(year, month, day)) === entry.day) {
								dates.push(formatDate(year, month, day))
							}
						}
					} else {
						const day = nthWeekday(year, month, entry.day, entry.ordinal)
						if (day) dates.push(formatDate(year, month, day))
					}
				}
			} else if (rule.byMonthDay.length) {
				for (const n of rule.byMonthDay) {
					const day = n > 0 ? n : daysInMonth(year, month) + n + 1
					if (day >= 1 && day <= daysInMonth(year, month)) {
						dates.push(formatDate(year, month, day))
					}
				}
			} else if (start.day <= daysInMonth(year, month)) {
				dates.push(formatDate(year, month, start.day))
			}
			for (const date of dates.sort()) {
				const verdict = emit(date)
				if (verdict === null) return
				if (verdict) yield date
			}
			month += rule.interval
			while (month > 12) {
				month -= 12
				year++
			}
		}
		return
	}
	// YEARLY
	for (
		let year = start.year;
		steps < MAX_RULE_STEPS;
		year += rule.interval, steps++
	) {
		if (formatDate(year, 1, 1) > lastDate) return
		const months = rule.byMonth.length ? rule.byMonth : [start.month]
		const dates: string[] = []
		for (const month of months) {
			if (rule.byDay.length) {
				for (const entry of rule.byDay) {
					const day = nthWeekday(year, month, entry.day, entry.ordinal ?? 1)
					if (day) dates.push(formatDate(year, month, day))
				}
			} else if (start.day <= daysInMonth(year, month)) {
				dates.push(formatDate(year, month, start.day))
			}
		}
		for (const date of dates.sort()) {
			const verdict = emit(date)
			if (verdict === null) return
			if (verdict) yield date
		}
	}
}

type RawEvent = {
	uid: string
	title: string
	description: string
	location: string
	status: string
	start: When | null
	end: When | null
	durationMinutes: number | null
	rule: Rule | null
	exdates: When[]
	rdates: When[]
	recurrenceId: When | null
}

function readDuration(value: string): number | null {
	const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/u.exec(
		value.trim(),
	)
	if (!m) return null
	return (
		Number(m[1] ?? 0) * 7 * 1440 +
		Number(m[2] ?? 0) * 1440 +
		Number(m[3] ?? 0) * 60 +
		Number(m[4] ?? 0)
	)
}

function readEvents(properties: Property[]): {
	events: RawEvent[]
	name: string | null
	timezone: string | null
	tooMany: boolean
} {
	const events: RawEvent[] = []
	let current: RawEvent | null = null
	let depth = 0
	let name: string | null = null
	let timezone: string | null = null
	let tooMany = false
	for (const property of properties) {
		if (property.name === 'BEGIN') {
			const kind = property.value.trim().toUpperCase()
			if (kind === 'VEVENT' && !current) {
				if (events.length >= ICAL_MAX_EVENTS) {
					tooMany = true
					continue
				}
				current = {
					uid: '',
					title: '',
					description: '',
					location: '',
					status: '',
					start: null,
					end: null,
					durationMinutes: null,
					rule: null,
					exdates: [],
					rdates: [],
					recurrenceId: null,
				}
				depth = 0
			} else if (current) {
				depth++ // a nested VALARM
			}
			continue
		}
		if (property.name === 'END') {
			const kind = property.value.trim().toUpperCase()
			if (current && depth > 0) {
				depth--
			} else if (current && kind === 'VEVENT') {
				events.push(current)
				current = null
			}
			continue
		}
		if (!current) {
			if (property.name === 'X-WR-CALNAME')
				name = plainText(property.value, 120) || null
			if (
				property.name === 'X-WR-TIMEZONE' &&
				isValidTimeZone(property.value.trim())
			) {
				timezone = property.value.trim()
			}
			continue
		}
		if (depth > 0) continue
		switch (property.name) {
			case 'UID':
				current.uid = property.value.trim().slice(0, 300)
				break
			case 'SUMMARY':
				current.title = singleLine(plainText(property.value, TITLE_MAX))
				break
			case 'DESCRIPTION':
				current.description = plainText(property.value, DESCRIPTION_MAX)
				break
			case 'LOCATION':
				current.location = singleLine(plainText(property.value, LOCATION_MAX))
				break
			case 'STATUS':
				current.status = property.value.trim().toUpperCase()
				break
			case 'DTSTART':
				current.start = readWhen(property)
				break
			case 'DTEND':
				current.end = readWhen(property)
				break
			case 'DURATION':
				current.durationMinutes = readDuration(property.value)
				break
			case 'RRULE':
				current.rule = readRule(property.value)
				break
			case 'EXDATE':
				for (const part of property.value.split(',')) {
					const when = readWhen({ ...property, value: part })
					if (when) current.exdates.push(when)
				}
				break
			case 'RDATE':
				for (const part of property.value.split(',')) {
					const when = readWhen({ ...property, value: part })
					if (when) current.rdates.push(when)
				}
				break
			case 'RECURRENCE-ID':
				current.recurrenceId = readWhen(property)
				break
		}
	}
	return { events, name, timezone, tooMany }
}

type Window = { fromMs: number; untilMs: number }

function occurrenceFor(
	wall: Wall,
	minutes: number,
	allDay: boolean,
): { startLocal: string; endLocal: string; timezone: string } | null {
	const startLocal = `${wall.date}T${wall.time}`
	let length = minutes
	let end: string
	if (allDay) {
		// A whole day (or several, cut to one) runs 00:00 to 23:59.
		end = `${wall.date}T23:59`
		length = Math.min(length, MAX_EVENT_MINUTES - 1)
		if (length <= 0) length = MAX_EVENT_MINUTES - 1
		return { startLocal, endLocal: end, timezone: wall.timezone }
	}
	if (!(length > 0)) length = 60
	length = Math.min(length, MAX_EVENT_MINUTES)
	const startMs = Date.parse(`${startLocal}:00Z`)
	end = new Date(startMs + length * 60_000).toISOString().slice(0, 16)
	return { startLocal, endLocal: end, timezone: wall.timezone }
}

/**
 * Reads a feed. `defaultTimezone` is the calendar's zone (a location's):
 * it places floating and UTC times and all-day events.
 */
export function parseCalendar(
	text: string,
	options: {
		defaultTimezone: string
		now?: number
		windowDays?: number
	},
): ParsedCalendar | ParseError {
	if (typeof text !== 'string') return { ok: false, error: 'invalid_calendar' }
	if (text.length > ICAL_MAX_BYTES) return { ok: false, error: 'too_large' }
	const trimmed = text.replace(/^﻿/u, '').trimStart()
	// A feed cut off before its end is refused: it must never look like a calendar
	// with fewer events.
	if (
		!/^BEGIN:VCALENDAR/iu.test(trimmed) ||
		!/^END:VCALENDAR/imu.test(trimmed)
	) {
		return { ok: false, error: 'invalid_calendar' }
	}
	const { events, name, timezone, tooMany } = readEvents(
		readProperties(trimmed),
	)
	const defaultZone = isValidTimeZone(options.defaultTimezone)
		? options.defaultTimezone
		: (timezone ?? 'UTC')
	const now = options.now ?? Date.now()
	const window: Window = {
		fromMs: now,
		untilMs: now + (options.windowDays ?? ICAL_WINDOW_DAYS) * 86_400_000,
	}
	const lastDate = new Date(window.untilMs).toISOString().slice(0, 10)

	// Moved instances replace the one they point at; cancelled ones are dropped.
	const overrides = new Map<string, RawEvent>()
	const masters: RawEvent[] = []
	for (const event of events) {
		if (event.recurrenceId && event.uid) {
			const at = readWall(event.recurrenceId, defaultZone)
			if (at) overrides.set(`${event.uid}|${at.date}T${at.time}`, event)
		} else {
			masters.push(event)
		}
	}

	const out: CalendarOccurrence[] = []
	const seen = new Set<string>()
	let skipped = tooMany ? 1 : 0
	const push = (
		raw: RawEvent,
		uid: string,
		instance: string,
		wall: Wall,
		minutes: number,
		allDay: boolean,
	) => {
		if (raw.status === 'CANCELLED') return
		const times = occurrenceFor(wall, minutes, allDay)
		if (!times) return
		let endMs: number
		let startMs: number
		try {
			startMs = parseLocalTimestamp(times.startLocal, times.timezone)
			endMs = parseLocalTimestamp(times.endLocal, times.timezone)
		} catch {
			skipped++
			return
		}
		// Past the window, or already over.
		if (endMs <= window.fromMs || startMs > window.untilMs) return
		const title = raw.title || 'Untitled event'
		// A one-off event keeps its id when the calendar moves or renames it, and
		// a repeating one is told apart by the date of each instance, never by its
		// time: what the operator added (hidden, photo, link) stays with it.
		const key = instance ? `${uid}|${instance}` : uid
		if (seen.has(key)) return
		seen.add(key)
		out.push({
			key,
			title,
			description: raw.description,
			location: raw.location,
			...times,
		})
	}

	for (const raw of masters) {
		if (!raw.uid || !raw.start) {
			skipped++
			continue
		}
		const wall = toWall(raw.start, defaultZone)
		if (!wall) {
			skipped++
			continue
		}
		const allDay = raw.start.kind === 'date'
		let minutes: number
		if (raw.end) {
			const endWall = toWall(raw.end, wall.timezone)
			if (!endWall) {
				skipped++
				continue
			}
			minutes = allDay
				? wallMinutes(wall, endWall)
				: wallMinutes(wall, {
						date: endWall.date,
						time: endWall.time,
					})
		} else if (raw.durationMinutes !== null) {
			minutes = raw.durationMinutes
		} else {
			minutes = allDay ? MAX_EVENT_MINUTES - 1 : 60
		}
		const excluded = new Set(
			raw.exdates.flatMap((when) => {
				const w = toWall(when, wall.timezone)
				return w ? [`${w.date}T${allDay ? '00:00' : w.time}`] : []
			}),
		)
		const repeating = Boolean(raw.rule) || raw.rdates.length > 0
		const instances: Array<{ date: string; time: string }> = []
		if (raw.rule) {
			for (const date of ruleDates(wall.date, raw.rule, lastDate)) {
				instances.push({ date, time: wall.time })
			}
		} else {
			instances.push({ date: wall.date, time: wall.time })
		}
		for (const when of raw.rdates) {
			const w = toWall(when, wall.timezone)
			if (w) instances.push({ date: w.date, time: allDay ? '00:00' : w.time })
		}
		for (const instance of instances) {
			const id = `${instance.date}T${instance.time}`
			if (excluded.has(id)) continue
			const override = overrides.get(`${raw.uid}|${id}`)
			if (override?.start) {
				const moved = toWall(override.start, wall.timezone)
				if (!moved) continue
				const endWall = override.end
					? toWall(override.end, moved.timezone)
					: null
				const movedMinutes = endWall ? wallMinutes(moved, endWall) : minutes
				push(
					{
						...override,
						title: override.title || raw.title,
						description: override.description || raw.description,
						location: override.location || raw.location,
					},
					raw.uid,
					repeating ? instance.date : '',
					moved,
					movedMinutes,
					override.start.kind === 'date',
				)
				continue
			}
			push(
				raw,
				raw.uid,
				repeating ? instance.date : '',
				{ date: instance.date, time: instance.time, timezone: wall.timezone },
				minutes,
				allDay,
			)
			if (out.length >= ICAL_MAX_OCCURRENCES * 4) break
		}
	}

	out.sort(
		(a, b) =>
			a.startLocal.localeCompare(b.startLocal) || a.key.localeCompare(b.key),
	)
	if (out.length > ICAL_MAX_OCCURRENCES) out.length = ICAL_MAX_OCCURRENCES
	return { ok: true, name, timezone, occurrences: out, skipped }
}

function readWall(when: When, fallbackZone: string) {
	return toWall(when, fallbackZone)
}
