import {
	type BulkPhotoFlag,
	type MatchConfidence,
} from '@repo/common/dish-photo-match'
import { describe, expect, it } from 'vitest'
import {
	confirmedPairs,
	initialReviewState,
	setConfirmed,
	setReplace,
	skipPhoto,
	swapDish,
	unmatchedAssetIds,
	usedItemIds,
} from './review-state.ts'
import { type BulkDishChoice, type BulkProposedPhoto } from './types.ts'

function dish(id: string, hasPhoto = false): BulkDishChoice {
	return {
		id,
		name: id,
		hasPhoto,
		imageUrl: hasPhoto ? `/img/${id}` : null,
		sourceKey: hasPhoto ? `key-${id}` : null,
	}
}

function photo(
	assetId: string,
	itemId: string | null,
	confidence: MatchConfidence | null,
	flags: BulkPhotoFlag[] = [],
	extra: Partial<BulkProposedPhoto> = {},
): BulkProposedPhoto {
	return {
		assetId,
		fileName: `${assetId}.jpg`,
		url: `/img/${assetId}`,
		width: 2000,
		height: 1500,
		qualityScore: null,
		label: null,
		proposal: {
			assetId,
			itemId,
			confidence,
			score: confidence === 'high' ? 1 : 0.7,
			replace: false,
			flags,
		},
		duplicateOfExisting: false,
		sourceKey: null,
		...extra,
	}
}

const DISHES = [
	dish('pizza'),
	dish('burger'),
	dish('salad', true),
	dish('soup'),
]

describe('initial review state', () => {
	it('confirms only confident, unflagged matches onto dishes without a photo', () => {
		const state = initialReviewState(
			[
				photo('a', 'pizza', 'high'),
				photo('b', 'burger', 'medium'),
				photo('c', 'soup', 'low'),
				photo('d', 'salad', 'high'),
				photo('e', 'soup', 'high', ['too_small']),
				photo('f', null, null),
				photo('g', 'pizza', 'high', [], { duplicateOfExisting: true }),
			],
			DISHES,
		)
		expect(state.a).toMatchObject({ itemId: 'pizza', confirmed: true })
		expect(state.b).toMatchObject({ itemId: 'burger', confirmed: true })
		expect(state.c).toMatchObject({ itemId: 'soup', confirmed: false })
		// A replacement is never on by default.
		expect(state.d).toMatchObject({
			itemId: 'salad',
			confirmed: false,
			replace: false,
		})
		expect(state.e!.confirmed).toBe(false)
		expect(state.f).toMatchObject({ itemId: null, confirmed: false })
		expect(state.g!.confirmed).toBe(false)
	})

	it('drops a proposal for a dish that is not in the list', () => {
		const state = initialReviewState([photo('a', 'gone', 'high')], DISHES)
		expect(state.a).toMatchObject({ itemId: null, confirmed: false })
	})
})

describe('review actions', () => {
	it('a swap needs a new confirmation and starts without Replace', () => {
		let state = initialReviewState([photo('a', 'pizza', 'high')], DISHES)
		state = swapDish(state, 'a', 'burger')
		expect(state.a).toMatchObject({ itemId: 'burger', confirmed: false })
		state = setConfirmed(state, 'a', true, DISHES)
		expect(state.a!.confirmed).toBe(true)
	})

	it('a dish takes one photo: another row cannot take it', () => {
		let state = initialReviewState(
			[photo('a', 'pizza', 'high'), photo('b', null, null)],
			DISHES,
		)
		expect(usedItemIds(state)).toEqual(new Set(['pizza']))
		expect(usedItemIds(state, 'a')).toEqual(new Set())
		state = swapDish(state, 'b', 'pizza')
		expect(state.b!.itemId).toBeNull()
		expect(swapDish(state, 'a', 'pizza').a!.itemId).toBe('pizza')
	})

	it('Replace? is the confirmation for a dish with a photo', () => {
		let state = initialReviewState([photo('a', 'salad', 'high')], DISHES)
		state = setConfirmed(state, 'a', true, DISHES)
		expect(state.a!.confirmed).toBe(false)
		state = setReplace(state, 'a', true, DISHES)
		expect(state.a).toMatchObject({ confirmed: true, replace: true })
		state = setReplace(state, 'a', false, DISHES)
		expect(state.a).toMatchObject({ confirmed: false, replace: false })
	})

	it('Replace? does nothing for a dish without a photo', () => {
		let state = initialReviewState([photo('a', 'pizza', 'high')], DISHES)
		state = setReplace(state, 'a', true, DISHES)
		expect(state.a!.replace).toBe(false)
	})

	it('skip leaves the photo unmatched', () => {
		let state = initialReviewState(
			[photo('a', 'pizza', 'high'), photo('b', null, null)],
			DISHES,
		)
		state = skipPhoto(state, 'a')
		expect(state.a).toMatchObject({ itemId: null, confirmed: false })
		expect(unmatchedAssetIds(state).sort()).toEqual(['a', 'b'])
	})

	it('ignores actions on unknown photos', () => {
		const state = initialReviewState([photo('a', 'pizza', 'high')], DISHES)
		expect(swapDish(state, 'zzz', 'burger')).toBe(state)
		expect(skipPhoto(state, 'zzz')).toBe(state)
		expect(setConfirmed(state, 'zzz', true, DISHES)).toBe(state)
	})
})

describe('confirmedPairs', () => {
	it('sends only confirmed pairs, with Replace and the reviewed photo key', () => {
		let state = initialReviewState(
			[
				photo('a', 'pizza', 'high'),
				photo('b', 'salad', 'high'),
				photo('c', 'soup', 'low'),
			],
			DISHES,
		)
		state = setReplace(state, 'b', true, DISHES)
		expect(confirmedPairs(state, DISHES)).toEqual([
			{ assetId: 'a', itemId: 'pizza', replace: false, sourceKey: null },
			{ assetId: 'b', itemId: 'salad', replace: true, sourceKey: 'key-salad' },
		])
	})

	it('never sends a replacement the operator did not tick', () => {
		const forced = {
			a: { assetId: 'a', itemId: 'salad', confirmed: true, replace: false },
		}
		expect(confirmedPairs(forced, DISHES)).toEqual([])
	})

	it('sends nothing when nothing is confirmed', () => {
		const state = initialReviewState([photo('a', 'soup', 'low')], DISHES)
		expect(confirmedPairs(state, DISHES)).toEqual([])
	})

	it('sends a dish once even if two rows point at it', () => {
		const forced = {
			a: { assetId: 'a', itemId: 'pizza', confirmed: true, replace: false },
			b: { assetId: 'b', itemId: 'pizza', confirmed: true, replace: false },
		}
		expect(confirmedPairs(forced, DISHES)).toHaveLength(1)
	})
})
