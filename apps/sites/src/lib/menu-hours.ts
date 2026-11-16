import { type LocationOrderingAvailability } from '@repo/common/location-availability'
import { buildOnlineHours } from '@repo/common/available-times'
import { nextClosing, nextOpening } from '@repo/opening-hours'

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
	onlineOrderingSettings?: unknown
	isActive?: boolean | null
}

function formatInstant(
	ms: number,
	locale: string,
	timezone: string,
	withDay: boolean,
): string | undefined {
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone: timezone,
			hour: 'numeric',
			minute: '2-digit',
			...(withDay ? { weekday: 'short' } : {}),
		}).format(new Date(ms))
	} catch {
		return undefined
	}
}

/**
 * Derives "open until" / "opens at" from shared opening-hours math so the menu
 * header matches ordering availability (#198).
 */
export function summarizeHours(
	location: HoursLocation,
	availability: LocationOrderingAvailability,
	locale: string,
	now: Date = new Date(),
): HoursSummary {
	const timezone = location.timezone || 'UTC'
	const hours = buildOnlineHours({
		timezone,
		isActive: location.isActive,
		storeHours: location.storeHours,
		onlineHours: location.onlineHours,
		specialHours: location.specialHours,
		onlineOrderingSettings: location.onlineOrderingSettings,
	})
	const ms = now.getTime()
	if (availability.isOpen) {
		const close = nextClosing(hours, ms, 'online')
		if (close) {
			return {
				closesAt: formatInstant(close.atMs, locale, timezone, false),
			}
		}
		return {}
	}
	const open = nextOpening(hours, ms, 'online')
	if (!open) return {}
	const sameDay = open.localDate === availability.currentLocalDate
	return {
		opensAt: formatInstant(open.atMs, locale, timezone, !sameDay),
	}
}

/**
 * When paused online ordering resumes, in the location time zone and the
 * customer's locale: "7:30 PM" today, "Thu 11:00 AM" on another day. Undefined
 * for a pause with no end (or a malformed time).
 */
export function formatOrderingResume(
	availability: Pick<LocationOrderingAvailability, 'paused'>,
	timezone: string | null | undefined,
	locale: string,
	now: Date = new Date(),
): string | undefined {
	const iso = availability.paused?.resumesAt
	if (!iso) return undefined
	const instant = new Date(iso)
	if (Number.isNaN(instant.getTime())) return undefined
	const zone = timezone || 'UTC'
	try {
		const dayOf = (value: Date) =>
			new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(value)
		return new Intl.DateTimeFormat(locale, {
			timeZone: zone,
			hour: 'numeric',
			minute: '2-digit',
			...(dayOf(instant) === dayOf(now) ? {} : { weekday: 'short' }),
		}).format(instant)
	} catch {
		return undefined
	}
}
