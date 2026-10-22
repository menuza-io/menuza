import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db.ts'
import {
	addPayment,
	adoptTab,
	balanceCents,
	closeFreeOrder,
	createFreeOrder,
	createOrder,
	isSendable,
	localDate,
	MAX_ORDER_LINES,
	MAX_PAYMENTS,
	openTabs,
	phoneOrders,
	pruneSettledOrders,
	updateTab,
	voidTab,
	type OrderDraft,
} from './orders.ts'
import { toWireOrder } from './outbox.ts'
import { type CartLine } from './pricing.ts'

const MISTAKE = { reason: 'mistake' as const, by: null, approvedBy: null }

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
	lines: [line({ quantity: 3 })],
	adjustments: [],
	tipCents: 0,
}
// 3 x $10.00 + 10% tax = $33.00
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

describe('pay later (open tabs)', () => {
	it('preserves phone pickup details through save, edit, transfer, and payment', async () => {
		const phone: OrderDraft = {
			...draft,
			orderType: 'takeaway',
			orderSource: 'phone',
			tableLabel: '',
			customerName: ' Sam ',
			customerPhone: '+966 (50) 123-4567',
			pickupAt: Date.now() + 86_400_000,
			pickupTimeZone: 'Asia/Riyadh',
		}
		const tab = await createOrder(phone)
		expect(tab).toMatchObject({
			orderSource: 'phone',
			orderType: 'takeaway',
			customerName: 'Sam',
			customerPhone: '+966501234567',
			pickupAt: phone.pickupAt,
			status: 'open',
		})
		const edited = await updateTab(tab.id, {
			...phone,
			pickupAt: phone.pickupAt! + 3_600_000,
		})
		const adopted = await adoptTab(toWireOrder(edited), 'restaurant')
		expect(adopted).toMatchObject({
			customerPhone: '+966501234567',
			pickupAt: edited.pickupAt,
			pickupTimeZone: 'Asia/Riyadh',
			orderSource: 'phone',
		})
		const paid = await addPayment(tab.id, cash(3300))
		expect(paid).toMatchObject({
			status: 'paid',
			orderSource: 'phone',
			customerPhone: '+966501234567',
			pickupAt: edited.pickupAt,
		})
		expect(await phoneOrders()).toHaveLength(1)
	})

	it('requires contact details and pickup-only fulfillment before saving or taking money', async () => {
		const phone: OrderDraft = { ...draft, orderSource: 'phone' }
		await expect(createOrder(phone, cash(3300))).rejects.toThrow('pickup only')
		const pickup: OrderDraft = {
			...phone,
			orderType: 'takeaway',
			tableLabel: '',
		}
		await expect(createOrder(pickup)).rejects.toThrow('customer name')
		await expect(
			createOrder({ ...pickup, customerName: 'Sam', customerPhone: '123' }),
		).rejects.toThrow('callback')
		expect(await db.orders.count()).toBe(0)
	})

	it('does not prune an upcoming prepaid pickup created more than 14 days ago', async () => {
		const now = Date.now()
		const order = await createOrder(
			{
				...draft,
				orderType: 'takeaway',
				orderSource: 'phone',
				tableLabel: '',
				customerName: 'Sam',
				customerPhone: '0501234567',
				pickupAt: now + 86_400_000,
				pickupTimeZone: 'Asia/Riyadh',
			},
			cash(3300),
		)
		await db.orders.update(order.id, {
			createdAt: now - 20 * 86_400_000,
			sync: 'synced',
		})
		expect(await pruneSettledOrders(now)).toBe(0)
		expect(await pruneSettledOrders(now + 16 * 86_400_000)).toBe(1)
	})
	it('saves an unpaid order as an open tab', async () => {
		const tab = await createOrder(draft)
		expect(tab).toMatchObject({
			status: 'open',
			payments: [],
			revision: 1,
			sync: 'pending',
		})
		expect(balanceCents(tab)).toBe(3300)
		expect((await openTabs()).map((o) => o.id)).toEqual([tab.id])
	})

	it('lets items be added until something is paid, and re-queues the tab', async () => {
		const tab = await createOrder(draft)
		await db.orders.update(tab.id, { sync: 'synced' })
		const next = await updateTab(tab.id, {
			...draft,
			lines: [line({ quantity: 4 })],
		})
		expect(next).toMatchObject({ revision: 2, sync: 'pending' })
		expect(next.totals.totalCents).toBe(4400)
	})

	it('freezes the tab once a payment is taken', async () => {
		const tab = await createOrder(draft)
		await addPayment(tab.id, cash(1000))
		await expect(updateTab(tab.id, draft)).rejects.toThrow('already paid')
		await expect(voidTab(tab.id, MISTAKE)).rejects.toThrow(/refund/i)
	})

	it('cancels an unpaid tab but keeps it for history', async () => {
		const tab = await createOrder(draft)
		await voidTab(tab.id, MISTAKE)
		expect((await db.orders.get(tab.id))!.status).toBe('void')
		expect(await openTabs()).toHaveLength(0)
	})

	it('survives into a later business day', async () => {
		const tab = await createOrder(draft)
		await db.orders.update(tab.id, { businessDate: '2000-01-01' })
		expect(await openTabs()).toHaveLength(1)
	})
})

describe('split payments', () => {
	it('stays open until the payments cover the total, then closes', async () => {
		const tab = await createOrder(draft)
		const first = await addPayment(tab.id, cash(1100))
		expect(first).toMatchObject({ status: 'open' })
		expect(balanceCents(first)).toBe(2200)
		const second = await addPayment(tab.id, {
			method: 'card',
			amountCents: 1100,
			tenderedCents: 1100,
			changeCents: 0,
		})
		expect(second.status).toBe('open')
		const third = await addPayment(tab.id, cash(1100))
		expect(third.status).toBe('paid')
		expect(third.payments.map((p) => p.method)).toEqual([
			'cash',
			'card',
			'cash',
		])
		expect(balanceCents(third)).toBe(0)
	})

	it('takes the first payment as part of creating the order', async () => {
		const order = await createOrder(draft, cash(1000))
		expect(order).toMatchObject({ status: 'open', revision: 1 })
		expect(order.payments).toHaveLength(1)
	})

	it('refuses an overpayment or a zero payment', async () => {
		const tab = await createOrder(draft)
		await expect(addPayment(tab.id, cash(3301))).rejects.toThrow(
			'more than the balance',
		)
		await expect(addPayment(tab.id, cash(0))).rejects.toThrow('more than zero')
	})

	it('records change per payment without counting it as paid', async () => {
		const tab = await createOrder(draft)
		const paid = await addPayment(tab.id, {
			method: 'cash',
			amountCents: 3300,
			tenderedCents: 4000,
			changeCents: 700,
		})
		expect(paid.status).toBe('paid')
		expect(paid.payments[0]!.changeCents).toBe(700)
	})

	it('fixes the tip on the first payment and ignores later changes', async () => {
		const tab = await createOrder(draft)
		const first = await addPayment(tab.id, cash(1000), 500)
		expect(first.totals.tipCents).toBe(500)
		const second = await addPayment(tab.id, cash(1000), 9999)
		expect(second.totals.tipCents).toBe(500)
		expect(second.totals.totalCents).toBe(3800)
	})

	it('keeps shares exact: three equal shares plus the remainder close the bill', async () => {
		const tab = await createOrder(draft)
		const share = Math.ceil(3300 / 3)
		let order = await addPayment(tab.id, cash(share))
		order = await addPayment(tab.id, cash(share))
		order = await addPayment(tab.id, cash(balanceCents(order)))
		expect(order.status).toBe('paid')
		expect(order.payments.reduce((s, p) => s + p.amountCents, 0)).toBe(3300)
	})

	it('refuses to pay a closed order', async () => {
		const order = await createOrder(draft, cash(3300))
		await expect(addPayment(order.id, cash(100))).rejects.toThrow(
			'already closed',
		)
	})
})

describe('v1 upgrade', () => {
	it('is covered by the schema bump: orders table indexes status', () => {
		expect(db.orders.schema.idxByName.status).toBeDefined()
	})
})

describe('retention', () => {
	const DAY = 24 * 60 * 60 * 1000
	const age = (id: string, days: number, patch: object = {}) =>
		db.orders.update(id, { createdAt: Date.now() - days * DAY, ...patch })

	it('removes old orders that are finished and already on the server', async () => {
		const old = await createOrder(draft, cash(3300))
		await age(old.id, 30, { sync: 'synced' })
		expect(await pruneSettledOrders()).toBe(1)
		expect(await db.orders.get(old.id)).toBeUndefined()
	})

	it('never removes anything the server has not confirmed, however old', async () => {
		const pending = await createOrder(draft, cash(3300))
		const rejected = await createOrder(draft, cash(3300))
		await age(pending.id, 90, { sync: 'pending' })
		await age(rejected.id, 90, { sync: 'rejected' })
		expect(await pruneSettledOrders()).toBe(0)
		expect(await db.orders.count()).toBe(2)
	})

	it('never removes an open tab, even a synced one from long ago', async () => {
		const tab = await createOrder(draft)
		await age(tab.id, 90, { sync: 'synced' })
		expect(await pruneSettledOrders()).toBe(0)
		expect((await openTabs()).map((o) => o.id)).toEqual([tab.id])
	})

	it('keeps recent history', async () => {
		const recent = await createOrder(draft, cash(3300))
		await age(recent.id, 3, { sync: 'synced' })
		expect(await pruneSettledOrders()).toBe(0)
	})

	it('keeps day numbering unaffected: the counter lives apart from the orders', async () => {
		const old = await createOrder(draft, cash(3300))
		await age(old.id, 30, { sync: 'synced' })
		await pruneSettledOrders()
		const next = await createOrder(draft, cash(3300))
		expect(next.number).toBe('T1-0002')
	})
})

describe('limits of the wire contract are enforced where the money is taken', () => {
	it(`refuses a bill with more than ${MAX_ORDER_LINES} different items, before anything is saved`, async () => {
		const lines = Array.from({ length: MAX_ORDER_LINES + 1 }, (_, i) =>
			line({ id: `l${i}`, itemId: `item-${i}` }),
		)
		await expect(createOrder({ ...draft, lines })).rejects.toThrow(
			/at most 50 different items/,
		)
		expect(await db.orders.count()).toBe(0)
		const ok = Array.from({ length: MAX_ORDER_LINES }, (_, i) =>
			line({ id: `l${i}`, itemId: `item-${i}` }),
		)
		await expect(createOrder({ ...draft, lines: ok })).resolves.toBeTruthy()
	})

	it(`refuses a ${MAX_PAYMENTS + 1}th payment on one bill`, async () => {
		const big = { ...draft, lines: [line({ quantity: 50 })] } // 50 x $10.00 + tax = $541.25
		const tab = await createOrder(big)
		for (let i = 0; i < MAX_PAYMENTS; i++) await addPayment(tab.id, cash(100))
		await expect(addPayment(tab.id, cash(100))).rejects.toThrow(
			/at most 20 payments/,
		)
	})
})

describe('a bill that comes to nothing', () => {
	const free = { ...draft, lines: [line({ baseCents: 0 })] }

	it('is closed as paid without a payment', async () => {
		const order = await createFreeOrder(free)
		expect(order).toMatchObject({
			status: 'paid',
			payments: [],
			sync: 'pending',
		})
		expect(order.totals.totalCents).toBe(0)
	})

	it('is saved in one step: a single stored revision, never an open one first', async () => {
		const order = await createFreeOrder(free)
		expect(
			(await db.orders.toArray()).map((o) => [o.id, o.status, o.revision]),
		).toEqual([[order.id, 'paid', order.revision]])
		await expect(
			createOrder(draft, undefined, { closeIfFree: true }),
		).rejects.toThrow(/still has an amount/)
		expect(await db.orders.count()).toBe(1)
	})

	it('can be closed from a saved tab, and only if it really is zero', async () => {
		const tab = await createOrder(free)
		expect((await closeFreeOrder(tab.id)).status).toBe('paid')
		const owing = await createOrder(draft)
		await expect(closeFreeOrder(owing.id)).rejects.toThrow(
			/still has an amount/,
		)
		await expect(closeFreeOrder(tab.id)).rejects.toThrow(/already closed/)
	})
})

describe("the business day is the restaurant's, not the device's", () => {
	it('uses the location time zone', () => {
		// 03:30 UTC on the 22nd is still the evening of the 21st in New York and already the 22nd in Riyadh.
		const at = new Date('2026-10-22T03:30:00Z')
		expect(localDate(at, 'America/New_York')).toBe('2026-10-21')
		expect(localDate(at, 'Asia/Riyadh')).toBe('2026-10-22')
	})

	it('falls back to the device clock for a missing or invalid zone', () => {
		const at = new Date()
		expect(localDate(at, 'Not/AZone')).toBe(localDate(at))
		expect(localDate(at, undefined)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	})

	it('stamps an order with that day', async () => {
		const order = await createOrder({
			...draft,
			timeZone: 'Pacific/Kiritimati',
		}) // UTC+14: ahead of nearly everywhere
		expect(order.businessDate).toBe(
			localDate(new Date(order.createdAt), 'Pacific/Kiritimati'),
		)
	})
})

describe('isSendable', () => {
	it('matches by restaurant, never while in demo mode', () => {
		expect(
			isSendable({ origin: 'joes' }, { slug: ' Joes ', demo: false }),
		).toBe(true)
		expect(isSendable({ origin: 'joes' }, { slug: 'mine', demo: false })).toBe(
			false,
		)
		expect(isSendable({ origin: '@demo' }, { slug: 'joes', demo: false })).toBe(
			false,
		)
		expect(isSendable({ origin: 'joes' }, { slug: 'joes', demo: true })).toBe(
			false,
		)
		expect(isSendable({}, { slug: 'joes', demo: false })).toBe(true)
	})
})
