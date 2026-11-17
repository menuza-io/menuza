import 'fake-indexeddb/auto'
import { posOrderRequestSchema } from '@repo/common/pos-orders'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	cashDiscountAdjustment,
	cashDiscountPercentText,
	cashDiscountRate,
	withoutCashDiscount,
} from './cash-discount.ts'
import { db } from './db.ts'
import { addPayment, createOrder, type OrderDraft } from './orders.ts'
import { toWireOrder } from './outbox.ts'
import { computeTotals, type Adjustment, type CartLine } from './pricing.ts'

const line = (over: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'a',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 1000,
	instructions: '',
	options: [],
	...over,
})
const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	// 10 x $10.00 = $100.00, 10% tax added.
	lines: [line({ quantity: 10 })],
	adjustments: [],
	tipCents: 0,
}
const cash = (amountCents: number) => ({
	method: 'cash' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
})

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
})

describe('the rate at a location (#375)', () => {
	it('is what the register settings carry, or nothing', () => {
		const settings = (cashDiscountBp: unknown) =>
			({ stationSettings: { cashDiscountBp } }) as never
		expect(cashDiscountRate(settings(300))).toBe(300)
		expect(cashDiscountRate(settings(null))).toBeNull()
		expect(cashDiscountRate(settings(5000))).toBeNull()
		// A catalog downloaded before the setting existed has none.
		expect(cashDiscountRate({ stationSettings: undefined })).toBeNull()
		expect(cashDiscountRate(undefined)).toBeNull()
	})

	it('reads as a plain percentage on the receipt', () => {
		expect(cashDiscountPercentText(300)).toBe('3%')
		expect(cashDiscountPercentText(350)).toBe('3.50%')
	})
})

describe('the adjustment', () => {
	it('is its own line: a percentage of what the bill costs after its other discounts', () => {
		const others: Adjustment[] = [
			{ id: 'm', kind: 'discount', label: 'Staff', amountCents: 2000 },
		]
		const row = cashDiscountAdjustment({
			lines: draft.lines,
			others,
			percentBp: 300,
		})
		expect(row).toMatchObject({
			id: 'cash-discount',
			kind: 'cash_discount',
			amountCents: 240,
		})
		expect(row?.label).toContain('3%')
	})

	it('is nothing when there is no rate, or no amount', () => {
		expect(
			cashDiscountAdjustment({
				lines: draft.lines,
				others: [],
				percentBp: null,
			}),
		).toBeNull()
		expect(
			cashDiscountAdjustment({ lines: [], others: [], percentBp: 300 }),
		).toBeNull()
	})

	it('replaces a cash discount already on the bill instead of counting it twice', () => {
		const earlier: Adjustment = {
			id: 'cash-discount',
			kind: 'cash_discount',
			label: 'Cash discount',
			amountCents: 999,
		}
		const row = cashDiscountAdjustment({
			lines: draft.lines,
			others: [earlier],
			percentBp: 300,
		})
		expect(row?.amountCents).toBe(300)
		expect(withoutCashDiscount([earlier])).toEqual([])
	})

	it('shrinks the tax as a discount does, and the tip stays on the full bill', () => {
		const row = cashDiscountAdjustment({
			lines: draft.lines,
			others: [],
			percentBp: 300,
		})!
		const totals = computeTotals({
			lines: draft.lines,
			taxRatePercent: 10,
			tipPercent: 10,
			adjustments: [row],
		})
		// $100.00 less 3.00, tax on 97.00, tip 10% of the 100.00.
		expect(totals).toMatchObject({
			subtotalCents: 10_000,
			adjustmentCents: 300,
			taxCents: 970,
			tipCents: 1000,
			totalCents: 10_000 - 300 + 970 + 1000,
		})
	})
})

describe('taking the bill in cash', () => {
	const row = () =>
		cashDiscountAdjustment({ lines: draft.lines, others: [], percentBp: 300 })!

	it('creates a sale paid in cash with the discount as its own line, and uploads it as contract 11', async () => {
		const adjustment = row()
		const total = 10_000 - 300 + 970
		const sale = await createOrder(
			{ ...draft, adjustments: [adjustment] },
			cash(total),
		)
		expect(sale.status).toBe('paid')
		expect(sale.adjustments.map((a) => a.kind)).toEqual(['cash_discount'])
		expect(sale.totals).toMatchObject({
			adjustmentCents: 300,
			totalCents: total,
		})
		const wire = toWireOrder(sale)
		expect(wire.adjustments.map((a) => a.kind)).toEqual(['cash_discount'])
		// It is not a rule's discount, so no application is sent for it.
		expect('discountApplications' in wire).toBe(false)
		expect(posOrderRequestSchema.safeParse(wire).success).toBe(true)
	})

	it('refuses the discount on a sale that is not paid entirely in cash', async () => {
		const total = 10_000 - 300 + 970
		await expect(
			createOrder(
				{ ...draft, adjustments: [row()] },
				{ ...cash(total), method: 'card' },
			),
		).rejects.toThrow(/whole bill paid in cash/)
		await expect(
			createOrder({ ...draft, adjustments: [row()] }, cash(total - 500)),
		).rejects.toThrow(/whole bill paid in cash/)
		await expect(
			createOrder({ ...draft, adjustments: [row()] }),
		).rejects.toThrow(/whole bill paid in cash/)
	})

	it('adds it to a saved tab at its first payment, and only then', async () => {
		const tab = await createOrder(draft)
		expect(tab.totals.totalCents).toBe(10_000 + 1000)
		const total = 10_000 - 300 + 970
		const paid = await addPayment(tab.id, cash(total), undefined, {
			cashDiscount: row(),
		})
		expect(paid.status).toBe('paid')
		expect(paid.adjustments.map((a) => a.kind)).toEqual(['cash_discount'])
		expect(paid.totals.totalCents).toBe(total)
	})

	it('refuses it on a tab paid by card or in part', async () => {
		const tab = await createOrder(draft)
		await expect(
			addPayment(tab.id, { ...cash(10_670), method: 'card' }, undefined, {
				cashDiscount: row(),
			}),
		).rejects.toThrow(/whole bill paid in cash/)
		await expect(
			addPayment(tab.id, cash(5000), undefined, { cashDiscount: row() }),
		).rejects.toThrow(/whole bill paid in cash/)
	})

	it('is not added once a payment exists: the bill is frozen at what it was', async () => {
		const tab = await createOrder(draft, cash(2000))
		expect(tab.status).toBe('open')
		const paid = await addPayment(tab.id, cash(9000), undefined, {
			cashDiscount: row(),
		})
		expect(paid.adjustments).toEqual([])
		expect(paid.totals.totalCents).toBe(11_000)
	})
})
