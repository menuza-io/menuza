import { type LevelRow, type LevelSuggestion } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	applyLevelSuggestion,
	applySuggestionsBulk,
	buildPutLevels,
	canApplySuggestion,
	enoughHistory,
	isDraftEmpty,
	levelDraftChanged,
	levelDraftFromRow,
} from './levels-form.ts'

function row(overrides: Partial<LevelRow> = {}): LevelRow {
	return {
		itemId: 'i1',
		name: 'Chicken thighs',
		category: 'meat',
		baseUnit: 'g',
		countUnit: 'kg',
		units: [],
		onHand: 6_000_000,
		orderBelowQuantity: 8_000_000,
		fillUpToQuantity: 30_000_000,
		placeVersion: 3,
		status: 'low',
		supplierId: 's1',
		supplierName: 'Al Watania',
		packName: 'Box',
		packBaseQuantity: 10_000_000,
		...overrides,
	}
}

describe('levels form', () => {
	it('starts from the levels in the unit the item is counted in', () => {
		const draft = levelDraftFromRow(row(), 'metric')
		expect(draft).toMatchObject({
			unit: 'kg',
			belowText: '8',
			fillText: '30',
			placeVersion: 3,
		})
		expect(levelDraftChanged(draft)).toBe(false)
	})

	it('falls back to the best unit when the item has no count unit here', () => {
		const draft = levelDraftFromRow(
			row({
				countUnit: null,
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			}),
			'metric',
		)
		expect(draft.unit).toBe('kg')
		expect(draft.belowText).toBe('')
	})

	it('sends only the rows that changed, with the place version it read', () => {
		const changed = levelDraftFromRow(row(), 'metric')
		changed.fillText = '40'
		const untouched = levelDraftFromRow(row({ itemId: 'i2' }), 'metric')
		const built = buildPutLevels([changed, untouched], {
			clientId: 'l-12345678',
			locationId: 'main',
		})
		expect(built).toEqual({
			ok: true,
			payload: {
				clientId: 'l-12345678',
				locationId: 'main',
				levels: [
					{
						itemId: 'i1',
						orderBelowQuantity: 8_000_000,
						fillUpToQuantity: 40_000_000,
						expectedVersion: 3,
					},
				],
			},
		})
	})

	it('clears a level when the field is emptied', () => {
		const draft = levelDraftFromRow(row(), 'metric')
		draft.belowText = ''
		const built = buildPutLevels([draft], {
			clientId: 'l-12345678',
			locationId: 'main',
		})
		expect(built.ok === true && built.payload.levels[0]).toMatchObject({
			orderBelowQuantity: null,
			fillUpToQuantity: 30_000_000,
		})
	})

	it('says nothing changed, and refuses text that is not a number or levels out of order', () => {
		const draft = levelDraftFromRow(row(), 'metric')
		expect(
			buildPutLevels([draft], { clientId: 'l-12345678', locationId: 'main' }),
		).toEqual({ ok: 'empty' })

		const bad = { ...draft, belowText: 'lots' }
		expect(
			buildPutLevels([bad], { clientId: 'l-12345678', locationId: 'main' }),
		).toEqual({ ok: false, problems: { i1: ['below'] } })

		const reversed = { ...draft, belowText: '50' }
		expect(
			buildPutLevels([reversed], {
				clientId: 'l-12345678',
				locationId: 'main',
			}),
		).toEqual({ ok: false, problems: { i1: ['order'] } })
	})

	it('fills the fields from a suggestion without saving anything', () => {
		const draft = levelDraftFromRow(
			row({ orderBelowQuantity: null, fillUpToQuantity: null }),
			'metric',
		)
		const filled = applyLevelSuggestion(draft, {
			orderBelowQuantity: 9_500_000,
			fillUpToQuantity: 22_000_000,
		})
		expect(filled).toMatchObject({ belowText: '9.5', fillText: '22' })
		expect(levelDraftChanged(filled)).toBe(true)
	})

	it('needs two weeks of history before suggestions are more than a guess', () => {
		expect(enoughHistory(13)).toBe(false)
		expect(enoughHistory(14)).toBe(true)
	})

	it('bulk-applies only empty rows by default, or chosen rows, skipping dismissed and not_enough_history', () => {
		const r1 = row({ itemId: 'i1' }) // already has 8 / 30
		const r2 = row({
			itemId: 'i2',
			orderBelowQuantity: null,
			fillUpToQuantity: null,
		})
		const r3 = row({
			itemId: 'i3',
			orderBelowQuantity: null,
			fillUpToQuantity: null,
		})
		const r4 = row({
			itemId: 'i4',
			orderBelowQuantity: null,
			fillUpToQuantity: null,
		})
		const drafts = {
			i1: levelDraftFromRow(r1, 'metric'),
			i2: levelDraftFromRow(r2, 'metric'),
			i3: levelDraftFromRow(r3, 'metric'),
			i4: levelDraftFromRow(r4, 'metric'),
		}
		expect(isDraftEmpty(drafts.i1)).toBe(false)
		expect(isDraftEmpty(drafts.i2)).toBe(true)

		const sug = (
			itemId: string,
			overrides: Partial<LevelSuggestion> = {},
		): LevelSuggestion => ({
			itemId,
			state: 'ok',
			useDays: 20,
			usedQuantity: 40_000_000,
			dailyUseQuantity: 2_000_000,
			weeklyUseQuantity: 14_000_000,
			orderBelowQuantity: 6_000_000,
			fillUpToQuantity: 15_000_000,
			deliveryDays: [1, 4],
			cycleDays: null,
			supplierName: 'Al Watania',
			packName: 'Box',
			packBaseQuantity: 5_000_000,
			...overrides,
		})

		const map = new Map<string, LevelSuggestion>([
			[
				'i1',
				sug('i1', {
					orderBelowQuantity: 10_000_000,
					fillUpToQuantity: 25_000_000,
				}),
			],
			['i2', sug('i2')],
			['i3', sug('i3')],
			[
				'i4',
				sug('i4', {
					state: 'not_enough_history',
					useDays: 5,
					orderBelowQuantity: 0,
					fillUpToQuantity: 0,
				}),
			],
		])

		expect(canApplySuggestion(map.get('i2'), new Set())).toBe(true)
		expect(canApplySuggestion(map.get('i3'), new Set(['i3']))).toBe(false)
		expect(canApplySuggestion(map.get('i4'), new Set())).toBe(false)

		// Default: fills empty non-dismissed rows only (leaves i1, i3, i4 alone)
		const emptyOnly = applySuggestionsBulk(drafts, [r1, r2, r3, r4], map, {
			chosen: new Set(),
			dismissed: new Set(['i3']),
		})
		expect(emptyOnly.i1).toMatchObject({ belowText: '8', fillText: '30' })
		expect(emptyOnly.i2).toMatchObject({ belowText: '6', fillText: '15' })
		expect(emptyOnly.i3).toMatchObject({ belowText: '', fillText: '' })
		expect(emptyOnly.i4).toMatchObject({ belowText: '', fillText: '' })

		// Chosen: fills chosen non-dismissed rows even if already populated
		const chosenOnly = applySuggestionsBulk(drafts, [r1, r2, r3, r4], map, {
			chosen: new Set(['i1']),
			dismissed: new Set(),
		})
		expect(chosenOnly.i1).toMatchObject({ belowText: '10', fillText: '25' })
		expect(chosenOnly.i2).toMatchObject({ belowText: '', fillText: '' })
	})
})
