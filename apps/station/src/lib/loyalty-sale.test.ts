import 'fake-indexeddb/auto'
import {
	posOrderLoyaltySchema,
	posOrderRequestSchema,
} from '@repo/common/pos-orders'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import { saleLoyalty, toWireLoyalty } from './loyalty.ts'
import {
	addPayment,
	createOrder,
	updateTab,
	type OrderDraft,
} from './orders.ts'
import { toWireOrder } from './outbox.ts'
import { type Adjustment, type CartLine } from './pricing.ts'

const SALE = '8f6e0c52-5b57-4b4e-9f0e-1c2b3d4e5f60'
const BINDING = 'b'.repeat(32)

const line = (over: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'latte',
	name: 'Latte',
	variantId: null,
	variantLabel: null,
	quantity: 2,
	baseCents: 500,
	instructions: '',
	options: [],
	...over,
})

const lines = [
	line(),
	line({ id: 'l2', itemId: 'muffin', name: 'Muffin', baseCents: 300 }),
]
const byItem = new Map([['muffin', ['bakery']]])

const reward: Adjustment = {
	id: 'loyalty:ap1',
	kind: 'loyalty',
	label: 'Free coffee',
	amountCents: 500,
	lineAmounts: { l1: 500 },
}

const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	lines,
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

describe('a sale rung up for a loyalty member', () => {
	it('is created under the sale id the reward was approved for', async () => {
		const order = await createOrder({
			...draft,
			id: SALE,
			adjustments: [reward],
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		expect(order.id).toBe(SALE)
		expect((await db.orders.get(SALE))?.loyalty?.binding).toBe(BINDING)
	})

	it('gets its own id when no reward was approved, and none when there is no member', async () => {
		const plain = await createOrder(draft)
		expect(plain.id).not.toBe(SALE)
		expect(plain.loyalty).toBeNull()
		expect('loyalty' in toWireOrder(plain)).toBe(false)
	})

	it('uploads the binding and each line’s categories, as the server reads them', async () => {
		const order = await createOrder({
			...draft,
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		const wire = toWireOrder(order)
		expect(wire.loyalty).toEqual({
			binding: BINDING,
			lines: [
				{ id: 'l1', categoryIds: [] },
				{ id: 'l2', categoryIds: ['bakery'] },
			],
		})
		expect(posOrderLoyaltySchema.parse(wire.loyalty)).toEqual(wire.loyalty)
	})

	it('uploads the approved reward as a loyalty adjustment with its line split', async () => {
		const order = await createOrder({
			...draft,
			id: SALE,
			adjustments: [reward],
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		const wire = toWireOrder(order)
		expect(wire.adjustments).toEqual([
			{
				id: 'loyalty:ap1',
				kind: 'loyalty',
				label: 'Free coffee',
				amountCents: 500,
				lineAmounts: { l1: 500 },
			},
		])
		// A reward is not a till discount: it is matched to the redemption by sale id.
		expect('discountApplications' in wire).toBe(false)
	})

	it('the whole upload is valid, open or paid, with a reward or without', async () => {
		const loyalty = saleLoyalty({
			binding: BINDING,
			lines,
			categoryIdsByItem: byItem,
		})
		const open = await createOrder({ ...draft, loyalty })
		const withReward = await createOrder({
			...draft,
			id: SALE,
			adjustments: [reward],
			loyalty,
		})
		const paid = await addPayment(
			withReward.id,
			cash(withReward.totals.totalCents),
		)
		expect(paid.status).toBe('paid')
		for (const order of [open, withReward, paid]) {
			const result = posOrderRequestSchema.safeParse(toWireOrder(order))
			expect(result.success ? 'valid' : result.error.issues).toBe('valid')
		}
		// The reward comes off the bill the guest pays.
		expect(withReward.totals.adjustmentCents).toBe(500)
	})

	it('a reward that makes the bill free can be closed without a payment', async () => {
		const free: Adjustment = {
			...reward,
			amountCents: 1600,
			lineAmounts: { l1: 1000, l2: 600 },
		}
		const order = await createOrder(
			{
				...draft,
				id: SALE,
				adjustments: [free],
				loyalty: saleLoyalty({
					binding: BINDING,
					lines,
					categoryIdsByItem: byItem,
				}),
			},
			undefined,
			{ closeIfFree: true },
		)
		expect(order.totals.totalCents).toBe(0)
		expect(order.status).toBe('paid')
		expect(posOrderRequestSchema.safeParse(toWireOrder(order)).success).toBe(
			true,
		)
	})

	it('a tab keeps its member through later edits and payment', async () => {
		const tab = await createOrder({
			...draft,
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		// Edited without a member on screen: the tab remembers who earns.
		const edited = await updateTab(tab.id, {
			...draft,
			lines: [...lines, line({ id: 'l3', itemId: 'tea', name: 'Tea' })],
		})
		expect(edited.loyalty?.binding).toBe(BINDING)
		expect(toWireOrder(edited).loyalty?.lines.map((l) => l.id)).toEqual([
			'l1',
			'l2',
			'l3',
		])
		const paid = await addPayment(tab.id, cash(edited.totals.totalCents))
		expect(toWireOrder(paid).loyalty?.binding).toBe(BINDING)
	})

	it('a member identified in the middle of a tab’s life is added to it', async () => {
		const tab = await createOrder(draft)
		expect(tab.loyalty).toBeNull()
		const edited = await updateTab(tab.id, {
			...draft,
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		expect(edited.loyalty?.binding).toBe(BINDING)
	})

	it('never carries a phone number on the order or in the upload', async () => {
		const order = await createOrder({
			...draft,
			loyalty: saleLoyalty({
				binding: BINDING,
				lines,
				categoryIdsByItem: byItem,
			}),
		})
		const text = JSON.stringify([
			order.loyalty,
			toWireLoyalty(order.loyalty, order.lines),
		])
		expect(text).not.toMatch(/\+?\d{7,}/)
	})
})
