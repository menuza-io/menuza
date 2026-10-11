import { z } from 'zod'

/**
 * Staffing stores UTC instants plus the location's IANA time zone and the
 * local business date. These helpers convert between wall-clock time and
 * instants without a date library; they are the single implementation shared
 * by App and tenant-api so DST and overnight math cannot diverge.
 */

export const WEEK_STARTS = ['monday', 'sunday'] as const
export type WeekStart = (typeof WEEK_STARTS)[number]

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_MS = 24 * 60 * 60 * 1000

export function isLocalDate(value: string) {
	if (!LOCAL_DATE_RE.test(value)) return false
	const [year, month, day] = value.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const date = new Date(Date.UTC(year, month - 1, day))
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	)
}

export const localDateSchema = z
	.string()
	.refine(isLocalDate, { message: 'invalid_date' })
export const localTimeSchema = z
	.string()
	.regex(LOCAL_TIME_RE, { message: 'invalid_time' })

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string) {
	let cached = formatters.get(timeZone)
	if (!cached) {
		cached = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		})
		formatters.set(timeZone, cached)
	}
	return cached
}

export function isValidTimeZone(timeZone: string) {
	if (!timeZone) return false
	try {
		formatter(timeZone)
		return true
	} catch {
		return false
	}
}

export const timeZoneSchema = z
	.string()
	.min(1)
	.max(64)
	.refine(isValidTimeZone, { message: 'invalid_time_zone' })

function wallClockMs(instantMs: number, timeZone: string) {
	const parts: Record<string, number> = {}
	for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value)
	}
	return Date.UTC(
		parts.year!,
		parts.month! - 1,
		parts.day!,
		parts.hour!,
		parts.minute!,
		parts.second!,
	)
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (east positive). */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string) {
	const ms = Math.floor(instant.getTime() / 1000) * 1000
	return (wallClockMs(ms, timeZone) - ms) / 60000
}

function pad(value: number) {
	return String(value).padStart(2, '0')
}

function msToLocalDate(ms: number) {
	const date = new Date(ms)
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function localDateOf(instant: Date, timeZone: string) {
	return msToLocalDate(wallClockMs(instant.getTime(), timeZone))
}

export function localTimeOf(instant: Date, timeZone: string) {
	const date = new Date(wallClockMs(instant.getTime(), timeZone))
	return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function localDateMs(localDate: string) {
	const [year, month, day] = localDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return Date.UTC(year, month - 1, day)
}

export function addDays(localDate: string, days: number) {
	return msToLocalDate(localDateMs(localDate) + days * DAY_MS)
}

/** Whole days from `from` to `to` (both local dates). */
export function daysBetween(from: string, to: string) {
	return Math.round((localDateMs(to) - localDateMs(from)) / DAY_MS)
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(localDate: string) {
	return new Date(localDateMs(localDate)).getUTCDay()
}

export function startOfWeek(localDate: string, weekStart: WeekStart) {
	const day = dayOfWeek(localDate)
	const back = weekStart === 'sunday' ? day : (day + 6) % 7
	return addDays(localDate, -back)
}

export function weekDates(weekStartDate: string) {
	return Array.from({ length: 7 }, (ignoredValue, index) =>
		addDays(weekStartDate, index),
	)
}

/**
 * Converts a wall-clock time at a location to a UTC instant. In a DST gap the
 * nonexistent time moves forward by the gap; in a fold the earlier instant wins.
 */
export function zonedWallTimeToUtc(
	localDate: string,
	localTime: string,
	timeZone: string,
) {
	const [hour, minute] = localTime.split(':').map(Number) as [number, number]
	const wallMs = localDateMs(localDate) + (hour * 60 + minute) * 60000
	const offsets = new Set([
		timeZoneOffsetMinutes(new Date(wallMs - DAY_MS), timeZone),
		timeZoneOffsetMinutes(new Date(wallMs), timeZone),
		timeZoneOffsetMinutes(new Date(wallMs + DAY_MS), timeZone),
	])
	const matches = [...offsets]
		.map((offset) => wallMs - offset * 60000)
		.filter((candidate) => wallClockMs(candidate, timeZone) === wallMs)
		.sort((a, b) => a - b)
	if (matches.length > 0) return new Date(matches[0]!)
	const before = timeZoneOffsetMinutes(new Date(wallMs - DAY_MS), timeZone)
	return new Date(wallMs - before * 60000)
}

/**
 * Resolves a shift's wall-clock start/end to instants. An end at or before the
 * start is treated as the next day (an overnight shift such as 22:00–02:00).
 */
export function shiftInstants(input: {
	localDate: string
	startTime: string
	endTime: string
	timeZone: string
}) {
	const overnight = input.endTime <= input.startTime
	const startAt = zonedWallTimeToUtc(
		input.localDate,
		input.startTime,
		input.timeZone,
	)
	const endAt = zonedWallTimeToUtc(
		overnight ? addDays(input.localDate, 1) : input.localDate,
		input.endTime,
		input.timeZone,
	)
	return { startAt, endAt, overnight }
}

export function minutesBetween(start: Date, end: Date) {
	return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000))
}
