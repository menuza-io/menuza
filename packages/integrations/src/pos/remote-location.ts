/**
 * Canonical location profile returned from POS/delivery platforms during connect.
 * Mapped into Menuza `OrganizationLocation` fields on import.
 */

import {
	DAYS_OF_WEEK,
	type DayOfWeek,
	type LocationAddress,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
	DEFAULT_WEEKLY_SCHEDULE,
} from '@repo/common/location-types'

export type RemoteLocation = {
	name: string
	phone?: string | null
	timezone?: string | null
	address?: LocationAddress | null
	storeHours?: WeeklySchedule | null
	onlineHours?: WeeklySchedule | null
	specialHours?: SpecialHour[] | null
	/** Platform store / location id (Square location id, Toast GUID, etc.) */
	remoteLocationId?: string | null
}

export function slugFromLocationName(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug || 'main-location'
}

const DAY_INDEX: Record<number, DayOfWeek> = {
	0: 'sunday',
	1: 'monday',
	2: 'tuesday',
	3: 'wednesday',
	4: 'thursday',
	5: 'friday',
	6: 'saturday',
}

/** Maps 0=Sunday … 6=Saturday menu day indices to Menuza weekly schedule. */
export function weeklyScheduleFromMenuDays(
	days: number[],
	start: string,
	end: string,
): WeeklySchedule {
	return DAYS_OF_WEEK.map((day) => {
		const index = DAYS_OF_WEEK.indexOf(day)
		const menuIndex = index === 6 ? 0 : index + 1
		const isOpen = days.includes(menuIndex)
		return {
			day,
			isOpen,
			slots: isOpen ? [{ start: start, end: end }] : [],
		}
	})
}

export function weeklyScheduleFromSquarePeriods(
	periods: {
		day_of_week?: string
		start_local_time?: string
		end_local_time?: string
	}[],
): WeeklySchedule {
	const byDay = new Map<DayOfWeek, TimeSlot[]>()
	for (const period of periods) {
		const key = (period.day_of_week ?? '').toLowerCase()
		const day = squareDayToMenuza(key)
		if (!day) continue
		const start = (period.start_local_time ?? '09:00').slice(0, 5)
		const end = (period.end_local_time ?? '17:00').slice(0, 5)
		const list = byDay.get(day) ?? []
		list.push({ start, end })
		byDay.set(day, list)
	}
	return DAYS_OF_WEEK.map((day) => {
		const slots = byDay.get(day) ?? []
		return { day, isOpen: slots.length > 0, slots }
	})
}

function squareDayToMenuza(day: string): DayOfWeek | null {
	const map: Record<string, DayOfWeek> = {
		mon: 'monday',
		tue: 'tuesday',
		wed: 'wednesday',
		thu: 'thursday',
		fri: 'friday',
		sat: 'saturday',
		sun: 'sunday',
	}
	return map[day.slice(0, 3)] ?? null
}

export function emptyWeeklySchedule(): WeeklySchedule {
	return DEFAULT_WEEKLY_SCHEDULE.map((entry) => ({
		...entry,
		isOpen: false,
		slots: [],
	}))
}

export { DAY_INDEX }
