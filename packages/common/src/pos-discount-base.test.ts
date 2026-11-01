import { describe, expect, it } from 'vitest'
import { discountedTaxableCents, sumLineAmounts } from './pos-discount-base.ts'

describe('sumLineAmounts', () => {
	it('adds per-line amounts and ignores junk', () => {
		const map = sumLineAmounts([
			{ lineAmounts: { a: 100, b: 50.9 } },
			{ lineAmounts: { a: 20, b: -5, c: Number.NaN } },
			{},
		])
		expect(Object.fromEntries(map)).toEqual({ a: 120, b: 50 })
	})
})

describe('discountedTaxableCents', () => {
	it('with no discount leaves the taxable amount alone', () => {
		const r = discountedTaxableCents({
			lines: [{ totalCents: 1000, taxableCents: 1000 }],
			adjustmentCents: 0,
		})
		expect(r).toEqual({
			lineOffCents: 0,
			restOffCents: 0,
			taxableAfterCents: 1000,
		})
	})

	it('takes a line discount off the taxed and untaxed parts in proportion', () => {
		// 10% off a 1000 line with 100 taxable leaves 90 taxable.
		const r = discountedTaxableCents({
			lines: [{ totalCents: 1000, taxableCents: 100, offCents: 100 }],
		})
		expect(r.taxableAfterCents).toBe(90)
		expect(r.lineOffCents).toBe(100)
	})

	it('a discount on an untaxed line never lowers the tax', () => {
		const r = discountedTaxableCents({
			lines: [
				{ totalCents: 1000, taxableCents: 1000 },
				{ totalCents: 500, taxableCents: 0, offCents: 500 },
			],
		})
		expect(r.taxableAfterCents).toBe(1000)
	})

	it('spreads what no line claimed over what is left', () => {
		const r = discountedTaxableCents({
			lines: [
				{ totalCents: 1000, taxableCents: 1000, offCents: 200 },
				{ totalCents: 1000, taxableCents: 0 },
			],
			adjustmentCents: 500,
		})
		// 800 taxable after the line discount, 1800 left of the bill, 300 unclaimed.
		expect(r.restOffCents).toBe(300)
		expect(r.taxableAfterCents).toBe(Math.round(800 * (1 - 300 / 1800)))
	})

	it('rounds the unclaimed share exactly half up, without float error', () => {
		// 3 taxable of 6, 5 off with no line: 3 * 1/6 = 0.5 exactly, which a
		// float `3 * (1 - 5/6)` puts just under the half and rounds to 0.
		const r = discountedTaxableCents({
			lines: [
				{ totalCents: 3, taxableCents: 3 },
				{ totalCents: 3, taxableCents: 0 },
			],
			adjustmentCents: 5,
		})
		expect(r).toEqual({
			lineOffCents: 0,
			restOffCents: 5,
			taxableAfterCents: 1,
		})
	})

	it('shrinks the taxable amount by what the lines keep, not what they claimed', () => {
		// The lines claim 600 but the bill's discount is 300: each keeps half,
		// so the taxed line loses 150 of its taxable amount, not 300.
		const r = discountedTaxableCents({
			lines: [
				{ totalCents: 1000, taxableCents: 1000, offCents: 300 },
				{ totalCents: 1000, taxableCents: 0, offCents: 300 },
			],
			adjustmentCents: 300,
		})
		expect(r).toEqual({
			lineOffCents: 300,
			restOffCents: 0,
			taxableAfterCents: 850,
		})
	})

	it('caps a line discount at its line and ignores non-numbers', () => {
		const r = discountedTaxableCents({
			lines: [
				{ totalCents: 100, taxableCents: 100, offCents: 999 },
				{ totalCents: 100, taxableCents: 100, offCents: Number.NaN },
			],
		})
		expect(r.lineOffCents).toBe(100)
		expect(r.taxableAfterCents).toBe(100)
	})
})
