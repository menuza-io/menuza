import { describe, expect, it } from 'vitest'
import { computeTotals, lineSignature, type CartLine } from './pricing.ts'

const line = (over: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'burger',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 1000,
	instructions: '',
	options: [],
	...over,
})

describe('computeTotals', () => {
	it('adds tax to the subtotal', () => {
		const t = computeTotals({ lines: [line()], taxRatePercent: 8.25 })
		expect(t).toMatchObject({
			subtotalCents: 1000,
			taxCents: 83,
			totalCents: 1083,
		})
	})

	it('multiplies options and skips tax-exempt options', () => {
		const t = computeTotals({
			lines: [
				line({
					quantity: 2,
					options: [
						{
							groupId: 'g',
							groupName: 'Add',
							optionId: 'a',
							optionName: 'Cheese',
							quantity: 1,
							unitCents: 150,
							taxable: true,
						},
						{
							groupId: 'g',
							groupName: 'Add',
							optionId: 'b',
							optionName: 'Donation',
							quantity: 1,
							unitCents: 100,
							taxable: false,
						},
					],
				}),
			],
			taxRatePercent: 10,
		})
		expect(t.subtotalCents).toBe(2500)
		expect(t.taxCents).toBe(230)
	})

	it('computes the tip on the subtotal, not on tax', () => {
		const t = computeTotals({
			lines: [line()],
			taxRatePercent: 10,
			tipPercent: 20,
		})
		expect(t.tipCents).toBe(200)
		expect(t.totalCents).toBe(1000 + 100 + 200)
	})

	it('honours a custom tip amount over a percentage', () => {
		const t = computeTotals({
			lines: [line()],
			taxRatePercent: 0,
			tipPercent: 20,
			tipCents: 75,
		})
		expect(t.tipCents).toBe(75)
	})

	it('subtracts adjustments before tax and never goes below zero', () => {
		const t = computeTotals({
			lines: [line()],
			taxRatePercent: 10,
			adjustments: [
				{ id: 'd', kind: 'discount', label: '10%', amountCents: 100 },
			],
		})
		expect(t).toMatchObject({
			adjustmentCents: 100,
			taxCents: 90,
			totalCents: 990,
		})
		const over = computeTotals({
			lines: [line()],
			taxRatePercent: 10,
			adjustments: [
				{ id: 'd', kind: 'discount', label: 'x', amountCents: 5000 },
			],
		})
		expect(over.totalCents).toBe(0)
	})

	it('is zero for an empty cart', () => {
		expect(computeTotals({ lines: [], taxRatePercent: 10 }).totalCents).toBe(0)
	})
})

describe('lineSignature', () => {
	it('ignores quantity and option order, but not notes', () => {
		const a = line({
			options: [
				{
					groupId: 'g',
					groupName: '',
					optionId: 'a',
					optionName: '',
					quantity: 1,
					unitCents: 0,
					taxable: true,
				},
				{
					groupId: 'g',
					groupName: '',
					optionId: 'b',
					optionName: '',
					quantity: 1,
					unitCents: 0,
					taxable: true,
				},
			],
		})
		const b = line({ quantity: 3, options: [...a.options].reverse() })
		expect(lineSignature(a)).toBe(lineSignature(b))
		expect(lineSignature(line({ instructions: 'no onion' }))).not.toBe(
			lineSignature(line()),
		)
	})
})
