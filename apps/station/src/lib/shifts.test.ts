import 'fake-indexeddb/auto'
import { posShiftRequestSchema } from '@repo/common/pos-orders'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import {
	addPayment,
	createOrder,
	refundOrder,
	type OrderDraft,
} from './orders.ts'
import { toWireOrder } from './outbox.ts'
import {
	addCashMovement,
	closeShift,
	openShift,
	startShift,
	summarizeShift,
	toWireShift,
} from './shifts.ts'

const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	lines: [
		{
			id: 'l1',
			itemId: 'a',
			name: 'Burger',
			variantId: null,
			variantLabel: null,
			quantity: 1,
			baseCents: 1000,
			instructions: '',
			options: [],
		},
	],
	adjustments: [],
	tipCents: 0,
}
const cash = (amountCents: number) => ({
	method: 'cash' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
})
const card = (amountCents: number) => ({
	method: 'card' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
})
const lina = { id: 'lina', name: 'Lina M.' }

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
	await db.shifts.clear()
})

describe('cash drawer shifts', () => {
	it('stamps sales, payments and refunds with the open shift, and nothing when none is open', async () => {
		const before = await createOrder(draft, cash(1100))
		expect(before.shiftId).toBeNull()
		const shift = await startShift({ openingFloatCents: 5000, by: lina })
		const sale = await createOrder(draft, cash(1100))
		expect(sale.shiftId).toBe(shift.id)
		expect(sale.payments[0]!.shiftId).toBe(shift.id)
		const refunded = await refundOrder(sale.id, {
			amountCents: 100,
			reason: 'wrong_charge',
			by: lina,
			approvedBy: null,
		})
		expect(refunded.refunds[0]!.shiftId).toBe(shift.id)
		expect(toWireOrder(refunded)).toMatchObject({
			shiftId: shift.id,
			payments: [{ shiftId: shift.id }],
			refunds: [{ shiftId: shift.id }],
		})
	})

	it('allows one open shift at a time', async () => {
		await startShift({ openingFloatCents: 0, by: null })
		await expect(
			startShift({ openingFloatCents: 0, by: null }),
		).rejects.toThrow(/already open/)
	})

	it('works out the drawer, counts a tab paid in a later shift where the money moved, and closes with the count', async () => {
		const first = await startShift({ openingFloatCents: 10_000, by: lina })
		await createOrder(draft, cash(1100))
		await createOrder(draft, card(1100))
		const tab = await createOrder(draft)
		await addCashMovement(first.id, {
			kind: 'pay_out',
			amountCents: 300,
			note: 'Ice',
			by: lina,
			approvedBy: null,
		})
		await addCashMovement(first.id, {
			kind: 'pay_in',
			amountCents: 2000,
			note: 'Change from the bank',
			by: lina,
			approvedBy: null,
		})
		const summary = await summarizeShift((await openShift())!)
		expect(summary.orders).toEqual({
			paid: 2,
			refunded: 0,
			cancelled: 0,
			open: 1,
		})
		expect(summary.cash.expectedCents).toBe(10_000 + 1100 - 300 + 2000)
		const closed = await closeShift(first.id, {
			countedCashCents: 12_790,
			by: lina,
		})
		expect(closed).toMatchObject({
			status: 'closed',
			expectedCashCents: 12_800,
			countedCashCents: 12_790,
		})
		expect(posShiftRequestSchema.safeParse(toWireShift(closed)).success).toBe(
			true,
		)

		// The tab rung up in the first shift is paid in the second: the cash is the second shift's.
		const second = await startShift({ openingFloatCents: 0, by: lina })
		await addPayment(tab.id, cash(1100))
		expect(
			(await summarizeShift((await openShift())!)).cash.expectedCents,
		).toBe(1100)
		expect((await summarizeShift(closed)).cash.expectedCents).toBe(12_800)
		void second
	})

	it('needs a note and an amount for cash in or out, and a closed shift takes nothing more', async () => {
		const shift = await startShift({ openingFloatCents: 0, by: null })
		await expect(
			addCashMovement(shift.id, {
				kind: 'pay_out',
				amountCents: 100,
				note: ' ',
				by: null,
				approvedBy: null,
			}),
		).rejects.toThrow()
		await closeShift(shift.id, { countedCashCents: 0, by: null })
		await expect(
			addCashMovement(shift.id, {
				kind: 'pay_in',
				amountCents: 100,
				note: 'x',
				by: null,
				approvedBy: null,
			}),
		).rejects.toThrow(/closed/)
	})
})
