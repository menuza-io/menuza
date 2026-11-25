import { describe, expect, it } from 'vitest'
import {
	dishProfitabilityRequestSchema,
	engineerMenu,
	MENU_ENGINEERING_LABELS,
	type EngineeringInput,
} from './profitability.ts'

function dish(
	itemId: string,
	over: Partial<EngineeringInput> & { quantity: number },
): EngineeringInput {
	return {
		itemId,
		categoryKey: 'mains',
		salesMinor: over.quantity * 1000,
		priceMinor: 1000,
		costMinor: 300,
		costState: 'complete',
		...over,
	}
}

describe('engineerMenu (#519)', () => {
	const menu = [
		dish('star', { quantity: 40, priceMinor: 1500, costMinor: 500 }),
		dish('workhorse', { quantity: 40, priceMinor: 1000, costMinor: 800 }),
		dish('puzzle', { quantity: 5, priceMinor: 2000, costMinor: 500 }),
		dish('dog', { quantity: 5, priceMinor: 900, costMinor: 800 }),
	]

	it('labels each dish with a recipe as Keep, Re-price, Promote or Rethink', () => {
		const result = engineerMenu(menu, { targetBp: 3000 })
		const by = Object.fromEntries(result.dishes.map((d) => [d.itemId, d.group]))
		expect(by).toEqual({
			star: 'keep',
			workhorse: 'reprice',
			puzzle: 'promote',
			dog: 'rethink',
		})
		expect(MENU_ENGINEERING_LABELS).toEqual({
			keep: 'Keep',
			reprice: 'Re-price',
			promote: 'Promote',
			rethink: 'Rethink',
		})
	})

	it('works out margin per dish, margin in the period and the totals', () => {
		const result = engineerMenu(menu, { targetBp: 3000 })
		const star = result.dishes.find((d) => d.itemId === 'star')!
		expect(star.unitMarginMinor).toBe(1000)
		expect(star.marginMinor).toBe(40_000)
		expect(star.popularityPercent).toBeCloseTo(44.4, 1)
		expect(result.totals.marginMinor).toBe(40_000 + 8_000 + 7_500 + 500)
		// Most margin in the period first.
		expect(result.dishes[0]!.itemId).toBe('star')
	})

	it('suggests the price that hits the target food cost', () => {
		const result = engineerMenu(menu, { targetBp: 3000 })
		const workhorse = result.dishes.find((d) => d.itemId === 'workhorse')!
		// Cost 8.00 at a 30% target is a 26.67 price; food cost today is 80%.
		expect(workhorse.suggestion).toMatchObject({
			foodCostBp: 8000,
			priceForTargetMinor: 2667,
			overTarget: true,
		})
		// Cost 5.00 on a 20.00 price is 25%: under the 30% target.
		expect(
			result.dishes.find((d) => d.itemId === 'puzzle')!.suggestion.overTarget,
		).toBe(false)
	})

	it('compares popularity only within the same menu category', () => {
		// 10 sold is a tiny share of mains but a big one of the two drinks.
		const result = engineerMenu(
			[
				...menu,
				dish('cola', { categoryKey: 'drinks', quantity: 10, priceMinor: 300, costMinor: 50 }),
				dish('tea', { categoryKey: 'drinks', quantity: 10, priceMinor: 300, costMinor: 50 }),
			],
			{ targetBp: 3000 },
		)
		expect(result.dishes.find((d) => d.itemId === 'cola')).toMatchObject({
			popular: true,
			group: 'keep',
		})
		expect(result.dishes.find((d) => d.itemId === 'puzzle')!.popular).toBe(false)
	})

	it('lists dishes with no recipe or a floor cost apart and never labels them', () => {
		const result = engineerMenu(
			[
				...menu,
				dish('norecipe', { quantity: 12, costMinor: null, costState: 'none' }),
				dish('partial', { quantity: 7, costMinor: 100, costState: 'partial' }),
				dish('typed', { quantity: 3, costMinor: 200, costState: 'typed' }),
			],
			{ targetBp: 3000 },
		)
		expect(result.unlisted.map((d) => [d.itemId, d.reason])).toEqual([
			['norecipe', 'no_recipe'],
			['partial', 'cost_incomplete'],
		])
		expect(result.dishes.some((d) => d.itemId === 'norecipe')).toBe(false)
		// A typed cost is whole, so it is ranked.
		expect(result.dishes.some((d) => d.itemId === 'typed')).toBe(true)
	})

	it('strips tax from a tax-inclusive price before working out margin', () => {
		const result = engineerMenu(
			[dish('a', { quantity: 1, priceMinor: 1150, costMinor: 500 })],
			{ targetBp: 3000, tax: { pricesIncludeTax: true, taxRateBp: 1500 } },
		)
		// 11.50 with 15% tax is 10.00 net: margin 5.00.
		expect(result.dishes[0]!.unitMarginMinor).toBe(500)
	})

	it('handles a category where nothing sold without dividing by zero', () => {
		const result = engineerMenu(
			[
				dish('a', { quantity: 0, priceMinor: 1000, costMinor: 200 }),
				dish('b', { quantity: 0, priceMinor: 1000, costMinor: 900 }),
			],
			{ targetBp: 3000 },
		)
		// Nothing popular; compared with the plain average margin.
		expect(result.dishes.find((d) => d.itemId === 'a')!.group).toBe('promote')
		expect(result.dishes.find((d) => d.itemId === 'b')!.group).toBe('rethink')
		expect(engineerMenu([], { targetBp: 3000 }).dishes).toEqual([])
	})

	it('refuses an invalid request body', () => {
		const base = {
			locationId: 'loc',
			fromDate: '2026-11-01',
			toDate: '2026-11-30',
			currency: 'SAR',
			dishes: [{ itemId: 'a', priceMinor: 100, categoryKey: 'x' }],
		}
		expect(dishProfitabilityRequestSchema.safeParse(base).success).toBe(true)
		expect(
			dishProfitabilityRequestSchema.safeParse({ ...base, fromDate: 'soon' }).success,
		).toBe(false)
		expect(
			dishProfitabilityRequestSchema.safeParse({ ...base, name: 'Soup' }).success,
		).toBe(false)
	})
})
