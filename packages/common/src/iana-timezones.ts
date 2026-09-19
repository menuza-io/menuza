/**
 * US-focused IANA timezone identifiers for restaurant locations (MVP).
 * Includes all `America/*` zones plus US territories from Intl when available.
 */
function buildUsFocusedTimezones(): string[] {
	const fallback = [
		'America/New_York',
		'America/Chicago',
		'America/Denver',
		'America/Los_Angeles',
		'America/Phoenix',
		'America/Anchorage',
		'Pacific/Honolulu',
		'America/Puerto_Rico',
	]

	const intlWithSupported = Intl as typeof Intl & {
		supportedValuesOf?: (key: 'timeZone') => string[]
	}
	if (typeof intlWithSupported.supportedValuesOf === 'function') {
		const supported = intlWithSupported.supportedValuesOf('timeZone')
		const us = supported.filter(
			(zone: string) =>
				zone.startsWith('America/') ||
				zone === 'Pacific/Honolulu' ||
				zone === 'Pacific/Guam' ||
				zone === 'Pacific/Pago_Pago',
		)
		if (us.length > 0) {
			return [...new Set(us)].sort((a, b) => a.localeCompare(b))
		}
	}

	return fallback
}

export const US_FOCUSED_IANA_TIMEZONES: readonly string[] =
	buildUsFocusedTimezones()

export function isValidIanaTimeZone(timeZone: string): boolean {
	if (!timeZone.trim()) return false
	try {
		Intl.DateTimeFormat(undefined, { timeZone })
		return true
	} catch {
		return false
	}
}

export function formatTimezoneLabel(timeZone: string): string {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			timeZoneName: 'shortGeneric',
		}).formatToParts(new Date())
		const tzName =
			parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
		return tzName ? `${timeZone} (${tzName})` : timeZone
	} catch {
		return timeZone
	}
}
