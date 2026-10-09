import {
	type DayOfWeek,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
	DAYS_OF_WEEK,
} from '@repo/common/location-types'
import { type FulfillmentMode } from './types.ts'

/**
 * Scheduled-order slots, computed in the location timezone from its online
 * hours (special hours override the week), prep time and
 * `scheduling.advanceOrderDays`. Display only: the tenant-api re-validates
 * `scheduledFor` when the order is placed.
 */

export type ScheduleLocation = {
	timezone?: string | null
	onlineHours?: unknown
	storeHours?: unknown
	specialHours?: unknown
	prepTime?: number | null
	scheduling?: unknown
}

export type ScheduleSlot = {
	/** ISO-8601 UTC instant sent as `scheduledFor`. */
	iso: string
	/** "HH:MM" in the location timezone. */
	localTime: string
	/** Locale-formatted time ("6:30 PM", "18:30"). */
	label: string
}

export type ScheduleDay = {
	/** "YYYY-MM-DD" in the location timezone. */
	date: string
	/** 0 = today, 1 = tomorrow, … (location timezone). */
	offset: number
	/** Short weekday ("Fri"). */
	weekday: string
	/** Short date ("Oct 10"). */
	dayMonth: string
	slots: ScheduleSlot[]
}

export const SCHEDULE_SLOT_MINUTES = 15
const DEFAULT_PREP_MINUTES = 15
const MAX_ADVANCE_DAYS = 30

function asArray<T>(value: unknown): T[] | null {
	if (!value) return null
	if (typeof value === 'string') {
		try {
			return asArray<T>(JSON.parse(value))
		} catch {
			return null
		}
	}
	return Array.isArray(value) ? (value as T[]) : null
}

export function schedulingSettings(location: ScheduleLocation): {
	enabled: boolean
	advanceOrderDays: number
} {
	const raw =
		typeof location.scheduling === 'string'
			? (() => {
					try {
						return JSON.parse(location.scheduling) as unknown
					} catch {
						return null
					}
				})()
			: location.scheduling
	const s = (raw ?? {}) as {
		scheduledOrdersEnabled?: unknown
		advanceOrderDays?: unknown
	}
	const days =
		typeof s.advanceOrderDays === 'number' &&
		Number.isFinite(s.advanceOrderDays)
			? Math.floor(s.advanceOrderDays)
			: 7
	return {
		enabled: s.scheduledOrdersEnabled === true,
		advanceOrderDays: Math.min(MAX_ADVANCE_DAYS, Math.max(1, days)),
	}
}

/** Wall-clock date/time of `instant` in `timezone`. */
export function zonedParts(
	instant: Date,
	timezone: string,
): { date: string; time: string } {
	const parts: Record<string, string> = {}
	try {
		for (const part of new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(instant)) {
			parts[part.type] = part.value
		}
	} catch {
		const iso = instant.toISOString()
		return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
	}
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
	}
}

/** Offset (ms) of `timezone` from UTC at `instant`. */
function zoneOffset(instant: Date, timezone: string): number {
	const { date, time } = zonedParts(instant, timezone)
	const wall = Date.parse(`${date}T${time}:00Z`)
	return wall - Math.floor(instant.getTime() / 60_000) * 60_000
}

/**
 * Local wall-clock time → UTC instant. Two passes so times right after a DST
 * change resolve with the offset in force at that moment.
 */
export function zonedTimeToUtc(
	date: string,
	time: string,
	timezone: string,
): Date {
	const wall = Date.parse(`${date}T${time}:00Z`)
	const guess = wall - zoneOffset(new Date(wall), timezone)
	return new Date(wall - zoneOffset(new Date(guess), timezone))
}

function addDays(date: string, days: number): { date: string; day: DayOfWeek } {
	const base = new Date(`${date}T00:00:00Z`)
	base.setUTCDate(base.getUTCDate() + days)
	// getUTCDay: 0 = Sunday; DAYS_OF_WEEK starts on Monday.
	const index = (base.getUTCDay() + 6) % 7
	return {
		date: base.toISOString().slice(0, 10),
		day: DAYS_OF_WEEK[index] ?? 'monday',
	}
}

const toMinutes = (time: string): number => {
	const [h = 0, m = 0] = time.split(':').map(Number)
	return h * 60 + m
}
const fromMinutes = (minutes: number): string =>
	`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** Open intervals (minutes since local midnight) for one local date. */
function openIntervals(
	date: string,
	day: DayOfWeek,
	schedule: WeeklySchedule | null,
	special: SpecialHour[],
): Array<[number, number]> {
	const override = special.find((entry) => entry.date === date)
	let slots: TimeSlot[]
	if (override) {
		slots = override.isOpen ? (override.slots ?? []) : []
	} else if (!schedule || schedule.length === 0) {
		// Same rule as `isLocationOpenForOrdering`: no schedule means open.
		return [[0, 24 * 60 - 1]]
	} else {
		const entry = schedule.find((candidate) => candidate.day === day)
		slots = entry?.isOpen ? (entry.slots ?? []) : []
	}
	return slots
		.map((slot): [number, number] => {
			const start = toMinutes(slot.start)
			const end = toMinutes(slot.end)
			// Overnight slots ("18:00"–"02:00") are offered until midnight.
			return [start, end <= start ? 24 * 60 - 1 : end]
		})
		.sort((a, b) => a[0] - b[0])
}

/**
 * Minutes from now until the earliest schedulable time: prep time, plus
 * the minimum delivery ETA for delivery orders.
 */
export function scheduleLeadMinutes(
	location: ScheduleLocation,
	mode: FulfillmentMode,
	deliveryEtaMin = 0,
): number {
	const prep =
		typeof location.prepTime === 'number' && location.prepTime > 0
			? location.prepTime
			: DEFAULT_PREP_MINUTES
	return prep + (mode === 'delivery' ? Math.max(0, deliveryEtaMin) : 0)
}

export function buildScheduleDays(
	location: ScheduleLocation,
	options: {
		now?: Date
		locale: string
		mode: FulfillmentMode
		deliveryEtaMin?: number
		slotMinutes?: number
	},
): ScheduleDay[] {
	const settings = schedulingSettings(location)
	if (!settings.enabled) return []
	const timezone = location.timezone || 'UTC'
	const now = options.now ?? new Date()
	const step = options.slotMinutes ?? SCHEDULE_SLOT_MINUTES
	const schedule =
		asArray<WeeklySchedule[number]>(location.onlineHours) ??
		asArray<WeeklySchedule[number]>(location.storeHours)
	const special = asArray<SpecialHour>(location.specialHours) ?? []
	const earliest =
		now.getTime() +
		scheduleLeadMinutes(location, options.mode, options.deliveryEtaMin) * 60_000

	const today = zonedParts(now, timezone).date
	let timeFormat: Intl.DateTimeFormat
	let weekdayFormat: Intl.DateTimeFormat
	let dayMonthFormat: Intl.DateTimeFormat
	try {
		timeFormat = new Intl.DateTimeFormat(options.locale, {
			timeZone: timezone,
			hour: 'numeric',
			minute: '2-digit',
		})
		weekdayFormat = new Intl.DateTimeFormat(options.locale, {
			timeZone: 'UTC',
			weekday: 'short',
		})
		dayMonthFormat = new Intl.DateTimeFormat(options.locale, {
			timeZone: 'UTC',
			month: 'short',
			day: 'numeric',
		})
	} catch {
		timeFormat = new Intl.DateTimeFormat('en', {
			timeZone: 'UTC',
			hour: 'numeric',
			minute: '2-digit',
		})
		weekdayFormat = new Intl.DateTimeFormat('en', {
			timeZone: 'UTC',
			weekday: 'short',
		})
		dayMonthFormat = new Intl.DateTimeFormat('en', {
			timeZone: 'UTC',
			month: 'short',
			day: 'numeric',
		})
	}

	const days: ScheduleDay[] = []
	for (let offset = 0; offset < settings.advanceOrderDays; offset += 1) {
		const { date, day } = addDays(today, offset)
		const slots: ScheduleSlot[] = []
		const seen = new Set<string>()
		for (const [start, end] of openIntervals(date, day, schedule, special)) {
			const first = Math.ceil(start / step) * step
			for (let minute = first; minute <= end; minute += step) {
				const localTime = fromMinutes(minute)
				if (seen.has(localTime)) continue
				const instant = zonedTimeToUtc(date, localTime, timezone)
				if (instant.getTime() < earliest) continue
				// Skip wall-clock times that do not exist (DST spring-forward).
				if (zonedParts(instant, timezone).time !== localTime) continue
				seen.add(localTime)
				slots.push({
					iso: instant.toISOString(),
					localTime,
					label: timeFormat.format(instant),
				})
			}
		}
		if (!slots.length) continue
		const noonUtc = new Date(`${date}T12:00:00Z`)
		days.push({
			date,
			offset,
			weekday: weekdayFormat.format(noonUtc),
			dayMonth: dayMonthFormat.format(noonUtc),
			slots,
		})
	}
	return days
}

/** True when `iso` is one of the offered slots (stale choices are dropped). */
export function findSlot(
	days: ScheduleDay[],
	iso: string | null | undefined,
): { day: ScheduleDay; slot: ScheduleSlot } | null {
	if (!iso) return null
	const at = Date.parse(iso)
	if (!Number.isFinite(at)) return null
	for (const day of days) {
		const slot = day.slots.find((candidate) => Date.parse(candidate.iso) === at)
		if (slot) return { day, slot }
	}
	return null
}

/**
 * Short label for a scheduled time in the location timezone, e.g.
 * "Fri 6:30 PM". Today/tomorrow wording is left to the caller's labels.
 */
export function formatScheduledFor(
	iso: string,
	locale: string,
	timezone: string,
	now: Date = new Date(),
): { offset: number; weekday: string; time: string } | null {
	const at = new Date(iso)
	if (Number.isNaN(at.getTime())) return null
	const zone = timezone || 'UTC'
	const target = zonedParts(at, zone).date
	const today = zonedParts(now, zone).date
	const offset = Math.round(
		(Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
			86_400_000,
	)
	try {
		return {
			offset,
			weekday: new Intl.DateTimeFormat(locale, {
				timeZone: zone,
				weekday: 'short',
			}).format(at),
			time: new Intl.DateTimeFormat(locale, {
				timeZone: zone,
				hour: 'numeric',
				minute: '2-digit',
			}).format(at),
		}
	} catch {
		return { offset, weekday: '', time: at.toISOString().slice(11, 16) }
	}
}
