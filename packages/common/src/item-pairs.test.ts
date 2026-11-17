import { describe, expect, it } from 'vitest'
import { countItemPairs, distinctItemIds, itemPairKey } from './item-pairs.ts'

describe('item pairs', () => {
	it('counts a pair once per order when two dishes appear together', () => {
		const sales = Array.from({ length: 20 }, () => ({
			lines: [
				{ itemId: 'burger', quantity: 1 },
				{ itemId: 'fries', quantity: 1 },
			],
		}))
		const pairs = countItemPairs(sales)
		expect(pairs).toHaveLength(1)
		expect(pairs[0]!.orderCount).toBe(20)
		expect(pairs[0]!.itemAId).toBe('burger')
		expect(pairs[0]!.itemBId).toBe('fries')
	})

	it('skips voided lines (zero quantity)', () => {
		const pairs = countItemPairs([
			{
				lines: [
					{ itemId: 'a', quantity: 1 },
					{ itemId: 'b', quantity: 0 },
				],
			},
		])
		expect(pairs).toHaveLength(0)
	})

	it('canonicalizes pair keys', () => {
		expect(itemPairKey('z', 'a')).toBe(itemPairKey('a', 'z'))
	})

	it('dedupes duplicate lines of the same item', () => {
		expect(
			distinctItemIds([
				{ itemId: 'a', quantity: 2 },
				{ itemId: 'a', quantity: 1 },
			]),
		).toEqual(['a'])
	})
})
