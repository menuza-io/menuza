import { type LevelRow } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	applyLevelSuggestion,
	buildPutLevels,
	enoughHistory,
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
})
