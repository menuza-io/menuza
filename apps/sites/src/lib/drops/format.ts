import { getDropDisplayStatus, type DropStatus } from '@repo/common/menu-types'

export type DropPhase = 'live' | 'upcoming' | 'ended'

export type DropPhaseSource = {
	status: DropStatus | string
	ordersOpenAt: string | Date | null
	ordersCloseAt: string | Date | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Customer-facing phase of a drop at `now`. Drafts only reach Sites through
 * operator preview, where they behave like a live drop.
 */
export function getDropPhase(
	drop: DropPhaseSource,
	now: Date = new Date(),
): DropPhase {
	const stored = (drop.status === 'draft' ? 'live' : drop.status) as DropStatus
	const status = getDropDisplayStatus(
		stored,
		drop.ordersOpenAt,
		drop.ordersCloseAt,
		now,
	)
	if (status === 'scheduled') return 'upcoming'
	if (status === 'live') return 'live'
	return 'ended'
}

export function parseCalendarDate(
	date: string,
): { year: number; month: number; day: number } | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
	if (!match) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const day = Number(match[3])
	if (month < 1 || month > 12 || day < 1 || day > 31) return null
	return { year, month, day }
}

function parseClockTime(time: string): { hours: number; minutes: number } {
	const [h, m] = time.split(':').map(Number)
	return {
		hours: Number.isFinite(h) ? (h as number) : 0,
		minutes: Number.isFinite(m) ? (m as number) : 0,
	}
}

function timeZoneOffsetMs(utc: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(utc)
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value ?? 0)
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour') % 24,
		get('minute'),
		get('second'),
	)
	return asUtc - utc.getTime()
}

/**
 * Converts a wall-clock date/time in `timeZone` to the UTC instant. Pickup
 * windows are stored as `YYYY-MM-DD` + `HH:MM` in the location's timezone.
 */
export function zonedTimeToUtc(
	date: string,
	time: string,
	timeZone: string,
): Date | null {
	const parsed = parseCalendarDate(date)
	if (!parsed) return null
	const { hours, minutes } = parseClockTime(time)
	const guess = Date.UTC(
		parsed.year,
		parsed.month - 1,
		parsed.day,
		hours,
		minutes,
	)
	let utc = guess - timeZoneOffsetMs(new Date(guess), timeZone)
	// A second pass settles times that fall on a DST transition.
	utc = guess - timeZoneOffsetMs(new Date(utc), timeZone)
	return new Date(utc)
}

export function formatDropDate(
	date: string,
	locale: string,
	timeZone: string,
	options: { weekday?: boolean; year?: boolean } = {},
): string {
	const instant = zonedTimeToUtc(date, '12:00', timeZone)
	if (!instant) return date
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: options.weekday === false ? undefined : 'short',
		month: 'short',
		day: 'numeric',
		year: options.year ? 'numeric' : undefined,
	}).format(instant)
}

export function formatDropTime(
	value: string | Date,
	locale: string,
	timeZone: string,
): string {
	const instant = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(instant.getTime())) return ''
	return new Intl.DateTimeFormat(locale, {
		timeZone,
		hour: 'numeric',
		minute: '2-digit',
	}).format(instant)
}

/**
 * "Fri, Oct 9 · 6:00 PM". With `month: false` the date collapses to the
 * weekday ("Fri · 6:00 PM"), which only reads well for dates within a week.
 */
export function formatDropDateTime(
	iso: string | Date,
	locale: string,
	timeZone: string,
	options: { weekday?: boolean; month?: boolean; year?: boolean } = {},
): string {
	const instant = iso instanceof Date ? iso : new Date(iso)
	if (Number.isNaN(instant.getTime())) return ''
	const datePart = new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: options.weekday === false ? undefined : 'short',
		month: options.month === false ? undefined : 'short',
		day: options.month === false ? undefined : 'numeric',
		year: options.year ? 'numeric' : undefined,
	}).format(instant)
	return `${datePart} · ${formatDropTime(instant, locale, timeZone)}`
}

/** "9:30 AM – 12:00 PM" for a pickup window on `date` in `timeZone`. */
export function formatTimeRange(
	startTime: string,
	endTime: string,
	locale: string,
	timeZone: string,
	date: string,
): string {
	const start = zonedTimeToUtc(date, startTime, timeZone)
	const end = zonedTimeToUtc(date, endTime, timeZone)
	if (!start || !end) return `${startTime} – ${endTime}`
	const formatter = new Intl.DateTimeFormat(locale, {
		timeZone,
		hour: 'numeric',
		minute: '2-digit',
	})
	if (typeof formatter.formatRange === 'function') {
		return formatter.formatRange(start, end)
	}
	return `${formatter.format(start)} – ${formatter.format(end)}`
}

export type PickupSummaryLabels = {
	/** "{n} dates" */
	dates: string
	/** "{n} locations" */
	locations: string
}

/**
 * One-line pickup summary for cards: "Fri, Oct 9 · 4 locations",
 * "3 dates · Baxter Village". Returns an empty string without windows.
 */
export function summarizePickup(
	dates: string[],
	locationNames: string[],
	locale: string,
	timeZone: string,
	labels: PickupSummaryLabels,
): string {
	const uniqueDates = Array.from(new Set(dates)).sort()
	const uniqueLocations = Array.from(new Set(locationNames.filter(Boolean)))
	const parts: string[] = []
	if (uniqueDates.length === 1) {
		parts.push(formatDropDate(uniqueDates[0]!, locale, timeZone))
	} else if (uniqueDates.length > 1) {
		parts.push(
			labels.dates.replace('{n}', formatCount(uniqueDates.length, locale)),
		)
	}
	if (uniqueLocations.length === 1) {
		parts.push(uniqueLocations[0]!)
	} else if (uniqueLocations.length > 1) {
		parts.push(
			labels.locations.replace(
				'{n}',
				formatCount(uniqueLocations.length, locale),
			),
		)
	}
	return parts.join(' · ')
}

export type RemainingLabels = {
	/** "in {t}" */
	in: string
	/** "{n} days" */
	days: string
	/** "1 day" */
	oneDay: string
	/** "{h}h {m}m" */
	hoursMinutes: string
	/** "{n} min" */
	minutes: string
	/** "less than a minute" */
	lessThanMinute: string
}

/** "in 3h 12m", "in 2 days", "in 5 min". Negative durations read as "in less than a minute". */
export function formatRemaining(
	ms: number,
	labels: RemainingLabels,
	locale: string = 'en',
): string {
	const remaining = Math.max(0, ms)
	let text: string
	const days = Math.floor(remaining / DAY_MS)
	if (days >= 1) {
		text =
			days === 1
				? labels.oneDay
				: labels.days.replace('{n}', formatCount(days, locale))
	} else {
		const hours = Math.floor(remaining / HOUR_MS)
		const minutes = Math.floor((remaining % HOUR_MS) / MINUTE_MS)
		if (hours >= 1) {
			text = labels.hoursMinutes
				.replace('{h}', formatCount(hours, locale))
				.replace('{m}', formatCount(minutes, locale))
		} else if (minutes >= 1) {
			text = labels.minutes.replace('{n}', formatCount(minutes, locale))
		} else {
			text = labels.lessThanMinute
		}
	}
	return labels.in.replace('{t}', text)
}

function formatCount(value: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale).format(value)
	} catch {
		return String(value)
	}
}
