import {
	BUSY_EXTRA_PREP_CHOICES,
	type BusyMode,
	endOfOrderingDay,
	type OrderingPause,
} from '@repo/common/location-availability'
import {
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import { z } from 'zod'

/**
 * How long a pause or busy mode lasts, as offered on the Orders page. Durations
 * are worked out on the server from the location's time zone and hours.
 */
export const ORDERING_PAUSE_DURATIONS = [
	'15m',
	'30m',
	'60m',
	'rest_of_day',
	'until_resumed',
] as const
export type OrderingPauseDuration = (typeof ORDERING_PAUSE_DURATIONS)[number]

export const BUSY_MODE_DURATIONS = [
	'30m',
	'60m',
	'rest_of_day',
	'until_resumed',
] as const
export type BusyModeDuration = (typeof BUSY_MODE_DURATIONS)[number]

const busyMinutesSchema = z.coerce
	.number()
	.int()
	.refine((value) =>
		(BUSY_EXTRA_PREP_CHOICES as readonly number[]).includes(value),
	)

export const orderingControlSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('pause'),
		locationId: z.string().min(1).max(64),
		duration: z.enum(ORDERING_PAUSE_DURATIONS),
	}),
	z.object({
		intent: z.literal('resume'),
		locationId: z.string().min(1).max(64),
	}),
	z.object({
		intent: z.literal('busy'),
		locationId: z.string().min(1).max(64),
		minutes: busyMinutesSchema,
		duration: z.enum(BUSY_MODE_DURATIONS),
	}),
	z.object({
		intent: z.literal('busy_off'),
		locationId: z.string().min(1).max(64),
	}),
])
export type OrderingControlInput = z.infer<typeof orderingControlSchema>

/** One location's pause and busy mode, as shown on the Orders page. */
export type LocationOrderingControl = {
	id: string
	name: string
	timezone: string
	/** ISO time the pause started, or null when not paused. */
	pausedAt: string | null
	/** ISO end of the pause (null with `pausedAt` set: until resumed). */
	pausedUntil: string | null
	busyExtraPrepMinutes: number
	busyUntil: string | null
	prepTime: number
}

type HoursRow = {
	timezone: string | null
	onlineHours: WeeklySchedule | null
	storeHours: WeeklySchedule | null
	specialHours: SpecialHour[] | null
}

/**
 * The end time for a chosen duration: null means "until someone turns it off".
 * "Rest of today" ends at the location's local midnight (or after an overnight
 * stretch), so the next day's hours apply as usual.
 */
export function resolveControlUntil(
	duration: OrderingPauseDuration | BusyModeDuration,
	location: HoursRow,
	now: Date,
): Date | null {
	switch (duration) {
		case '15m':
			return new Date(now.getTime() + 15 * 60_000)
		case '30m':
			return new Date(now.getTime() + 30 * 60_000)
		case '60m':
			return new Date(now.getTime() + 60 * 60_000)
		case 'rest_of_day':
			return endOfOrderingDay(location, now)
		case 'until_resumed':
			return null
	}
}

type ControlRow = {
	orderingPausedAt: Date | null
	orderingPausedUntil: Date | null
	busyExtraPrepMinutes: number | null
	busyUntil: Date | null
}

/**
 * The pause and busy mode as published to Sites and the region: only what is
 * still in force at `now`, with ISO end times (null: until turned off).
 */
export function publicOrderingControls(
	row: ControlRow,
	now: Date,
): { orderingPause: OrderingPause | null; busyMode: BusyMode | null } {
	const nowMs = now.getTime()
	const pauseActive =
		row.orderingPausedAt != null &&
		(row.orderingPausedUntil == null ||
			row.orderingPausedUntil.getTime() > nowMs)
	const busyMinutes = row.busyExtraPrepMinutes ?? 0
	const busyActive =
		busyMinutes > 0 &&
		(row.busyUntil == null || row.busyUntil.getTime() > nowMs)
	return {
		orderingPause: pauseActive
			? { until: row.orderingPausedUntil?.toISOString() ?? null }
			: null,
		busyMode: busyActive
			? {
					extraPrepMinutes: busyMinutes,
					until: row.busyUntil?.toISOString() ?? null,
				}
			: null,
	}
}
