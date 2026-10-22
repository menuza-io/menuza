import 'fake-indexeddb/auto'
import { posFiscalHash, POS_FISCAL_GENESIS_HASH } from '@repo/common/pos-fiscal'
import {
	POS_CONTRACT_VERSION,
	posOrderRequestSchema,
} from '@repo/common/pos-orders'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PosSettings } from './config.ts'
import { db } from './db.ts'
import { adoptServerChain, fiscalHead } from './fiscal.ts'
import {
	addPayment,
	adoptTab,
	createOrder,
	localDate,
	markTransferredAway,
	openTabs,
	refundableCents,
	refundOrder,
	removedLines,
	updateTab,
	type OrderDraft,
	type ServerTab,
} from './orders.ts'
import { flushOutbox, toWireOrder } from './outbox.ts'
import { computeTotals, type CartLine } from './pricing.ts'

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
const cash = (amountCents: number) => ({
	method: 'cash' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
})
const card = (amountCents: number, reference: string | null = null) => ({
	method: 'card' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
	reference,
})
const ana = { id: 'ana', name: 'Ana K.' }
const lina = { id: 'lina', name: 'Lina M.' }
const valid = (order: Parameters<typeof toWireOrder>[0]) => {
	const result = posOrderRequestSchema.safeParse(toWireOrder(order))
	return result.success ? true : result.error.issues[0]!.message
}

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe('business day', () => {
	it('keeps a late service on the day it started, until the turnover time', () => {
		const at = new Date('2026-10-22T01:30:00Z')
		expect(localDate(at, 'UTC', 0)).toBe('2026-10-22')
		expect(localDate(at, 'UTC', 240)).toBe('2026-10-21')
		expect(localDate(new Date('2026-10-22T04:00:00Z'), 'UTC', 240)).toBe(
			'2026-10-22',
		)
		// In the restaurant's zone, not the tablet's.
		expect(
			localDate(new Date('2026-10-22T00:30:00Z'), 'Asia/Riyadh', 240),
		).toBe('2026-10-21')
	})
})

describe('prices that include tax', () => {
	it('shows the tax inside the price instead of adding it', () => {
		const totals = computeTotals({
			lines: [line({ baseCents: 1150 })],
			taxRatePercent: 15,
			taxInclusive: true,
		})
		expect(totals).toMatchObject({
			subtotalCents: 1150,
			taxCents: 150,
			totalCents: 1150,
		})
		expect(
			computeTotals({ lines: [line({ baseCents: 1000 })], taxRatePercent: 15 })
				.totalCents,
		).toBe(1150)
	})

	it('stores the mode on the order and passes the contract', async () => {
		const order = await createOrder(
			{ ...draft, taxRatePercent: 15, taxInclusive: true },
			cash(3000),
		)
		expect(order).toMatchObject({ taxInclusive: true, status: 'paid' })
		expect(valid(order)).toBe(true)
	})
})

describe('taking items off a saved tab', () => {
	it('names what comes off: removed lines, lowered quantities, changed options', () => {
		const saved = [
			line({ id: 'a', quantity: 3 }),
			line({ id: 'b', itemId: 'fries', name: 'Fries' }),
			line({ id: 'c', itemId: 'tea', name: 'Tea' }),
		]
		const next = [
			line({ id: 'a', quantity: 1 }),
			line({ id: 'c', itemId: 'tea', name: 'Tea', instructions: 'iced' }),
		]
		expect(
			removedLines(saved, next).map((r) => [r.line.name, r.quantity]),
		).toEqual([
			['Burger', 2],
			['Fries', 1],
			['Tea', 1],
		])
		expect(removedLines(saved, [...saved, line({ id: 'd' })])).toEqual([])
	})

	it('needs a reason, and records who, why and who approved', async () => {
		const tab = await createOrder(draft)
		const smaller = { ...draft, lines: [line({ quantity: 1 })] }
		await expect(updateTab(tab.id, smaller)).rejects.toThrow(/why/)
		const saved = await updateTab(tab.id, smaller, {
			reason: 'guest_request',
			by: ana,
			approvedBy: lina,
		})
		expect(saved.lineVoids).toMatchObject([
			{
				name: 'Burger',
				quantity: 2,
				unitCents: 1000,
				reason: 'guest_request',
				by: ana,
				approvedBy: lina,
			},
		])
		expect(valid(saved)).toBe(true)
		// Adding needs no reason.
		const bigger = await updateTab(tab.id, {
			...draft,
			lines: [line({ quantity: 2 })],
		})
		expect(bigger.lineVoids).toHaveLength(1)
	})
})

describe('fiscal chain', () => {
	it('issues a numbered, hash-linked invoice when a sale closes, and nothing for an open tab', async () => {
		const tab = await createOrder(draft)
		expect(tab.fiscal).toEqual([])
		const first = await createOrder(draft, cash(3300))
		const second = await addPayment(tab.id, cash(3300))
		const [a] = first.fiscal
		const [b] = second.fiscal
		expect(a).toMatchObject({
			kind: 'invoice',
			counter: 1,
			previousHash: POS_FISCAL_GENESIS_HASH,
			totalCents: 3300,
			taxCents: 300,
		})
		expect(b).toMatchObject({ counter: 2, previousHash: a!.hash })
		const { hash, ...unsigned } = b!
		expect(posFiscalHash(unsigned)).toBe(hash)
		expect((await fiscalHead()).counter).toBe(2)
		expect(valid(second)).toBe(true)
	})

	it('continues the server’s chain only when this till has issued nothing itself', async () => {
		const server = [
			{
				chainId: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c99',
				counter: 41,
				hash: 'a'.repeat(64),
			},
		]
		expect(await adoptServerChain(server)).toBe(true)
		const order = await createOrder(draft, cash(3300))
		expect(order.fiscal[0]).toMatchObject({
			counter: 42,
			previousHash: 'a'.repeat(64),
		})
		// Once it has its own documents, a different chain never replaces it.
		expect(
			await adoptServerChain([
				{ chainId: crypto.randomUUID(), counter: 99, hash: 'b'.repeat(64) },
			]),
		).toBe(false)
	})
})

describe('refunds', () => {
	it('gives money back in the tender it was paid with, newest payment first, with a credit note each', async () => {
		const tab = await createOrder(draft)
		await addPayment(tab.id, cash(1300))
		const paid = await addPayment(tab.id, card(2000, 'AUTH 77'))
		expect(refundableCents(paid)).toBe(3300)
		const part = await refundOrder(tab.id, {
			amountCents: 2500,
			reason: 'wrong_charge',
			by: ana,
			approvedBy: lina,
		})
		expect(part.status).toBe('paid')
		expect(part.refunds.map((r) => [r.method, r.amountCents])).toEqual([
			['card', 2000],
			['cash', 500],
		])
		expect(part.fiscal.map((d) => [d.kind, d.counter])).toEqual([
			['invoice', 1],
			['credit_note', 2],
			['credit_note', 3],
		])
		expect(valid(part)).toBe(true)
		await expect(
			refundOrder(tab.id, {
				amountCents: 900,
				reason: 'other',
				by: ana,
				approvedBy: null,
			}),
		).rejects.toThrow(/more than/)
		const full = await refundOrder(tab.id, {
			amountCents: 800,
			reason: 'other',
			by: ana,
			approvedBy: null,
		})
		expect(full.status).toBe('refunded')
		expect(refundableCents(full)).toBe(0)
		expect(valid(full)).toBe(true)
	})

	it('refuses to refund an open tab', async () => {
		const tab = await createOrder(draft)
		await expect(
			refundOrder(tab.id, {
				amountCents: 100,
				reason: 'other',
				by: null,
				approvedBy: null,
			}),
		).rejects.toThrow(/paid/)
	})
})

describe('tabs moving between terminals', () => {
	it('stops showing a tab another terminal took over, and keeps it as history', async () => {
		const tab = await createOrder(draft)
		expect(
			await markTransferredAway([{ orderId: tab.id, terminalCode: 'T2' }]),
		).toBe(1)
		expect(await openTabs()).toEqual([])
		await expect(updateTab(tab.id, draft)).rejects.toThrow(/T2/)
	})

	it('adopts a tab taken over from another terminal as already sent', async () => {
		const tab: ServerTab = {
			id: crypto.randomUUID(),
			revision: 3,
			number: 'T2-0004',
			businessDate: '2026-10-21',
			createdAt: new Date().toISOString(),
			locationId: 'loc',
			currency: 'USD',
			taxRatePercent: 10,
			taxInclusive: false,
			orderType: 'dine_in',
			customerName: null,
			tableLabel: '9',
			staff: null,
			signIn: null,
			lines: [
				{
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
			lineVoids: [],
			adjustments: [],
			totals: {
				subtotalCents: 1000,
				adjustmentCents: 0,
				taxCents: 100,
				tipCents: 0,
				totalCents: 1100,
			},
			payments: [],
		}
		const adopted = await adoptTab(tab, 'demo')
		expect(adopted).toMatchObject({
			number: 'T2-0004',
			revision: 3,
			sync: 'synced',
			status: 'open',
		})
		const paid = await addPayment(adopted.id, cash(1100))
		expect(paid.revision).toBe(4)
		expect(valid(paid)).toBe(true)
	})
})

describe('held uploads', () => {
	const settings: PosSettings = {
		appUrl: 'https://app.test',
		slug: 'demo',
		tenantApiUrl: 'https://api.test',
		terminalCode: 'T1',
		locationId: 'loc',
		locationLocked: false,
		scopeId: 'main',
		signInRequired: false,
		dayStartMinutes: 240,
		shiftsRequired: false,
		idleLockSeconds: 120,
		deviceToken: 'secret',
		deviceLabel: null,
		demo: false,
		locale: null,
	}

	it('treats an upload the server kept for review as delivered, and a moved tab as moved', async () => {
		const tab = await createOrder({ ...draft, origin: 'demo' })
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						result: 'held',
						error: 'order_transferred',
						toTerminal: 'Bar (B1)',
					}),
					{ status: 202 },
				),
			),
		)
		expect(await flushOutbox(settings)).toBe(1)
		const stored = (await db.orders.get(tab.id))!
		expect(stored).toMatchObject({
			sync: 'synced',
			heldReason: 'order_transferred',
			transferredTo: 'Bar (B1)',
		})
	})

	it('sends the contract version with every upload', async () => {
		await createOrder({ ...draft, origin: 'demo' })
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ order: {} }), { status: 201 }),
			)
		vi.stubGlobal('fetch', fetchMock)
		await flushOutbox(settings)
		const init = fetchMock.mock.calls[0]![1] as RequestInit
		expect((init.headers as Record<string, string>)['Pos-Contract']).toBe(
			String(POS_CONTRACT_VERSION),
		)
	})
})
