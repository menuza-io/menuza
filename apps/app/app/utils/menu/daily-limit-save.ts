import {
	type DailySaleLimit,
	serializeDailySaleLimit,
} from '@repo/common/daily-dish-limits'

/** The locations a daily limit names, to check they belong to the organization. */
export function dailyLimitLocationIds(
	config: DailySaleLimit | null | undefined,
): string[] {
	return Object.keys(config?.byLocation ?? {})
}

/**
 * The column to write for a daily limit (#409), or nothing. The form only
 * posts the limit while the organization has the feature on; a save from a
 * form that did not post it must leave a stored limit alone (never clear it
 * just because the section was hidden).
 */
export function dailyLimitColumn(
	posted: boolean,
	config: DailySaleLimit | null | undefined,
): { dailySaleLimit?: string | null } {
	return posted
		? { dailySaleLimit: serializeDailySaleLimit(config ?? null) }
		: {}
}

/**
 * Which of the posted options carried a `dailySaleLimit` field at all, by
 * position. The schema reads a missing field as "no limit", so this is the only
 * way to tell "cleared" from "this caller never sent it" (a save that did not
 * send it must leave the option's stored limit alone).
 */
export function optionsCarryingDailyLimit(rawOptions: unknown): boolean[] {
	if (!Array.isArray(rawOptions)) return []
	return rawOptions.map(
		(option) =>
			typeof option === 'object' &&
			option !== null &&
			'dailySaleLimit' in option,
	)
}

/** Every location the options' daily limits name, once each. */
export function optionLimitLocationIds(
	options: ReadonlyArray<{ dailySaleLimit?: DailySaleLimit | null }>,
): string[] {
	return [
		...new Set(
			options.flatMap((option) => dailyLimitLocationIds(option.dailySaleLimit)),
		),
	]
}
