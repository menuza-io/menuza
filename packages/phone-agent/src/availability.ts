import {
	HOURS_SCHEDULE_PRIMARY,
	type HoursScheduleKind,
	type LocationHours,
	isLocationOpenAt,
	locationLocalClock,
	nextOpening,
	parseLocationHours,
} from '@repo/opening-hours'

import {
	type Availability,
	type PhoneAgentRuntimeConfig,
	type ScheduleDay,
	type SpecialHours,
} from './config.ts'
import { type PhoneAgentVertical } from './vertical.ts'

export type ScheduleInput = {
	timezone: string
	/** Weekly hours. Empty means always open (no hours published). */
	hours: readonly ScheduleDay[] | null | undefined
	specialHours?: readonly SpecialHours[] | null
	/** False forces closed, e.g. for something switched off. */
	isActive?: boolean | null
}

function formatOpeningTime(value: string) {
	const [hour = 0, minute = 0] = value.split(':').map(Number)
	const period = hour >= 12 ? 'PM' : 'AM'
	const display = hour % 12 === 0 ? 12 : hour % 12
	return `${display}:${minute.toString().padStart(2, '0')} ${period}`
}

function scheduleToHours(schedule: ScheduleInput): LocationHours {
	return parseLocationHours(
		{
			timeZone: schedule.timezone,
			isActive: schedule.isActive,
			storeHours: schedule.hours,
			specialHours: schedule.specialHours,
		},
		{ malformedPolicy: 'open' },
	).hours
}

/**
 * Open/closed state from parsed hours at `instantMs`. Special hours for today
 * replace the weekly hours; `nextOpen` is only set when a later slot today opens.
 */
export function availabilityFromParsedHours(
	hours: LocationHours,
	instantMs: number,
	kind: HoursScheduleKind = HOURS_SCHEDULE_PRIMARY,
): Availability {
	const result = isLocationOpenAt(hours, instantMs, kind)
	if (result.open) {
		return { isOpen: true, nextOpen: null }
	}
	const { date } = locationLocalClock(instantMs, hours.timeZone)
	const next = nextOpening(hours, instantMs, kind)
	if (next && next.localDate === date) {
		return {
			isOpen: false,
			nextOpen: `Opens today at ${formatOpeningTime(next.localTime)}`,
		}
	}
	return { isOpen: false, nextOpen: null }
}

/**
 * Open/closed state at `now` in the schedule's timezone. Special hours for
 * today replace the weekly hours; `nextOpen` is only set when a later slot
 * today opens.
 */
export function availabilityFromSchedule(
	schedule: ScheduleInput,
	now: Date = new Date(),
): Availability {
	return availabilityFromParsedHours(
		scheduleToHours(schedule),
		now.getTime(),
		HOURS_SCHEDULE_PRIMARY,
	)
}

/**
 * Parsed hours for availability helpers (`malformed` values fail open,
 * matching unpublished hours).
 */
export function parsedHoursFromScheduleFields(raw: {
	timezone: string
	storeHours?: readonly ScheduleDay[] | null
	onlineHours?: readonly ScheduleDay[] | null
	specialHours?: readonly SpecialHours[] | null
	isActive?: boolean | null
}): LocationHours {
	return parseLocationHours(
		{
			timeZone: raw.timezone,
			isActive: raw.isActive,
			storeHours: raw.storeHours,
			onlineHours: raw.onlineHours,
			specialHours: raw.specialHours,
		},
		{ malformedPolicy: 'open' },
	).hours
}

/**
 * The config with availability recomputed for `now`. A config can be minutes
 * (fresh cache) to hours (App outage) old, so the snapshot App took can be
 * wrong by the time the call arrives. The vertical may recompute its own
 * data too. Keeps App's snapshot if it can't be evaluated.
 */
export function withCurrentAvailability(
	config: PhoneAgentRuntimeConfig,
	vertical?: Pick<PhoneAgentVertical, 'currentAvailability'> | null,
	now: Date = new Date(),
): PhoneAgentRuntimeConfig {
	try {
		const fromVertical = vertical?.currentAvailability?.(config, now)
		if (fromVertical) {
			return {
				...config,
				availability: fromVertical.availability,
				vertical: { ...config.vertical, data: fromVertical.data },
			}
		}
		return {
			...config,
			availability: availabilityFromSchedule(
				{
					timezone: config.business.timezone,
					hours: config.business.hours,
					specialHours: config.business.specialHours,
				},
				now,
			),
		}
	} catch (error) {
		console.warn('Could not recompute availability', error)
		return config
	}
}
