import {
	type DayOfWeek,
	type LocationOrderingAvailability,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
	DAYS_OF_WEEK,
	localDateAndTimeToUtc,
} from '@repo/common/location-types'

export type HoursSummary = {
	/** Closing time of the current slot, formatted in the location timezone. */
	closesAt?: string
	/** Next opening time ("11:00 AM" today, "Thu 11:00 AM" otherwise). */
	opensAt?: string
}

type HoursLocation = {
	timezone?: string | null
	onlineHours?: unknown
	storeHours?: unknown
	specialHours?: unknown
}

function asSchedule(value: unknown): WeeklySchedule | null {
	if (!value) return null
	if (typeof value === 'string') {
		try {
			return asSchedule(JSON.parse(value))
		} catch {
			return null
		}
	}
	return Array.isArray(value) ? (value as WeeklySchedule) : null
}

function asSpecialHours(value: unknown): SpecialHour[] {
	if (!value) return []
	if (typeof value === 'string') {
		try {
			return asSpecialHours(JSON.parse(value))
		} catch {
			return []
		}
	}
	return Array.isArray(value) ? (value as SpecialHour[]) : []
}

function addDays(date: string, days: number): { date: string; day: DayOfWeek } {
	const base = new Date(`${date}T00:00:00Z`)
	base.setUTCDate(base.getUTCDate() + days)
	const iso = base.toISOString().slice(0, 10)
	// getUTCDay: 0 = Sunday; DAYS_OF_WEEK starts on Monday.
	const index = (base.getUTCDay() + 6) % 7
	return { date: iso, day: DAYS_OF_WEEK[index] ?? 'monday' }
}

/**
 * Derives "open until" / "opens at" from the location schedule so the menu
 * header can say it in the customer's locale. `isLocationOpenForOrdering`
 * only exposes an English `nextOpen` sentence, so the slots are re-read here.
 */
export function summarizeHours(
	location: HoursLocation,
	availability: LocationOrderingAvailability,
	locale: string,
): HoursSummary {
	const timezone = location.timezone || 'UTC'
	const schedule =
		asSchedule(location.onlineHours) ?? asSchedule(location.storeHours)
	const special = asSpecialHours(location.specialHours)

	const slotsFor = (date: string, day: DayOfWeek): TimeSlot[] => {
		const override = special.find((entry) => entry.date === date)
		if (override) return override.isOpen ? (override.slots ?? []) : []
		const daySchedule = schedule?.find((entry) => entry.day === day)
		if (!daySchedule || !daySchedule.isOpen) return []
		return [...(daySchedule.slots ?? [])].sort((a, b) =>
			a.start.localeCompare(b.start),
		)
	}

	const format = (
		date: string,
		time: string,
		withDay: boolean,
	): string | undefined => {
		try {
			const instant = localDateAndTimeToUtc(date, time, timezone)
			return new Intl.DateTimeFormat(locale, {
				timeZone: timezone,
				hour: 'numeric',
				minute: '2-digit',
				...(withDay ? { weekday: 'short' } : {}),
			}).format(instant)
		} catch {
			return undefined
		}
	}

	const today = availability.currentLocalDate
	const now = availability.currentLocalTime
	const todaySlots = slotsFor(today, availability.dayOfWeek)

	if (availability.isOpen) {
		const current = todaySlots.find(
			(slot) => slot.start <= now && now <= slot.end,
		)
		return current ? { closesAt: format(today, current.end, false) } : {}
	}

	const later = todaySlots.find((slot) => slot.start > now)
	if (later) return { opensAt: format(today, later.start, false) }

	for (let offset = 1; offset <= 7; offset += 1) {
		const next = addDays(today, offset)
		const first = slotsFor(next.date, next.day)[0]
		if (first) return { opensAt: format(next.date, first.start, true) }
	}
	return {}
}
