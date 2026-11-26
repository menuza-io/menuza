import { describe, expect, it } from 'vitest'
import {
	allergenListsDiffer,
	applyRecipeAllergens,
	rollUpRecipeAllergens,
	suggestAllergensFromName,
} from './recipe-allergens.ts'

describe('recipe allergens', () => {
	it('a dish whose recipe includes a milk item shows dairy (the menu word for milk)', () => {
		const rollup = rollUpRecipeAllergens([
			{
				id: 'milk',
				name: 'Whole milk',
				allergens: ['dairy'],
			},
			{
				id: 'flour',
				name: 'Flour',
				allergens: ['gluten'],
			},
		])
		expect(rollup.allergens).toEqual(['dairy', 'gluten'])
		expect(rollup.sources).toContain('Whole milk')
	})

	it('walks a made item and adds an option line', () => {
		const rollup = rollUpRecipeAllergens(
			[
				{
					id: 'sauce',
					name: 'White sauce',
					allergens: [],
					ingredients: [{ id: 'milk', name: 'Milk', allergens: ['dairy'] }],
				},
			],
			[{ id: 'shrimp', name: 'Shrimp', allergens: ['shellfish'] }],
		)
		expect(rollup.allergens).toEqual(['dairy', 'shellfish'])
	})

	it('ignores an unconfirmed suggestion', () => {
		const suggestion = suggestAllergensFromName('Whole milk')
		expect(suggestion).toEqual({ allergens: ['dairy'], suggested: true })
		const rollup = rollUpRecipeAllergens([
			{ id: 'milk', name: 'Whole milk', allergens: [] },
		])
		expect(rollup.allergens).toEqual([])
	})

	it('shows a mismatch and one-click apply replaces the typed list', () => {
		expect(allergenListsDiffer(['gluten'], ['dairy'])).toBe(true)
		expect(allergenListsDiffer(['dairy'], ['dairy'])).toBe(false)
		expect(applyRecipeAllergens(['dairy', 'eggs'])).toEqual(['dairy', 'eggs'])
	})
})
