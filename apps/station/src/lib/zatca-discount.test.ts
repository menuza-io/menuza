import { figures, fromSale, outOfScopeCents } from '@repo/zatca'
import { describe, expect, it } from 'vitest'
import { type Adjustment, type CartLine, computeTotals } from './pricing.ts'

/**
 * The signed invoice must tie to the till to the halala: same VAT, same total,
 * no payable rounding. These tests price a cart with the till's `computeTotals`
 * and then build the invoice the way `signInvoice` does.
 */

const line = (
	id: string,
	baseCents: number,
	options: Array<{
		unitCents: number
		taxable: boolean
		quantity?: number
	}> = [],
	quantity = 1,
): CartLine => ({
	id,
	itemId: id,
	name: id,
	variantId: null,
	variantLabel: null,
	quantity,
	baseCents,
	instructions: '',
	options: options.map((option, index) => ({
		groupId: 'g',
		groupName: 'g',
		optionId: `${id}-o${index}`,
		optionName: 'o',
		quantity: option.quantity ?? 1,
		unitCents: option.unitCents,
		taxable: option.taxable,
	})),
})

const meta = {
	id: 'x',
	uuid: 'u',
	issuedAt: new Date('2026-01-01T10:00:00Z'),
	counter: 1,
	previousHash: 'a',
	seller: {} as never,
}

/** Mirrors `saleOf` in `zatca.ts`. */
function invoiceFor(
	lines: CartLine[],
	adjustments: Adjustment[],
	taxInclusive: boolean,
	tipPercent = 0,
) {
	const totals = computeTotals({
		lines,
		taxRatePercent: 15,
		taxInclusive,
		adjustments,
		tipPercent,
	})
	const doc = fromSale(
		{
			lines,
			taxRatePercent: 15,
			taxInclusive,
			totals,
			payments: [{ method: 'cash' }],
			discounts: adjustments
				.filter((a) => a.kind === 'discount')
				.map((a) => ({
					name: a.label,
					amountCents: a.amountCents,
					...(a.lineAmounts ? { lineAmounts: a.lineAmounts } : {}),
				})),
			otherLineAmounts: Object.fromEntries(
				adjustments
					.filter((a) => a.kind !== 'discount')
					.flatMap((a) => Object.entries(a.lineAmounts ?? {})),
			),
		},
		meta,
	)
	return { totals, doc, f: figures(doc) }
}

const discount = (
	amountCents: number,
	lineAmounts?: Record<string, number>,
): Adjustment => ({
	id: 'd',
	kind: 'discount',
	label: 'Discount',
	amountCents,
	...(lineAmounts ? { lineAmounts } : {}),
})

describe('invoice VAT ties to the till with per-line discounts', () => {
	// A reviewer's probe: line A 1000 taxable, line B 100 taxable plus a 900
	// untaxed option, a 500 discount on A at 15% exclusive. Till tax 90, total
	// 1590; the invoice used to say 124 VAT and a -34 halala rounding.
	const lines = [
		line('A', 1000),
		line('B', 100, [{ unitCents: 900, taxable: false }]),
	]

	it('exclusive: VAT 90, total 1590, no rounding', () => {
		const { totals, f } = invoiceFor(lines, [discount(500, { A: 500 })], false)
		expect(totals.taxCents).toBe(90)
		expect(totals.totalCents).toBe(1590)
		expect(f.taxCents).toBe(90)
		expect(f.payableRoundingCents).toBe(0)
	})

	it('inclusive: invoice VAT is the till VAT, no rounding', () => {
		const { totals, f } = invoiceFor(lines, [discount(500, { A: 500 })], true)
		expect(f.taxCents).toBe(totals.taxCents)
		expect(f.payableRoundingCents).toBe(0)
	})

	it('a discount on the line with the untaxed option', () => {
		for (const incl of [false, true]) {
			const { totals, f } = invoiceFor(lines, [discount(500, { B: 500 })], incl)
			expect(f.taxCents).toBe(totals.taxCents)
			expect(f.payableRoundingCents).toBe(0)
		}
	})

	it('credit notes use the same out-of-scope share as the invoice', () => {
		const adjustments = [discount(500, { A: 500 })]
		const sale = {
			lines,
			taxRatePercent: 15,
			taxInclusive: false,
			totals: computeTotals({ lines, taxRatePercent: 15, adjustments }),
			payments: [{ method: 'cash' as const }],
			discounts: [{ name: 'D', amountCents: 500, lineAmounts: { A: 500 } }],
		}
		// 900 untaxed, none of the discount fell on it.
		expect(outOfScopeCents(sale)).toBe(900)
	})
})

describe('invoice VAT ties to the till on random carts', () => {
	let seed = 20260101
	const random = () =>
		(seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
	const int = (min: number, max: number) =>
		min + Math.floor(random() * (max - min + 1))

	function cart() {
		const lines: CartLine[] = []
		for (let i = 0; i < int(1, 4); i += 1) {
			const options: Array<{
				unitCents: number
				taxable: boolean
				quantity: number
			}> = []
			// Roughly half the lines carry an untaxed option, some a taxed one.
			if (random() < 0.5)
				options.push({
					unitCents: int(50, 900),
					taxable: false,
					quantity: int(1, 2),
				})
			if (random() < 0.4)
				options.push({ unitCents: int(20, 300), taxable: true, quantity: 1 })
			lines.push(line(`L${i}`, int(100, 4000), options, int(1, 4)))
		}
		return lines
	}

	const totalOf = (l: CartLine) =>
		(l.baseCents +
			l.options.reduce((s, o) => s + o.unitCents * o.quantity, 0)) *
		l.quantity

	for (const inclusive of [false, true]) {
		for (const withLineAmounts of [true, false]) {
			it(`${inclusive ? 'inclusive' : 'exclusive'}, discounts ${withLineAmounts ? 'with' : 'without'} lineAmounts`, () => {
				let untaxedCarts = 0
				for (let run = 0; run < 3000; run += 1) {
					const lines = cart()
					const subtotal = lines.reduce((s, l) => s + totalOf(l), 0)
					const adjustments: Adjustment[] = []
					const amounts: Record<string, number> = {}
					let sum = 0
					for (const l of lines) {
						if (random() < 0.6) {
							const amount = int(1, totalOf(l))
							amounts[l.id] = amount
							sum += amount
						}
					}
					if (sum > 0)
						adjustments.push(
							discount(sum, withLineAmounts ? amounts : undefined),
						)
					// A loyalty reward alongside, with no line amounts.
					if (random() < 0.2)
						adjustments.push({
							id: 'l',
							kind: 'loyalty',
							label: 'Reward',
							amountCents: int(1, Math.max(1, subtotal - sum)),
						})
					const { totals, f } = invoiceFor(
						lines,
						adjustments,
						inclusive,
						random() < 0.3 ? 10 : 0,
					)
					if (lines.some((l) => l.options.some((o) => !o.taxable)))
						untaxedCarts += 1
					const context = JSON.stringify({ lines, adjustments, totals })
					expect(f.taxCents, context).toBe(totals.taxCents)
					// Exclusive ties to the halala; inclusive may carry the one
					// halala BR-S-09 forces into the payable rounding amount.
					expect(Math.abs(f.payableRoundingCents), context).toBeLessThanOrEqual(
						inclusive ? 1 : 0,
					)
				}
				// The cases that used to fail are in the sample.
				expect(untaxedCarts).toBeGreaterThan(500)
			})
		}
	}
})
