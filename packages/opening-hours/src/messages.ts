/**
 * Locale-neutral keys returned by availability helpers. Each app maps these to
 * catalog strings (for example `opens_tomorrow` → "Opens tomorrow at {time}").
 */
export const OPENING_HOURS_MESSAGE_KEYS = [
	'opens_later_today',
	'opens_tomorrow',
	'opens_on_date',
	'closed_special',
	'closed_weekday',
	'outside_online_hours',
	'inactive',
	'closing_soon',
	'back_at_time',
] as const

export type OpeningHoursMessageKey = (typeof OPENING_HOURS_MESSAGE_KEYS)[number]
