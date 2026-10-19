import { plural, t } from '@lingui/core/macro'

/**
 * Count + noun labels for the Reservations screens. Each one is a single
 * message (an ICU plural), never `{n} <Trans>noun</Trans>`: the translator
 * controls word order and plural forms (Arabic has six), and the number and the
 * noun stay in one text node so right-to-left rendering cannot split them.
 */

export function partiesLabel(count: number): string {
	return plural(count, { one: '# party', other: '# parties' })
}

export function inNextMinutesLabel(count: number): string {
	return plural(count, {
		one: '# party in the next 30 min',
		other: '# parties in the next 30 min',
	})
}

export function tablesActiveLabel(count: number): string {
	return plural(count, { one: '# table active', other: '# tables active' })
}

export function unassignedAndConflictsLabel(
	unassigned: number,
	conflicts: number,
): string {
	const unassignedText = plural(unassigned, {
		one: '# unassigned',
		other: '# unassigned',
	})
	const conflictsText = plural(conflicts, {
		one: '# conflict',
		other: '# conflicts',
	})
	return t`${unassignedText} · ${conflictsText}`
}

export function coversLabel(count: number): string {
	return plural(count, { one: '# cover', other: '# covers' })
}

export function guestsCountLabel(count: number): string {
	return plural(count, { one: '# guest', other: '# guests' })
}

export function tablesCountLabel(count: number): string {
	return plural(count, { one: '# table', other: '# tables' })
}

export function specialClosedDaysLabel(count: number): string {
	return plural(count, {
		one: '# special / closed day',
		other: '# special / closed days',
	})
}

export function coversRangeLabel(min: number, max: number): string {
	if (min >= max) return coversLabel(max)
	return t`${min}-${max} covers`
}

export function finishedCountLabel(count: number): string {
	return plural(count, { one: '# finished', other: '# finished' })
}

export function allergiesTonightLabel(count: number): string {
	return plural(count, {
		one: '# party with an allergy',
		other: '# parties with an allergy',
	})
}

export function coversLeftLabel(count: number): string {
	return plural(count, { one: '# cover left', other: '# covers left' })
}
