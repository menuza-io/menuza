/**
 * Media feature flags (#145, #146), read with `getFeatureFlag` per
 * organization. Default off: a missing row is off, and only a literal
 * true-like value turns one on.
 */
export const MEDIA_FLAG_KEYS = {
	/** #145 background photo quality scores and the Weak dish photo check. */
	photoQuality: 'media.photo_quality',
	/** #146 restyle the whole menu's photos, review before publishing. */
	restyle: 'media.restyle',
} as const

const TRUE = new Set(['true', '1', 'on', 'yes'])

export function isMediaFlagOn(value: unknown): boolean {
	if (value === true) return true
	if (typeof value === 'string') return TRUE.has(value.trim().toLowerCase())
	return false
}

const OFF = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * `MEDIA_RESTYLE_ENABLED=false` (also 0, off, no, disabled) is the node kill
 * switch for new restyle work. Unset or true means on. Photos already drafted
 * stay reviewable; only starting runs and generating drafts stop.
 */
export function isMediaRestyleKillSwitchOn(
	value: string | undefined | null = process.env.MEDIA_RESTYLE_ENABLED,
): boolean {
	return (
		value !== undefined && value !== null && OFF.has(value.trim().toLowerCase())
	)
}
