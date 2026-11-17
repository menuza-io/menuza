/**
 * The daily limit of a dish or modifier option (#409) as the menu forms edit
 * it: text fields and a choice per location, turned into the one
 * `DailySaleLimit` JSON the server stores. Pure, so the rules are tested
 * without a browser.
 */
import {
	DAILY_DISH_MAX_UNITS,
	type DailySaleLimit,
} from '@repo/common/daily-dish-limits'

/** What one location does with the dish's daily limit. */
export type DailyLimitLocationMode =
	/** Uses the limit above. */
	| 'inherit'
	/** Has a limit of its own. */
	| 'limit'
	/** Has no limit here. */
	| 'none'

export type DailyLimitLocationState = {
	mode: DailyLimitLocationMode
	/** The text typed when `mode` is `limit`. */
	limit: string
}

export type DailyLimitFormState = {
	/** Empty means no limit for the organization. */
	limit: string
	showRemaining: boolean
	byLocation: Record<string, DailyLimitLocationState>
}

export function emptyDailyLimitForm(): DailyLimitFormState {
	return { limit: '', showRemaining: false, byLocation: {} }
}

export function dailyLimitFormFromConfig(
	config: DailySaleLimit | null | undefined,
): DailyLimitFormState {
	if (!config) return emptyDailyLimitForm()
	const byLocation: Record<string, DailyLimitLocationState> = {}
	for (const [locationId, value] of Object.entries(config.byLocation ?? {})) {
		byLocation[locationId] =
			value === null
				? { mode: 'none', limit: '' }
				: { mode: 'limit', limit: String(value) }
	}
	return {
		limit: config.limit === null ? '' : String(config.limit),
		showRemaining: config.showRemaining === true,
		byLocation,
	}
}

/** A whole number from 1 to the largest allowed limit, or null. */
export function parseDailyLimitUnits(text: string): number | null {
	const trimmed = text.trim()
	if (!/^\d+$/.test(trimmed)) return null
	const value = Number(trimmed)
	return value >= 1 && value <= DAILY_DISH_MAX_UNITS ? value : null
}

export type DailyLimitFormErrors = {
	/** The organization-wide limit is not a whole number in range. */
	limit: boolean
	/** Location ids whose own limit is not a whole number in range. */
	locations: string[]
}

export function dailyLimitFormErrors(
	state: DailyLimitFormState,
): DailyLimitFormErrors {
	return {
		limit:
			state.limit.trim() !== '' && parseDailyLimitUnits(state.limit) === null,
		locations: Object.entries(state.byLocation)
			.filter(
				([, row]) =>
					row.mode === 'limit' && parseDailyLimitUnits(row.limit) === null,
			)
			.map(([locationId]) => locationId),
	}
}

/**
 * The config the form describes, or null when it sets no limit anywhere (the
 * limit is cleared). Values that are not valid are left out here; the form
 * shows them as errors and the server refuses them as well.
 */
export function dailyLimitFormToConfig(
	state: DailyLimitFormState,
	/** Only these locations are kept (an override for a deleted one is dropped). */
	locationIds?: readonly string[],
): DailySaleLimit | null {
	const limit = parseDailyLimitUnits(state.limit)
	const byLocation: Record<string, number | null> = {}
	for (const [locationId, row] of Object.entries(state.byLocation)) {
		if (locationIds && !locationIds.includes(locationId)) continue
		if (row.mode === 'none') byLocation[locationId] = null
		else if (row.mode === 'limit') {
			const value = parseDailyLimitUnits(row.limit)
			if (value !== null) byLocation[locationId] = value
		}
	}
	const hasOverride = Object.keys(byLocation).length > 0
	// "No limit here" everywhere with no limit above is no limit at all.
	const sets =
		limit !== null || Object.values(byLocation).some((value) => value !== null)
	if (!hasOverride && limit === null) return null
	if (!sets) return null
	return {
		limit,
		showRemaining: state.showRemaining,
		...(hasOverride ? { byLocation } : {}),
	}
}

/**
 * The hidden field's value: the config as JSON, or empty to clear. While a
 * typed value is not valid it posts a limit of 0, which the server refuses, so
 * a bad entry fails the save loudly instead of quietly removing the limit.
 */
export function dailyLimitFormToJson(
	state: DailyLimitFormState,
	locationIds?: readonly string[],
): string {
	const errors = dailyLimitFormErrors(state)
	if (errors.limit || errors.locations.length > 0) {
		return JSON.stringify({ limit: 0, showRemaining: state.showRemaining })
	}
	const config = dailyLimitFormToConfig(state, locationIds)
	return config ? JSON.stringify(config) : ''
}
