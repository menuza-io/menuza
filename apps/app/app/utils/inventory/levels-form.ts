import {
	levelsOrdered,
	type LevelRow,
	type LevelSuggestions,
	type PutLevels,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import { defaultEntryUnit } from './format.ts'
import { levelQuantity, levelText } from './item-form.ts'

/**
 * The Levels sheet as pure functions: every item with its two levels typed in
 * the unit it is counted in, which rows changed, and the body of
 * `PUT /levels/bulk` (rows are independent; a stale one is refused alone).
 */

export type LevelDraft = {
	itemId: string
	name: string
	category: string
	supplierName: string | null
	baseUnit: LevelRow['baseUnit']
	units: LevelRow['units']
	/** The unit both fields are typed in (how the item is counted here). */
	unit: UnitRef
	onHand: number
	placeVersion: number
	/** What was loaded, as text in `unit`, to tell a change from a no-op. */
	initialBelow: string
	initialFill: string
	belowText: string
	fillText: string
}

export function levelDraftFromRow(
	row: LevelRow,
	system: UnitSystem,
): LevelDraft {
	const unit =
		row.countUnit ?? defaultEntryUnit(row.baseUnit, null, row.units, system)
	const below = levelText(row.orderBelowQuantity, unit, row.baseUnit, row.units)
	const fill = levelText(row.fillUpToQuantity, unit, row.baseUnit, row.units)
	return {
		itemId: row.itemId,
		name: row.name,
		category: row.category,
		supplierName: row.supplierName,
		baseUnit: row.baseUnit,
		units: row.units,
		unit,
		onHand: row.onHand,
		placeVersion: row.placeVersion,
		initialBelow: below,
		initialFill: fill,
		belowText: below,
		fillText: fill,
	}
}

export function levelDraftChanged(draft: LevelDraft): boolean {
	return (
		draft.belowText.trim() !== draft.initialBelow ||
		draft.fillText.trim() !== draft.initialFill
	)
}

export type LevelProblem = 'below' | 'fill' | 'order'

function typed(draft: LevelDraft, text: string): number | null | 'invalid' {
	const clean = text.trim()
	if (clean === '') return null
	const quantity = levelQuantity(clean, draft.unit, draft.baseUnit, draft.units)
	return quantity === null ? 'invalid' : quantity
}

/** What is wrong with one row's two fields (nothing is sent while any row has a problem). */
export function levelDraftProblems(draft: LevelDraft): LevelProblem[] {
	const below = typed(draft, draft.belowText)
	const fill = typed(draft, draft.fillText)
	const problems: LevelProblem[] = []
	if (below === 'invalid') problems.push('below')
	if (fill === 'invalid') problems.push('fill')
	if (
		below !== 'invalid' &&
		fill !== 'invalid' &&
		!levelsOrdered(below, fill)
	) {
		problems.push('order')
	}
	return problems
}

/** The body of `PUT /levels/bulk` for the rows that changed, or what is wrong. */
export function buildPutLevels(
	drafts: readonly LevelDraft[],
	context: { clientId: string; locationId: string },
):
	| { ok: true; payload: PutLevels }
	| { ok: false; problems: Record<string, LevelProblem[]> }
	| { ok: 'empty' } {
	const changed = drafts.filter(levelDraftChanged)
	if (changed.length === 0) return { ok: 'empty' }
	const problems: Record<string, LevelProblem[]> = {}
	for (const draft of changed) {
		const found = levelDraftProblems(draft)
		if (found.length > 0) problems[draft.itemId] = found
	}
	if (Object.keys(problems).length > 0) return { ok: false, problems }
	return {
		ok: true,
		payload: {
			clientId: context.clientId,
			locationId: context.locationId,
			levels: changed.slice(0, 200).map((draft) => ({
				itemId: draft.itemId,
				orderBelowQuantity: typed(draft, draft.belowText) as number | null,
				fillUpToQuantity: typed(draft, draft.fillText) as number | null,
				expectedVersion: draft.placeVersion,
			})),
		},
	}
}

/** Fills a row's fields from a suggestion (the person still saves). */
export function applyLevelSuggestion(
	draft: LevelDraft,
	suggestion: Pick<
		LevelSuggestions['suggestions'][number],
		'orderBelowQuantity' | 'fillUpToQuantity'
	>,
): LevelDraft {
	return {
		...draft,
		belowText: levelText(
			suggestion.orderBelowQuantity,
			draft.unit,
			draft.baseUnit,
			draft.units,
		),
		fillText: levelText(
			suggestion.fillUpToQuantity,
			draft.unit,
			draft.baseUnit,
			draft.units,
		),
	}
}

/** Under this many days of history a suggestion is a guess: the sheet says so. */
export const MIN_SUGGESTION_DAYS = 14

export function enoughHistory(daysObserved: number): boolean {
	return daysObserved >= MIN_SUGGESTION_DAYS
}
