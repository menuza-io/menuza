/* eslint-disable testing-library/no-unnecessary-act */
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrintedTicket } from '../apps/orders/Orders.tsx'
import { Receipt } from './Receipt.tsx'
import { type PosOrder } from '~/lib/db.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * What the till prints today. These snapshots were taken from the code as it
 * was before ticket contents became configurable (#363): with no settings, the
 * printed markup must be byte for byte the same.
 */
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	// Dates print in the tablet's own zone: fix the text, not the clock.
	vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(
		'18/11/2026, 14:02',
	)
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	document.getElementById('receipt')?.remove()
	vi.restoreAllMocks()
})

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
				variantId: 'v',
				variantLabel: 'Large',
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
			},
			{
				id: 'l2',
				itemId: 'fries',
				name: 'Fries',
				variantId: null,
				variantLabel: null,
				quantity: 1,
				baseCents: 400,
				instructions: '',
				options: [],
			},
		],
		lineVoids: [],
		adjustments: [
			{ id: 'a1', kind: 'manual', label: 'Staff meal', amountCents: 200 },
		],
		totals: {
			subtotalCents: 2700,
			adjustmentCents: 200,
			taxCents: 250,
			tipCents: 300,
			totalCents: 3050,
		},
		status: 'paid',
		payments: [
			{
				id: 'p1',
				method: 'cash',
				amountCents: 3050,
				tenderedCents: 4000,
				changeCents: 950,
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
			{
				kind: 'invoice',
				counter: 7,
				at: 1_800_000_000_000,
				totalCents: 3050,
				taxCents: 250,
			},
		] as never,
		revision: 2,
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
	// The icon sprite's address depends on where the repository is checked out.
	return document
		.getElementById('receipt')!
		.outerHTML.replace(/href="[^"]*sprite\.svg#/g, 'href="SPRITE#')
}

describe('the till receipt as it prints today', () => {
	it('a dine-in sale paid in cash, with an option, a note, a discount, a tip and a refund', () => {
		expect(
			draw(h(Receipt, { order: order(), businessName: 'Cafe Bloom' })),
		).toMatchSnapshot()
	})

	it('the same sale as a simplified tax invoice', () => {
		expect(
			draw(
				h(Receipt, {
					order: order(),
					businessName: 'Cafe Bloom',
					vatNumber: '300000000000003',
				}),
			),
		).toMatchSnapshot()
	})

	it('an open tab (a bill) with a balance and a takeaway name', () => {
		expect(
			draw(
				h(Receipt, {
					order: order({
						status: 'open',
						orderType: 'takeaway',
						customerName: 'Dana',
						payments: [],
						refunds: [],
						fiscal: [],
						staff: null,
					}),
					businessName: 'Cafe Bloom',
				}),
			),
		).toMatchSnapshot()
	})

	it('a drive-through order', () => {
		expect(
			draw(
				h(Receipt, {
					order: order({
						orderType: 'drive_through',
						driveThroughNote: 'Lane 2',
						refunds: [],
					}),
					businessName: 'Cafe Bloom',
				}),
			),
		).toMatchSnapshot()
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
				variantNames: ['Large'],
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
				held: true,
			},
			{
				name: 'Cola',
				variantNames: [],
				quantity: 1,
				totalCents: 400,
				instructions: null,
				options: [],
			},
		],
		...over,
	}) as never

const switches = (over: Record<string, boolean> = {}) => ({
	showPaymentStatus: false,
	showOrderTypeColor: false,
	showModifierGroups: false,
	...over,
})
const time = new Intl.DateTimeFormat('en', {
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
})

describe('the online order tickets as they print today', () => {
	const ticket = (
		kind: 'guest' | 'kitchen',
		order: unknown = detail(),
		kitchenSwitches = switches(),
	) =>
		draw(
			h(PrintedTicket, {
				kind,
				detail: order as never,
				businessName: 'Cafe Bloom',
				time,
				kitchenSwitches,
			}),
		)

	it('the guest ticket', () => {
		expect(ticket('guest')).toMatchSnapshot()
	})
	it('the kitchen ticket, every switch off', () => {
		expect(ticket('kitchen')).toMatchSnapshot()
	})
	it('the kitchen ticket with payment status, colour and modifier groups on', () => {
		expect(
			ticket(
				'kitchen',
				detail(),
				switches({
					showPaymentStatus: true,
					showOrderTypeColor: true,
					showModifierGroups: true,
				}),
			),
		).toMatchSnapshot()
	})
	it('a dine-in pay-at-handoff order on the tab', () => {
		expect(
			ticket(
				'guest',
				detail({
					fulfillment: 'dine_in',
					tableLabel: '9',
					paymentStatus: 'unpaid',
					onTab: true,
					dueAt: null,
				}),
			),
		).toMatchSnapshot()
	})
})

describe('sanity', () => {
	it('the fixtures print something', () => {
		expect(draw(h(Receipt, { order: order(), businessName: 'X' }))).toContain(
			'Burger',
		)
		expect(host).toBeTruthy()
		expect(vi.isMockFunction(Date.prototype.toLocaleString)).toBe(true)
	})
})
