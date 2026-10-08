import {
	type Availability,
	type PhoneAgentRuntimeConfig,
	type ScheduleDay,
	type ScheduleSlot,
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

const WEEKDAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
]

function localClock(timezone: string, now: Date) {
	const read = (timeZone: string) => {
		const parts: Record<string, string> = {}
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			weekday: 'long',
		})
		for (const part of formatter.formatToParts(now)) {
			parts[part.type] = part.value
		}
		return parts
	}
	let parts: Record<string, string>
	try {
		parts = read(timezone || 'UTC')
	} catch {
		parts = read('UTC')
	}
	const day = parts.weekday?.toLowerCase() ?? ''
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		time: `${parts.hour}:${parts.minute}`,
		day: WEEKDAYS.includes(day) ? day : 'monday',
	}
}

function formatOpeningTime(value: string) {
	const [hour = 0, minute = 0] = value.split(':').map(Number)
	const period = hour >= 12 ? 'PM' : 'AM'
	const display = hour % 12 === 0 ? 12 : hour % 12
	return `${display}:${minute.toString().padStart(2, '0')} ${period}`
}

function inSlot(slots: readonly ScheduleSlot[] | undefined, time: string) {
	return Boolean(slots?.some((slot) => slot.start <= time && time <= slot.end))
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
	const closed = { isOpen: false, nextOpen: null }
	if (schedule.isActive === false) return closed
	const clock = localClock(schedule.timezone, now)
	const special = schedule.specialHours?.find(
		(entry) => entry.date === clock.date,
	)
	if (special) {
		return special.isOpen && inSlot(special.slots, clock.time)
			? { isOpen: true, nextOpen: null }
			: closed
	}
	const hours = schedule.hours
	if (!hours?.length) return { isOpen: true, nextOpen: null }
	const today = hours.find((entry) => entry.day === clock.day)
	if (!today?.isOpen || !today.slots?.length) return closed
	if (inSlot(today.slots, clock.time)) return { isOpen: true, nextOpen: null }
	const later = [...today.slots]
		.sort((a, b) => a.start.localeCompare(b.start))
		.find((slot) => slot.start > clock.time)
	return later
		? {
				isOpen: false,
				nextOpen: `Opens today at ${formatOpeningTime(later.start)}`,
			}
		: closed
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
