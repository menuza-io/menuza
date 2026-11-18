import { describe, expect, it } from 'vitest'
import { computeModifierAttach } from './modifier-attach.ts'

describe('modifier attach rate', () => {
	it('matches order data', () => {
		const sales = [
			{
				lines: [
					{
						itemId: 'pizza',
						quantity: 1,
						options: [
							{ optionId: 'extra-cheese', quantity: 1, salesMinor: 200 },
						],
					},
				],
			},
			{
				lines: [{ itemId: 'pizza', quantity: 1, options: [] }],
			},
			{
				lines: [
					{
						itemId: 'pizza',
						quantity: 1,
						options: [
							{ optionId: 'extra-cheese', quantity: 1, salesMinor: 200 },
						],
					},
				],
			},
		]
		const rows = computeModifierAttach(sales)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.attachCount).toBe(2)
		expect(rows[0]!.parentItemCount).toBe(3)
		expect(rows[0]!.attachRate).toBeCloseTo(2 / 3)
		expect(rows[0]!.salesMinor).toBe(400)
	})
})
