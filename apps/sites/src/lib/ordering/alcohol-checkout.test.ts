import { describe, expect, it } from 'vitest'
import {
	ageConfirmation,
	alcoholIdsFromMenu,
	cartHasAlcohol,
} from './alcohol-checkout.ts'

const menu = {
	menus: [
		{
			categories: [
				{
					items: [
						{ id: 'wine', isAlcohol: true, modifierGroups: [] },
						{
							id: 'burger',
							modifierGroups: [
								{ options: [{ id: 'beer-addon', isAlcohol: true }, { id: 'fries' }] },
							],
						},
					],
					subcategories: [{ items: [{ id: 'sake', isAlcohol: true }] }],
				},
			],
		},
	],
}

describe('alcohol at checkout', () => {
	it('finds flagged items and options, including in subcategories', () => {
		const ids = alcoholIdsFromMenu(menu)
		expect(ids.items.sort()).toEqual(['sake', 'wine'])
		expect(ids.options).toEqual(['beer-addon'])
	})

	it('asks only when the cart holds alcohol', () => {
		const ids = alcoholIdsFromMenu(menu)
		const line = (itemId: string, optionId?: string) => ({
			itemId,
			options: optionId ? [{ optionId }] : [],
		})
		expect(cartHasAlcohol([line('wine')], ids)).toBe(true)
		expect(cartHasAlcohol([line('burger', 'beer-addon')], ids)).toBe(true)
		expect(cartHasAlcohol([line('burger', 'fries')], ids)).toBe(false)
		expect(cartHasAlcohol([], ids)).toBe(false)
		expect(cartHasAlcohol([line('wine')], null)).toBe(false)
	})

	it('sends a yes and never a date', () => {
		expect(ageConfirmation(true, true)).toEqual({ ageConfirmed: true })
		expect(ageConfirmation(true, false)).toEqual({})
		expect(ageConfirmation(false, true)).toEqual({})
	})
})
