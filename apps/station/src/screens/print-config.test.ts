/* eslint-disable testing-library/no-unnecessary-act */
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type TicketsConfig, resolveTickets } from '@repo/common/ticket-config'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrintedTicket } from '../apps/orders/Orders.tsx'
import { Checkout } from './Checkout.tsx'
import { PrintedKitchenTicket } from './PrintedKitchenTicket.tsx'
import { Receipt } from './Receipt.tsx'
import { db, type PosOrder } from '~/lib/db.ts'
import { localDate, type OrderDraft } from '~/lib/orders.ts'
import { usePos } from '~/lib/store.ts'
import { kitchenTicketPlan } from '~/lib/tickets.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
	i18n.load('en', {})
	i18n.activate('en')
	vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(
		'18/11/2026, 14:02',
	)
	vi.stubGlobal('matchMedia', () => ({
		matches: true,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	}))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	HTMLElement.prototype.scrollIntoView = vi.fn()
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.open = true
	}
	HTMLDialogElement.prototype.close = function close() {
		this.open = false
	}
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	setTickets({})
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	document.getElementById('receipt')?.remove()
	usePos.setState({ location: null })
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

/** The location's saved ticket settings, as Station receives them with the menu. */
function setTickets(tickets: TicketsConfig) {
	usePos.setState({
		location: { id: 'loc', stationSettings: { tickets } } as never,
	})
}

const order = (over: Partial<PosOrder> = {}): PosOrder =>
	({
		id: 'o1',
		number: 'T1-0042',
		businessDate: '2026-11-18',
		createdAt: 1_800_000_000_000,
		orderType: 'dine_in',
		customerName: '',
		tableLabel: '4',
		locationId: 'loc',
		currency: 'USD',
		taxRatePercent: 10,
		taxInclusive: false,
		catalogFetchedAt: null,
		lines: [
			{
				id: 'l1',
				itemId: 'burger',
				name: 'Burger',
				variantId: null,
				variantLabel: null,
				quantity: 2,
				baseCents: 1000,
				instructions: 'no onions',
				options: [
					{
						groupId: 'g',
						groupName: 'Extras',
						optionId: 'cheese',
						optionName: 'Cheese',
						quantity: 1,
						unitCents: 150,
						taxable: true,
					},
				],
				sentAt: 1_800_000_000_000,
			},
		],
		lineVoids: [],
		adjustments: [
			{ id: 'a1', kind: 'manual', label: 'Staff meal', amountCents: 200 },
		],
		totals: {
			subtotalCents: 2300,
			adjustmentCents: 200,
			taxCents: 210,
			tipCents: 300,
			totalCents: 2610,
		},
		status: 'paid',
		payments: [
			{
				id: 'p1',
				method: 'cash',
				amountCents: 2610,
				tenderedCents: 3000,
				changeCents: 390,
				at: 1_800_000_000_000,
			},
		],
		refunds: [
			{
				id: 'r1',
				paymentId: 'p1',
				method: 'cash',
				amountCents: 500,
				at: 1_800_000_100_000,
				by: null,
				approvedBy: null,
				reason: 'mistake',
				reference: null,
			},
		],
		fiscal: [
			{ kind: 'invoice', counter: 7, at: 1, totalCents: 2610, taxCents: 210 },
		] as never,
		revision: 1,
		updatedAt: 1_800_000_000_000,
		sync: 'synced',
		attempts: 0,
		nextAttemptAt: 0,
		lastError: null,
		syncedAt: null,
		serverNumber: null,
		staff: { id: 's', name: 'Sam L.' },
		...over,
	}) as PosOrder

const draw = (node: ReturnType<typeof h>) => {
	act(() => root.render(h(I18nProvider, { i18n }, node)))
	return document.getElementById('receipt')?.textContent ?? ''
}
const receipt = (o: PosOrder = order(), vatNumber: string | null = null) =>
	draw(h(Receipt, { order: o, businessName: 'Cafe Bloom', vatNumber }))

describe('hiding a field removes it from the printed receipt (#363)', () => {
	// What each hideable field prints, in the fixture above.
	const probes: Array<[string, string]> = [
		['businessName', 'Cafe Bloom'],
		['dateTime', '18/11/2026, 14:02'],
		['orderNumber', '#T1-0042'],
		['orderType', 'Table 4'],
		['servedBy', 'Served by'],
		['itemOptions', 'Cheese'],
		['itemNotes', 'no onions'],
		['subtotal', 'Subtotal'],
		['discounts', 'Staff meal'],
		['tip', 'Tip'],
		['payments', 'Paid · Cash'],
		['change', 'Change'],
		['refunds', 'Refunded'],
		['thankYou', 'Thank you!'],
	]

	it.each(probes)('%s', (key, text) => {
		expect(receipt()).toContain(text)
		setTickets({ receipt: { [key]: { show: false } } })
		const without = receipt()
		expect(without).not.toContain(text)
		// Everything else still prints.
		expect(without).toContain('Burger')
		expect(without).toContain('Total')
	})

	it('the balance due of an open bill', () => {
		const open = order({
			status: 'open',
			payments: [],
			refunds: [],
			fiscal: [],
		})
		expect(receipt(open)).toContain('Balance due')
		setTickets({ receipt: { balanceDue: { show: false } } })
		expect(receipt(open)).not.toContain('Balance due')
	})

	it('never hides what the law and the totals need, even if a setting says to', () => {
		setTickets({
			receipt: {
				vatNumber: { show: false },
				invoiceTitle: { show: false },
				invoiceNumber: { show: false },
				items: { show: false },
				tax: { show: false },
				total: { show: false },
			},
		})
		const text = receipt(order(), '300000000000003')
		for (const needed of [
			'VAT No. 300000000000003',
			'Simplified tax invoice',
			'Invoice 7',
			'Burger',
			'Tax',
			'Total',
		])
			expect(text).toContain(needed)
	})

	it('makes a field bold or larger without hiding it', () => {
		setTickets({ receipt: { total: { bold: true, large: true } } })
		receipt()
		const total = [...document.querySelectorAll('#receipt div')].find((node) =>
			node.textContent?.startsWith('Total'),
		)!
		expect(total.className).toContain('font-bold')
		expect(total.className).toContain('text-base')
	})
})

const detail = (over: Record<string, unknown> = {}) =>
	({
		id: 'w1',
		number: 'W-0951',
		fulfillment: 'delivery',
		tableLabel: null,
		createdAt: 1_800_000_000_000,
		dueAt: 1_800_000_900_000,
		guestName: 'Jordan',
		phoneMasked: '•••• 0111',
		currency: 'USD',
		totalCents: 2800,
		paymentStatus: 'paid',
		onTab: false,
		utensilsRequested: true,
		largeOrderExtraMinutes: 10,
		status: 'preparing',
		lines: [
			{
				name: 'Pizza',
				variantNames: [],
				quantity: 2,
				totalCents: 2400,
				instructions: 'well done',
				options: [
					{
						name: 'Olives',
						quantity: 1,
						half: null,
						kitchenName: 'OLV',
						groupName: 'Toppings',
						highlight: 'allergy',
					},
				],
				kitchenName: 'PZ L',
				highlight: 'attention',
				courseId: 'c1',
				courseName: 'Mains',
				coursePosition: 1,
			},
		],
		...over,
	}) as never
const time = new Intl.DateTimeFormat('en', {
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
})
const online = (
	kind: 'guest' | 'kitchen',
	o: unknown = detail(),
	extra: Record<string, unknown> = {},
) =>
	draw(
		h(PrintedTicket, {
			kind,
			detail: o as never,
			businessName: 'Cafe Bloom',
			time,
			kitchenSwitches: {
				showPaymentStatus: false,
				showOrderTypeColor: false,
				showModifierGroups: false,
			},
			...extra,
		}),
	)

describe('hiding a field removes it from the printed kitchen and guest tickets (#363)', () => {
	const kitchen: Array<[string, string]> = [
		['ticketTitle', 'Kitchen ticket'],
		['dateTime', '08:00 AM'],
		['orderNumber', '#W-0951'],
		['orderType', 'Delivery'],
		['utensils', 'Utensils: yes'],
		['largeOrder', 'Large order +10 min'],
		['courses', 'Mains'],
		['itemOptions', 'OLV'],
		['itemNotes', 'well done'],
		['highlights', 'Attention'],
	]
	it.each(kitchen)('kitchen: %s', (key, text) => {
		expect(online('kitchen')).toContain(text)
		setTickets({ kitchen: { [key]: { show: false } } })
		const without = online('kitchen')
		expect(without).not.toContain(text)
		expect(without).toContain('PZ L')
	})

	const guest: Array<[string, string]> = [
		['businessName', 'Cafe Bloom'],
		['guestContact', 'Jordan'],
		['payments', 'Paid'],
		['itemNotes', 'well done'],
	]
	it.each(guest)('guest ticket: %s', (key, text) => {
		expect(online('guest')).toContain(text)
		setTickets({ receipt: { [key]: { show: false } } })
		expect(online('guest')).not.toContain(text)
	})

	it('one type’s settings never change another’s', () => {
		setTickets({ kitchen: { itemNotes: { show: false } } })
		expect(online('guest')).toContain('well done')
		expect(online('kitchen')).not.toContain('well done')
	})
})

describe('a cancelled order prints a cancellation slip when enabled (#363)', () => {
	it('an online order that was cancelled', () => {
		const cancelled = detail({ status: 'cancelled' })
		expect(online('kitchen', cancelled)).toContain('Kitchen ticket')
		expect(online('kitchen', cancelled)).not.toContain('CANCELLED')
		setTickets({ cancellationSlip: true })
		const slip = online('kitchen', cancelled)
		expect(slip).toContain('CANCELLED')
		expect(slip).not.toContain('Kitchen ticket')
		// What to stop making is still on it.
		expect(slip).toContain('PZ L')
		// A live order is not a slip.
		expect(online('kitchen')).toContain('Kitchen ticket')
		// The guest's own ticket is never a slip.
		expect(online('guest', cancelled)).not.toContain('CANCELLED')
	})

	it('says CANCELLED even when the owner hid the ticket title, and before the screen shows the new status', () => {
		setTickets({
			cancellationSlip: true,
			kitchen: { ticketTitle: { show: false } },
		})
		expect(online('kitchen', detail(), { cancelled: true })).toContain(
			'CANCELLED',
		)
		expect(online('kitchen')).not.toContain('Kitchen ticket')
	})

	it('a till order that was cancelled', () => {
		const voided = order({
			status: 'void',
			voidedAt: 1_800_000_500_000,
			orderType: 'takeaway',
			tableLabel: '',
		})
		expect(kitchenTicketPlan(voided, resolveTickets({}))).toBeNull()
		const tickets = resolveTickets({ cancellationSlip: true })
		const plan = kitchenTicketPlan(voided, tickets)!
		expect(plan.kind).toBe('cancelled')
		setTickets({ cancellationSlip: true })
		const text = draw(h(PrintedKitchenTicket, { order: voided, plan }))
		expect(text).toContain('CANCELLED')
		expect(text).toContain('#T1-0042')
		expect(text).toContain('Burger')
		expect(text).not.toContain('Sam')
		expect(text).not.toContain('$')
	})
})

describe('an adjusted order prints only its changes when that option is on (#363)', () => {
	const sent = (id: string, name: string, at: number, extra = {}) => ({
		id,
		itemId: id,
		name,
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 500,
		instructions: '',
		options: [],
		sentAt: at,
		...extra,
	})
	const adjusted = order({
		status: 'open',
		payments: [],
		refunds: [],
		lines: [
			sent('a', 'Soup', 1_800_000_000_000),
			sent('b', 'Steak', 1_800_000_000_000),
			sent('c', 'Cheesecake', 1_800_000_600_000),
		] as never,
		lineVoids: [
			{
				id: 'v1',
				itemId: 'x',
				name: 'Salad',
				variantLabel: null,
				quantity: 1,
				unitCents: 400,
				at: 1_800_000_500_000,
				by: null,
				approvedBy: null,
				reason: 'mistake',
			},
			{
				id: 'v0',
				itemId: 'y',
				name: 'Bread',
				variantLabel: null,
				quantity: 1,
				unitCents: 100,
				at: 1_799_999_000_000,
				by: null,
				approvedBy: null,
				reason: 'mistake',
			},
		] as never,
	})

	it('prints the whole order by default', () => {
		setTickets({})
		const plan = kitchenTicketPlan(adjusted, resolveTickets({}))!
		expect(plan.kind).toBe('full')
		const text = draw(h(PrintedKitchenTicket, { order: adjusted, plan }))
		for (const dish of ['Soup', 'Steak', 'Cheesecake'])
			expect(text).toContain(dish)
		expect(text).toContain('Kitchen ticket')
	})

	it('prints the newest round, and what was taken off since the one before, when only changes are wanted', () => {
		const tickets = resolveTickets({ changesOnly: true })
		setTickets({ changesOnly: true })
		const plan = kitchenTicketPlan(adjusted, tickets)!
		expect(plan.kind).toBe('changes')
		const text = draw(h(PrintedKitchenTicket, { order: adjusted, plan }))
		expect(text).toContain('Cheesecake')
		expect(text).toContain('Taken off')
		expect(text).toContain('Salad')
		for (const earlier of ['Soup', 'Steak', 'Bread'])
			expect(text).not.toContain(earlier)
		expect(text).toContain('changes only')
	})

	it('an order that went to the kitchen once has no changes to print', () => {
		const single = order({
			lines: [sent('a', 'Soup', 1_800_000_000_000)] as never,
		})
		expect(
			kitchenTicketPlan(single, resolveTickets({ changesOnly: true }))!.kind,
		).toBe('full')
	})

	it('strikes through dishes already served when asked', () => {
		const served = order({
			lines: [
				sent('a', 'Soup', 1_800_000_000_000, { servedAt: 1_800_000_100_000 }),
				sent('b', 'Steak', 1_800_000_000_000),
			] as never,
		})
		setTickets({ strikeCompleted: true })
		const plan = kitchenTicketPlan(
			served,
			resolveTickets({ strikeCompleted: true }),
		)!
		draw(h(PrintedKitchenTicket, { order: served, plan }))
		const struck = [...document.querySelectorAll('#receipt [data-served]')]
		expect(struck).toHaveLength(1)
		expect(struck[0]!.className).toContain('line-through')
		expect(struck[0]!.textContent).toContain('Soup')
		// Off by default.
		setTickets({})
		draw(h(PrintedKitchenTicket, { order: served, plan }))
		expect(document.querySelector('#receipt .line-through')).toBeNull()
	})

	it('leaves dine-in out of printing when asked', () => {
		const tickets = resolveTickets({ excludeDineIn: true, changesOnly: true })
		expect(kitchenTicketPlan(adjusted, tickets)).toBeNull()
		expect(
			kitchenTicketPlan({ ...adjusted, orderType: 'takeaway' }, tickets)!.kind,
		).toBe('changes')
	})
})

describe('when the receipt prints (#363)', () => {
	const draft: OrderDraft = {
		terminalCode: 'T1',
		locationId: 'loc',
		currency: 'USD',
		taxRatePercent: 0,
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
	const pay = async (orderType: OrderDraft['orderType'] = 'dine_in') => {
		act(() =>
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(Checkout, {
						draft: { ...draft, orderType },
						existing: null,
						businessName: 'Cafe',
						money: (c: number) => `$${(c / 100).toFixed(2)}`,
						tipsEnabled: false,
						staff: null,
						onSaved: () => undefined,
						onClose: () => undefined,
					}),
				),
			),
		)
		const click = (match: (b: HTMLButtonElement) => boolean) => {
			const button = [...document.querySelectorAll('button')].find(match)!
			act(() => button.click())
		}
		click((b) => b.textContent?.trim() === 'Exact')
		await act(async () => {
			click((b) => Boolean(b.textContent?.trim().startsWith('Confirm')))
			await new Promise((resolve) => setTimeout(resolve, 60))
		})
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 40))
		})
	}

	it('by hand by default: closing the bill prints nothing by itself', async () => {
		const print = vi.fn()
		vi.stubGlobal('print', print)
		await pay()
		expect(document.body.textContent).toContain('Paid')
		expect(print).not.toHaveBeenCalled()
	})

	it('prints the receipt when the bill closes, if the owner chose that', async () => {
		const print = vi.fn()
		vi.stubGlobal('print', print)
		setTickets({ when: { receipt: 'on_close' } })
		await pay('takeaway')
		// The save and the print run after the click; a busy CI runner can
		// take longer than the helper's fixed pauses.
		await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1))
	})

	it('does not print by itself for dine-in when dine-in is left out', async () => {
		const print = vi.fn()
		vi.stubGlobal('print', print)
		setTickets({ when: { receipt: 'on_close' }, excludeDineIn: true })
		await pay('dine_in')
		expect(print).not.toHaveBeenCalled()
	})
})

describe('the orders list prints the kitchen ticket of a till order (#363)', () => {
	const lineAt = (id: string, name: string, at: number) => ({
		id,
		itemId: id,
		name,
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 500,
		instructions: '',
		options: [],
		sentAt: at,
	})
	const putTab = async (over: Partial<PosOrder> = {}) => {
		await db.orders.put(
			order({
				id: 'tab1',
				status: 'open',
				payments: [],
				refunds: [],
				fiscal: [],
				lines: [
					lineAt('a', 'Soup', 1_800_000_000_000),
					lineAt('c', 'Cheesecake', 1_800_000_600_000),
				] as never,
				...over,
			}),
		)
	}
	const open = async () => {
		const { OrdersSheet } = await import('./OrdersSheet.tsx')
		act(() =>
			root.render(
				h(
					I18nProvider,
					{ i18n },
					h(OrdersSheet, {
						dayStartMinutes: 240,
						vatNumber: null,
						onClose: () => undefined,
						businessName: 'Cafe',
						onRetry: () => undefined,
						onAddItems: () => undefined,
						onPay: () => undefined,
					}),
				),
			),
		)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 80))
		})
		const card = [...document.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('T1-0042'),
		)
		act(() => card?.click())
	}
	const buttons = () =>
		[...document.querySelectorAll('button')].map((b) => b.textContent?.trim())

	it('offers no kitchen ticket for an ordinary order, as before', async () => {
		await putTab()
		await open()
		expect(buttons()).toContain('Print bill')
		expect(buttons()).not.toContain('Print changes')
	})

	it('prints only the changes of an adjusted tab when that is on', async () => {
		setTickets({ changesOnly: true })
		await putTab()
		await open()
		const onPaper: string[] = []
		vi.stubGlobal(
			'print',
			vi.fn(() => {
				onPaper.push(document.getElementById('receipt')?.textContent ?? '')
			}),
		)
		const button = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Print changes',
		)!
		act(() => button.click())
		for (let i = 0; i < 3; i++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40))
			})
		expect(onPaper).toHaveLength(1)
		expect(onPaper[0]).toContain('Cheesecake')
		expect(onPaper[0]).not.toContain('Soup')
		expect(onPaper[0]).toContain('changes only')
	})

	it('offers a cancellation slip for a cancelled order when that is on', async () => {
		setTickets({ cancellationSlip: true })
		await putTab({
			status: 'void',
			businessDate: localDate(new Date(), undefined, 240),
			createdAt: Date.now(),
			updatedAt: Date.now(),
			voidedAt: Date.now(),
		})
		await open()
		// A cancelled order is found in the day's list, not among the open tabs.
		const today = [...document.querySelectorAll('button')].find((b) =>
			Boolean(b.textContent?.trim().startsWith('Today')),
		)
		act(() => today?.click())
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60))
		})
		const card = [...document.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('T1-0042'),
		)
		act(() => card?.click())
		expect(buttons()).toContain('Print cancellation slip')
	})
})
