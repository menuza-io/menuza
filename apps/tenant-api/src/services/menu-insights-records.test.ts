import { distinctItemIds } from '@repo/common/item-pairs'
import { computeModifierAttach } from '@repo/common/modifier-attach'
import { describe, expect, it } from 'vitest'

describe('menu insights sale rules', () => {
	it('pair counting matches acceptance (20 orders)', () => {
		const sales = Array.from({ length: 20 }, () => ({
			lines: [
				{ itemId: 'burger', quantity: 1 },
				{ itemId: 'fries', quantity: 1 },
			],
		}))
		let count = 0
		for (const sale of sales) {
			if (distinctItemIds(sale.lines).length >= 2) count += 1
		}
		expect(count).toBe(20)
	})

	it('modifier attach rate matches order data', () => {
		const rows = computeModifierAttach([
			{
				lines: [
					{
						itemId: 'pizza',
						quantity: 1,
						options: [{ optionId: 'cheese', quantity: 1, salesMinor: 150 }],
					},
				],
			},
			{ lines: [{ itemId: 'pizza', quantity: 1, options: [] }] },
		])
		expect(rows[0]!.attachRate).toBeCloseTo(0.5)
	})
})
