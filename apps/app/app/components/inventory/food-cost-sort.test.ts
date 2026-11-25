import { describe, expect, it } from 'vitest'
import { sortItemsByFoodCost } from './food-cost-column.tsx'

const items = [
	{ id: 'a', name: 'Salad' },
	{ id: 'b', name: 'Burger' },
	{ id: 'c', name: 'Soup' },
	{ id: 'd', name: 'Mystery' },
]

const rows: Record<
	string,
	{
		hasRecipe: boolean
		foodCostBp: number | null
		status: null
		unitMarginMinor: number | null
	}
> = {
	a: { hasRecipe: true, foodCostBp: 2500, status: null, unitMarginMinor: 900 },
	b: { hasRecipe: true, foodCostBp: 4200, status: null, unitMarginMinor: 700 },
	c: { hasRecipe: true, foodCostBp: 3100, status: null, unitMarginMinor: 1500 },
	// No recipe: no figure to sort on.
	d: { hasRecipe: false, foodCostBp: null, status: null, unitMarginMinor: null },
}
const rowFor = (key: string) => rows[key] ?? null

describe('menu list sort by food cost (#519)', () => {
	it('sorts by food cost % with the costliest dish first and dishes without a figure last', () => {
		expect(
			sortItemsByFoodCost(items, 'food_cost', rowFor, null).map((i) => i.id),
		).toEqual(['b', 'c', 'a', 'd'])
	})

	it('sorts by margin per dish, largest first', () => {
		expect(
			sortItemsByFoodCost(items, 'margin', rowFor, null).map((i) => i.id),
		).toEqual(['c', 'a', 'b', 'd'])
	})

	it('sorts by margin in the period from the figures the region returned', () => {
		const period = new Map([
			['a', 100],
			['b', 5000],
		])
		expect(
			sortItemsByFoodCost(items, 'margin_period', rowFor, period).map((i) => i.id),
		).toEqual(['b', 'a', 'c', 'd'])
		// Until the figures arrive nothing has one: the list keeps its order.
		expect(
			sortItemsByFoodCost(items, 'margin_period', rowFor, null).map((i) => i.id),
		).toEqual(['a', 'b', 'c', 'd'])
	})

	it('leaves the list as it is by default and never mutates the input', () => {
		const copy = [...items]
		expect(sortItemsByFoodCost(items, 'default', rowFor, null)).toEqual(items)
		sortItemsByFoodCost(items, 'food_cost', rowFor, null)
		expect(items).toEqual(copy)
	})
})
