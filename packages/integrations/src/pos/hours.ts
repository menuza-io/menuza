import { SpecialHourSchema } from '@repo/common/location-types'
import { expandSpecialHours, specialHoursHorizonEnd } from '@repo/opening-hours'
import { type RemoteHolidayHour } from './types.ts'

function resolveValidTimeZone(timeZone: string | null | undefined): string {
	const candidate = timeZone?.trim() || 'UTC'
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: candidate })
		return candidate
	} catch {
		return 'UTC'
	}
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date)
}

/**
 * Projects `OrganizationLocation.specialHours` (JSON string or array) into
 * delivery-platform holiday hours in the location's timezone, skipping dates
 * before today in that timezone.
 */
export function projectSpecialHoursForPlatform(
	specialHoursJsonOrArray: unknown,
	timeZone: string | null | undefined,
	now = new Date(),
): RemoteHolidayHour[] {
	let rawList: unknown = specialHoursJsonOrArray
	if (typeof rawList === 'string') {
		const trimmed = rawList.trim()
		if (!trimmed) return []
		try {
			rawList = JSON.parse(trimmed)
		} catch {
			return []
		}
	}
	if (!Array.isArray(rawList)) return []

	const safeTz = resolveValidTimeZone(timeZone)
	const todayInTimeZone = formatDateInTimeZone(now, safeTz)

	const entries = rawList.flatMap((entry) => {
		const parsed = SpecialHourSchema.safeParse(entry)
		return parsed.success ? [parsed.data] : []
	})
	// Yearly repeats (#242) go out as dated holidays for the next year.
	const upcoming = expandSpecialHours(
		entries,
		todayInTimeZone,
		specialHoursHorizonEnd(todayInTimeZone),
	)

	const byDate = new Map<string, RemoteHolidayHour>()
	for (const { date, isOpen, slots } of upcoming) {
		byDate.set(date, {
			date,
			isOpen,
			intervals: isOpen
				? slots.map((slot) => ({ start: slot.start, end: slot.end }))
				: [],
			timezone: safeTz,
		})
	}

	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
