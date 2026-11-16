import {
	activeBusyExtraPrepMinutes,
	type BusyMode,
	isOrderingPaused,
	type OrderingPause,
} from '@repo/common/location-availability'
import {
	buildOnlineHours,
	localDateInZone,
	type AvailableTimeSlot,
} from '@repo/common/available-times'
import { parseSlotLimitSettings } from '@repo/common/location-settings'
import { locationOpenIntervals, rangesForDate } from '@repo/opening-hours'
import {
	addDays,
	daysBetween,
	localMinutesSinceMidnight,
	localParts,
	parseDate,
	zonedLocalToUtc,
} from '@repo/zoned-time'

import { getBrowserTenantApiUrl } from '../client-auth.ts'
import { type FulfillmentMode } from './types.ts'

/**
 * Scheduled-order slots, computed in the location timezone from its online
 * hours (special hours override the week), prep time and
 * `scheduling.advanceOrderDays`. Display only: the tenant-api re-validates
 * `scheduledFor` when the order is placed.
 */

export type ScheduleLocation = {
	id?: string
	timezone?: string | null
	onlineHours?: unknown
	storeHours?: unknown
	specialHours?: unknown
	onlineOrderingSettings?: unknown
	slotLimitSettings?: unknown
	isActive?: boolean | null
	prepTime?: number | null
	scheduling?: unknown
	/** Operator pause: no slots before it ends (none at all when open-ended). */
	orderingPause?: OrderingPause | null
	/** Busy mode: its minutes push the earliest slot back. */
	busyMode?: BusyMode | null
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

export type AvailableTimesResponse = {
	slots: AvailableTimeSlot[]
	earliest: string | null
}

function formatHm(hour: number, minute: number): string {
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Minute ranges for one date; mirrors `locationOpenIntervals` with 15-minute slot alignment. */
function minuteRangesForDate(
	hours: ReturnType<typeof buildOnlineHours>,
	date: string,
): Array<[number, number]> {
	const intervals = locationOpenIntervals(hours, date, date, 'online')
	if (intervals === null) {
		const { ranges, rule } = rangesForDate(hours, date, 'online')
		if (rule.kind === 'unrestricted') return [[0, 24 * 60 - 1]]
		return ranges
	}
	if (!intervals.length) return []
	return intervals.map((iv) => {
		const from = localMinutesSinceMidnight(iv.startMs, hours.timeZone)
		const to = Math.max(
			from,
			localMinutesSinceMidnight(iv.endMs - 60_000, hours.timeZone),
		)
		return [from, to] as [number, number]
	})
}

function wallClockMatchesInstant(
	ms: number,
	date: string,
	localTime: string,
	timeZone: string,
): boolean {
	const p = localParts(ms, timeZone)
	const hhmm = formatHm(p.hour, p.minute)
	if (hhmm !== localTime) return false
	const expected = localDateInZone(ms, timeZone)
	return expected === date
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

/** True when org and location slot limits are on (browser may call available-times). */
export function slotLimitsActive(
	location: ScheduleLocation,
	orgSlotLimitsEnabled?: boolean,
): boolean {
	if (!orgSlotLimitsEnabled) return false
	return parseSlotLimitSettings(location.slotLimitSettings)?.enabled === true
}

/**
 * Per-date slot capacity from the regional tenant-api (`GET /orders/available-times`).
 * Returns `null` when limits are off or the node refuses the route.
 */
export async function fetchAvailableTimes(options: {
	locationId: string
	fulfillment: FulfillmentMode
	date: string
	orgSlug?: string | null
	host?: string | null
	tenantApiUrl?: string
	signal?: AbortSignal
}): Promise<AvailableTimesResponse | null> {
	let base: string
	try {
		base = (options.tenantApiUrl ?? getBrowserTenantApiUrl()).replace(/\/$/, '')
	} catch {
		return null
	}
	const params = new URLSearchParams({
		locationId: options.locationId,
		fulfillment: options.fulfillment,
		date: options.date,
	})
	const slug =
		options.orgSlug ?? document.documentElement.dataset.orgSlug ?? null
	if (slug) params.set('slug', slug)
	else if (options.host) params.set('host', options.host)
	else return null
	const response = await fetch(
		`${base}/orders/available-times?${params.toString()}`,
		{ signal: options.signal, credentials: 'omit' },
	)
	if (response.status === 503 || !response.ok) return null
	const body: unknown = await response.json().catch(() => null)
	if (
		!body ||
		typeof body !== 'object' ||
		!Array.isArray((body as AvailableTimesResponse).slots)
	) {
		return null
	}
	return body as AvailableTimesResponse
}

/** Drop slots that are full when slot-limit data is present. */
export function applyAvailableTimes(
	day: ScheduleDay,
	available: AvailableTimesResponse | null,
): ScheduleDay {
	if (!available) return day
	const open = new Set(
		available.slots.filter((slot) => slot.available).map((slot) => slot.at),
	)
	const slots = day.slots.filter((slot) => open.has(slot.iso))
	if (slots.length === day.slots.length) return day
	return { ...day, slots }
}

/**
 * Minutes from now until the earliest schedulable time: prep time, plus
 * the minimum delivery ETA for delivery orders.
 */
export function scheduleLeadMinutes(
	location: ScheduleLocation,
	mode: FulfillmentMode,
	deliveryEtaMin = 0,
	now: Date = new Date(),
): number {
	const prep =
		typeof location.prepTime === 'number' && location.prepTime > 0
			? location.prepTime
			: DEFAULT_PREP_MINUTES
	return (
		prep +
		activeBusyExtraPrepMinutes(location, now) +
		(mode === 'delivery' ? Math.max(0, deliveryEtaMin) : 0)
	)
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
	const hours = buildOnlineHours({
		timezone,
		isActive: location.isActive,
		// `locationOpenIntervals` only runs when store hours exist; mirror online hours.
		storeHours: location.storeHours ?? location.onlineHours,
		onlineHours: location.onlineHours,
		specialHours: location.specialHours,
		onlineOrderingSettings: location.onlineOrderingSettings,
	})
	let earliest =
		now.getTime() +
		scheduleLeadMinutes(location, options.mode, options.deliveryEtaMin, now) *
			60_000
	if (isOrderingPaused(location, now)) {
		const until = location.orderingPause?.until
		if (!until) return []
		earliest = Math.max(earliest, new Date(until).getTime())
	}

	const today = localDateInZone(now.getTime(), timezone)
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
		const date = addDays(today, offset)
		const slots: ScheduleSlot[] = []
		const seen = new Set<string>()
		const { year, month, day } = parseDate(date)
		for (const [from, to] of minuteRangesForDate(hours, date)) {
			const first = Math.ceil(from / step) * step
			for (let minute = first; minute <= to; minute += step) {
				const localTime = formatHm(Math.floor(minute / 60), minute % 60)
				if (seen.has(localTime)) continue
				const t = zonedLocalToUtc(
					year,
					month,
					day,
					Math.floor(minute / 60),
					minute % 60,
					timezone,
				)
				if (t < earliest) continue
				if (!wallClockMatchesInstant(t, date, localTime, timezone)) continue
				seen.add(localTime)
				const instant = new Date(t)
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
	const target = localDateInZone(at.getTime(), zone)
	const today = localDateInZone(now.getTime(), zone)
	const offset = daysBetween(today, target)
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

/** Browser schedule days with regional capacity when slot limits are on. */
export async function buildScheduleDaysWithLimits(
	location: ScheduleLocation,
	options: Parameters<typeof buildScheduleDays>[1],
	orgSlotLimitsEnabled?: boolean,
	orgSlug?: string | null,
): Promise<ScheduleDay[]> {
	const days = buildScheduleDays(location, options)
	if (!location.id || !slotLimitsActive(location, orgSlotLimitsEnabled)) {
		return days
	}
	const fulfillment =
		options.mode === 'delivery' ? ('delivery' as const) : 'pickup'
	return Promise.all(
		days.map(async (day) => {
			const available = await fetchAvailableTimes({
				locationId: location.id!,
				fulfillment,
				date: day.date,
				orgSlug,
			})
			return applyAvailableTimes(day, available)
		}),
	)
}
