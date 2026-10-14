export interface TimezoneOption {
	value: string
	label: string
}

/**
 * Curated IANA zones for the staff time zone setting. UTC first, then ordered
 * by region (US, Canada, Gulf and the rest). Every `value` must be a
 * valid IANA zone; the test next to this file checks that against `Intl`.
 */
export const TIMEZONE_OPTIONS: TimezoneOption[] = [
	{ value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
	// United States
	{ value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
	{ value: 'America/Chicago', label: 'Central Time (US & Canada)' },
	{ value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
	{ value: 'America/Phoenix', label: 'Arizona (no daylight saving)' },
	{ value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
	{ value: 'America/Anchorage', label: 'Alaska' },
	{ value: 'Pacific/Honolulu', label: 'Hawaii' },
	// Canada
	{ value: 'America/Halifax', label: 'Atlantic Time (Halifax)' },
	{ value: 'America/Toronto', label: 'Toronto (Eastern Time)' },
	{ value: 'America/Winnipeg', label: 'Winnipeg (Central Time)' },
	{ value: 'America/Edmonton', label: 'Edmonton (Mountain Time)' },
	{ value: 'America/Vancouver', label: 'Vancouver (Pacific Time)' },
	{ value: 'America/St_Johns', label: "St. John's (Newfoundland)" },
	// Other Americas
	{ value: 'America/Mexico_City', label: 'Mexico City' },
	{ value: 'America/Sao_Paulo', label: 'Sao Paulo' },
	// Europe
	{ value: 'Europe/London', label: 'London (GMT / BST)' },
	{ value: 'Europe/Dublin', label: 'Dublin (GMT / IST)' },
	{ value: 'Europe/Paris', label: 'Paris (CET)' },
	{ value: 'Europe/Berlin', label: 'Berlin (CET)' },
	{ value: 'Europe/Madrid', label: 'Madrid (CET)' },
	{ value: 'Europe/Rome', label: 'Rome (CET)' },
	{ value: 'Europe/Istanbul', label: 'Istanbul (TRT)' },
	// Gulf and Middle East
	{ value: 'Asia/Riyadh', label: 'Riyadh (AST)' },
	{ value: 'Asia/Kuwait', label: 'Kuwait (AST)' },
	{ value: 'Asia/Qatar', label: 'Doha (AST)' },
	{ value: 'Asia/Bahrain', label: 'Bahrain (AST)' },
	{ value: 'Asia/Dubai', label: 'Dubai (GST)' },
	{ value: 'Asia/Muscat', label: 'Muscat (GST)' },
	{ value: 'Asia/Amman', label: 'Amman' },
	{ value: 'Africa/Cairo', label: 'Cairo (EET)' },
	// Asia Pacific
	{ value: 'Asia/Karachi', label: 'Karachi (PKT)' },
	{ value: 'Asia/Kolkata', label: 'India (IST)' },
	{ value: 'Asia/Singapore', label: 'Singapore (SGT)' },
	{ value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
	{ value: 'Australia/Sydney', label: 'Sydney (AEST / AEDT)' },
]

export const DEFAULT_TIMEZONE = 'UTC'

/**
 * The options plus the organization's current zone when it is not in the curated
 * list (for example a zone saved before the list grew), so editing it
 * never shows an empty select or silently changes its zone.
 */
export function getTimezoneOptions(current?: string | null): TimezoneOption[] {
	if (!current || TIMEZONE_OPTIONS.some((option) => option.value === current)) {
		return TIMEZONE_OPTIONS
	}
	return [
		{ value: current, label: current.replaceAll('_', ' ') },
		...TIMEZONE_OPTIONS,
	]
}
