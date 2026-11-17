import { describe, expect, it } from 'vitest'

import {
	collectDailyDishLimits,
	dailyDishDemand,
	dailyDishLinesFromStored,
} from './daily-dish-catalog.ts'
import type { DailyDishLimitsContext } from './daily-dish-limits.ts'

const block: DailyDishLimitsContext = {
	enabled: true,
	entries: [
		{
			kind: 'item',
			id: 'special',
			name: 'Special',
			config: { limit: 20, showRemaining: true, byLocation: { b: 5, c: null } },
		},
		{ kind: 'option', id: 'dessert', name: 'Dessert', config: { limit: 12 } },
		{ kind: 'option', id: 'sauce', name: 'Sauce', config: { limit: 3 } },
	],
}

describe('collectDailyDishLimits', () => {
	it('collects dishes and options with the location limit', () => {
		const limits = collectDailyDishLimits(block, 'a')
		expect([...limits.keys()].sort()).toEqual([
			'item:special',
			'option:dessert',
			'option:sauce',
		])
		expect(limits.get('item:special')).toMatchObject({
			limit: 20,
			showRemaining: true,
			name: 'Special',
		})
		expect(limits.get('option:dessert')?.showRemaining).toBe(false)
	})

	it('applies a per-location override and lets null lift the limit', () => {
		expect(collectDailyDishLimits(block, 'b').get('item:special')?.limit).toBe(
			5,
		)
		expect(collectDailyDishLimits(block, 'c').has('item:special')).toBe(false)
	})

	it('is empty while the flag is off or the block is missing', () => {
		expect(collectDailyDishLimits({ ...block, enabled: false }, 'a').size).toBe(
			0,
		)
		expect(collectDailyDishLimits(undefined, 'a').size).toBe(0)
	})

	it('skips a config it cannot read instead of throwing', () => {
		const broken: DailyDishLimitsContext = {
			enabled: true,
			entries: [
				{ kind: 'item', id: 'x', name: 'X', config: '{nope' },
				{ kind: 'item', id: 'y', name: 'Y', config: { limit: 0 } },
				{ kind: 'item', id: 'z', name: 'Z', config: { limit: 4 } },
			],
		}
		expect([...collectDailyDishLimits(broken, 'a').keys()]).toEqual(['item:z'])
	})
})

describe('dailyDishDemand', () => {
	it('counts dish units and option units times the line quantity', () => {
		const demand = dailyDishDemand([
			{
				itemId: 'special',
				quantity: 3,
				options: [{ optionId: 'dessert' }, { optionId: 'sauce', quantity: 2 }],
			},
			{ itemId: 'special', quantity: 1, options: [{ optionId: 'dessert' }] },
		])
		expect(demand.get('item:special')).toBe(4)
		expect(demand.get('option:dessert')).toBe(4)
		expect(demand.get('option:sauce')).toBe(6)
	})

	it('counts a dish even when it is excluded from slot limits (#256 is a separate rule)', () => {
		// The cap is the dish's own: nothing exempts it, so no exemption is taken.
		expect(
			dailyDishDemand([{ itemId: 'special', quantity: 2 }]).get('item:special'),
		).toBe(2)
	})

	it('reads stored order lines and skips unreadable entries', () => {
		const lines = dailyDishLinesFromStored([
			{
				itemId: 'a',
				quantity: 2,
				options: [{ optionId: 'o', quantity: 3 }, { nope: 1 }],
			},
			{ itemId: 5, quantity: 1 },
			null,
		])
		expect(lines).toHaveLength(1)
		expect(dailyDishDemand(lines).get('option:o')).toBe(6)
		expect(dailyDishLinesFromStored('nope')).toEqual([])
	})
})
