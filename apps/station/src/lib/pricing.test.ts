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

	it('tips a percentage of the subtotal before discounts', () => {
		const t = computeTotals({
			lines: [line()],
			taxRatePercent: 0,
			tipPercent: 10,
			adjustments: [
				{ id: 'd', kind: 'discount', label: '10%', amountCents: 100 },
			],
		})
		expect(t.tipCents).toBe(100)
		expect(t.totalCents).toBe(1000)
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

describe('computeTotals with per-line discounts', () => {
	// A 10.00 taxable line, and a 10.00 line with 6.00 of untaxed options.
	const first = line({ id: 'a', baseCents: 1000 })
	const second = line({
		id: 'b',
		baseCents: 400,
		options: [
			{
				groupId: 'g',
				groupName: 'Add',
				optionId: 'o',
				optionName: 'Wine',
				quantity: 1,
				unitCents: 600,
				taxable: false,
			},
		],
	})
	const hundredOff = (lineAmounts?: Record<string, number>) => ({
		id: 'd',
		kind: 'discount' as const,
		label: '100% off',
		amountCents: 1000,
		...(lineAmounts ? { lineAmounts } : {}),
	})

	it('shrinks the taxable amount line by line, as the server does', () => {
		const t = computeTotals({
			lines: [first, second],
			taxRatePercent: 10,
			adjustments: [hundredOff({ a: 1000 })],
		})
		// Only the second line's 4.00 is taxable: tax .40, as online.
		expect(t).toMatchObject({
			subtotalCents: 2000,
			adjustmentCents: 1000,
			taxCents: 40,
			totalCents: 1040,
		})
	})

	it('keeps the proportional behavior when a discount has no line amounts', () => {
		const t = computeTotals({
			lines: [first, second],
			taxRatePercent: 10,
			adjustments: [hundredOff()],
		})
		expect(t).toMatchObject({ taxCents: 70, totalCents: 1070 })
	})

	it('a discount on an untaxed share never lowers the tax below the taxable part', () => {
		const t = computeTotals({
			lines: [second],
			taxRatePercent: 10,
			adjustments: [
				{
					id: 'd',
					kind: 'discount',
					label: 'Half',
					amountCents: 500,
					lineAmounts: { b: 500 },
				},
			],
		})
		// 500 off a line that is 40% taxable takes 200 off the taxable 400.
		expect(t.taxCents).toBe(20)
	})

	it('spreads a discount without line amounts over what the others left', () => {
		const t = computeTotals({
			lines: [first, second],
			taxRatePercent: 10,
			adjustments: [
				hundredOff({ a: 1000 }),
				{ id: 'l', kind: 'loyalty', label: 'Reward', amountCents: 500 },
			],
		})
		// 1000 left, 400 of it taxable; half of it goes to the reward.
		expect(t.taxCents).toBe(20)
		expect(t.totalCents).toBe(2000 - 1500 + 20)
	})

	it('caps a line at what it cost', () => {
		const t = computeTotals({
			lines: [first],
			taxRatePercent: 10,
			adjustments: [
				{
					id: 'd',
					kind: 'discount',
					label: 'Too much',
					amountCents: 5000,
					lineAmounts: { a: 5000 },
				},
			],
		})
		expect(t).toMatchObject({
			adjustmentCents: 1000,
			taxCents: 0,
			totalCents: 0,
		})
	})
})
