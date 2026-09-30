import { describe, expect, it } from 'vitest'
import {
	activeVariationGroups,
	canAddVariationValue,
	discardEmptyDraftValue,
	reconcileDraftVariations,
	toDraftVariationGroups,
	updateDraftVariationValue,
	type VariationHistory,
} from './variation-drafts.ts'

describe('variation drafts', () => {
	it('reveals a new blank row as soon as the trailing row has text', () => {
		const drafts = toDraftVariationGroups([
			{ id: 'size', name: 'Size', values: [{ id: 'small', name: 'Small' }] },
		])
		expect(drafts[0]?.values.map((value) => value.name)).toEqual(['Small', ''])
		const blankId = drafts[0]!.values[1]!.id
		const typed = updateDraftVariationValue(drafts, 'size', blankId, 'M')
		expect(typed[0]?.values.map((value) => value.name)).toEqual([
			'Small',
			'M',
			'',
		])
		expect(
			activeVariationGroups(typed)[0]?.values.map((value) => value.name),
		).toEqual(['Small', 'M'])
	})

	it('does not save empty values and preserves a row while it is cleared and retyped', () => {
		const drafts = toDraftVariationGroups([
			{
				id: 'size',
				name: 'Size',
				values: [
					{ id: 'small', name: 'Small' },
					{ id: 'medium', name: 'Medium' },
				],
			},
		])
		const cleared = updateDraftVariationValue(drafts, 'size', 'medium', ' ')
		expect(
			activeVariationGroups(cleared)[0]?.values.map((value) => value.id),
		).toEqual(['small'])
		const retyped = updateDraftVariationValue(
			cleared,
			'size',
			'medium',
			'Medium',
		)
		expect(
			activeVariationGroups(retyped)[0]?.values.map((value) => value.id),
		).toEqual(['small', 'medium'])
		const removed = discardEmptyDraftValue(cleared, 'size', 'medium')
		expect(removed[0]?.values.map((value) => value.name)).toEqual(['Small', ''])
	})

	it('restores a combination price and photo when an existing value is retyped', () => {
		const current = {
			groups: [
				{
					id: 'size',
					name: 'Size',
					values: [
						{ id: 'small', name: 'Small' },
						{ id: 'medium', name: 'Medium' },
					],
				},
			],
			variants: [
				{
					id: 'small-variant',
					valueIds: ['small'],
					price: 10,
					imageKey: null,
					availabilityStatus: 'available' as const,
					unavailableUntil: null,
				},
				{
					id: 'medium-variant',
					valueIds: ['medium'],
					price: 15,
					imageKey: 'medium-photo',
					availabilityStatus: 'unavailable_until' as const,
					unavailableUntil: '2030-01-01T12:00:00.000Z',
				},
			],
		}
		const history: VariationHistory = new Map()
		const drafts = toDraftVariationGroups(current.groups)
		const cleared = updateDraftVariationValue(drafts, 'size', 'medium', '')
		const withoutMedium = reconcileDraftVariations(
			current,
			cleared,
			10,
			history,
			() => 'new',
		)
		expect(withoutMedium.variants).toHaveLength(1)
		const retyped = updateDraftVariationValue(
			cleared,
			'size',
			'medium',
			'Medium',
		)
		const restored = reconcileDraftVariations(
			withoutMedium,
			retyped,
			10,
			history,
			() => 'new',
		)
		expect(restored.variants[1]).toEqual(current.variants[1])
	})

	it('keeps an empty group out of saved variations and respects the combination limit', () => {
		const drafts = toDraftVariationGroups([
			{ id: 'size', name: 'Size', values: [{ id: 'small', name: 'Small' }] },
			{ id: 'color', name: 'Color', values: [] },
		])
		expect(activeVariationGroups(drafts).map((group) => group.id)).toEqual([
			'size',
		])
		const full = toDraftVariationGroups([
			{
				id: 'size',
				name: 'Size',
				values: Array.from({ length: 100 }, (_, index) => ({
					id: String(index),
					name: String(index),
				})),
			},
		])
		expect(canAddVariationValue(full, 'size')).toBe(false)
	})
})
