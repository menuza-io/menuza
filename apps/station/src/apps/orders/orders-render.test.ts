// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	type PosOnlineOrderDetail,
	type PosOnlineOrdersFeed,
	type PosOnlineOrdersGrants,
	type PosOnlineOrderSummary,
} from '@repo/common/pos-online-orders'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersError } from './api.ts'
import { createDemoOrders } from './demo.ts'
import { Orders } from './Orders.tsx'
import { useOrders } from './useOrders.ts'
import { loadSettings } from '~/lib/config.ts'

vi.mock('./useOrders.ts', () => ({ useOrders: vi.fn() }))
vi.mock('../kitchen/chime.ts', () => ({
	chime: vi.fn(),
	chimeReady: () => true,
	unlockChime: vi.fn(),
}))
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 50_000_000
const demoApi = createDemoOrders()
const CASHIER: PosOnlineOrdersGrants = {
	view: true,
	manage: true,
	contact: false,
	cancel: false,
	refund: false,
}
const MANAGER: PosOnlineOrdersGrants = {
	...CASHIER,
	contact: true,
	cancel: true,
	refund: true,
}
const summary = (
	values: Partial<PosOnlineOrderSummary> = {},
): PosOnlineOrderSummary => ({
	id: 'o1',
	number: 'W-1',
	version: 'a'.repeat(64),
	status: 'ready',
	fulfillment: 'pickup',
	channel: 'web',
	tableLabel: null,
	guestName: 'Maya',
	createdAt: NOW - 5 * 60_000,
	dueAt: null,
	paymentMethod: 'handoff',
	paymentStatus: 'unpaid',
	onTab: false,
	currency: 'USD',
	totalCents: 1500,
	refundedCents: 0,
	itemCount: 2,
	openedAt: NOW - 60_000,
	completedAt: null,
	cancelledAt: null,
	...values,
})
const detailOf = (
	values: Partial<PosOnlineOrderDetail> = {},
): PosOnlineOrderDetail => ({
	...summary(),
	lines: [
		{
			name: 'Burger',
			variantNames: [],
			quantity: 2,
			totalCents: 1500,
			instructions: 'No onion',
			options: [],
		},
	],
	phoneMasked: '•••• 4567',
	hasEmail: true,
	delivery: null,
	subtotalCents: 1500,
	taxCents: 0,
	deliveryFeeCents: 0,
	tipCents: 0,
	discountCents: 0,
	loyaltyDiscountCents: 0,
	paidAt: null,
	refundableCents: 0,
	refunds: [],
	history: [],
	...values,
})

let host: HTMLDivElement
let root: Root
const command = vi.fn(async () => true)
const pinActionError = vi.fn()
beforeEach(() => {
	localStorage.clear()
	command.mockClear()
	pinActionError.mockClear()
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
		this.removeAttribute('open')
	}
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function draw(
	over: Partial<ReturnType<typeof useOrders>> = {},
	orders: PosOnlineOrderSummary[] = [summary()],
	grants = CASHIER,
	role: 'cashier' | 'manager' | null = null,
) {
	const feed: PosOnlineOrdersFeed = {
		orders,
		phonePickups: [],
		grants,
		serverNow: NOW,
		truncated: false,
	}
	vi.mocked(useOrders).mockReturnValue({
		feed,
		grants,
		error: null,
		actionError: null,
		actionName: null,
		pinActionError,
		busy: false,
		now: NOW,
		stale: false,
		refresh: vi.fn(async () => {}),
		openedHere: new Set(),
		selected: null,
		detail: null,
		contact: null,
		refundOutcome: undefined,
		open: vi.fn(async () => {}),
		view: vi.fn(async () => {}),
		api: demoApi,
		search: vi.fn(async () => ({
			results: [],
			truncated: false,
			since: NOW,
			serverNow: NOW,
		})),
		close: vi.fn(),
		command,
		refund: vi.fn(async () => true),
		revealContact: vi.fn(async () => {}),
		recordReprint: vi.fn(),
		revealing: false,
		...over,
	})
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(Orders, {
					settings: {
						...loadSettings(),
						demo: false,
						signInRequired: true,
						slug: 'test',
					},
					session: role
						? {
								staff: { id: 's1', name: 'Mona' },
								role,
								mode: 'online',
								at: NOW,
							}
						: null,
					online: true,
					businessName: 'Cafe',
					onSignIn: vi.fn(),
				}),
			),
		),
	)
}
const buttons = () =>
	[...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
/** The open dialog with this title (a dialog nested in another counts on its own). */
const openDialog = (title: string) =>
	[...document.querySelectorAll('dialog[open]')].find(
		(d) =>
			document.getElementById(d.getAttribute('aria-labelledby') ?? '')
				?.textContent === title,
	)
const button = (name: string) =>
	[...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === name,
	)!

describe('Station online orders screen', () => {
	it('alerts while a new order waits to be opened, and highlights a late one', () => {
		draw({}, [
			summary({ id: 'n', number: 'W-9', status: 'accepted', openedAt: null }),
			summary({ id: 'l', number: 'W-2', dueAt: NOW - 60_000 }),
		])
		const alert = document.querySelector('[aria-label="New orders waiting"]')
		expect(alert?.textContent).toContain('W-9')
		expect(buttons()).toContain('Open W-9')
		const late = document.querySelector('article[aria-label="Order W-2"]')!
		expect(late.className).toContain('border-destructive')
		expect(late.textContent).toContain('Late')
	})

	it('shows pause and sold out only to a signed-in manager', () => {
		draw({}, [summary()], CASHIER, 'cashier')
		expect(
			document.querySelector('[aria-label="Pause and sold out"]'),
		).toBeNull()
		draw({}, [summary()], MANAGER, 'manager')
		expect(
			document.querySelector('[aria-label="Pause and sold out"]'),
		).not.toBeNull()
	})

	it('a cashier sees a masked phone, no contact, cancel or refund actions', () => {
		draw({
			selected: 'o1',
			detail: detailOf({
				paymentMethod: 'online',
				paymentStatus: 'paid',
				refundableCents: 1500,
			}),
		})
		expect(document.body.textContent).toContain('•••• 4567')
		expect(buttons()).not.toContain('Show contact')
		expect(buttons()).not.toContain('Cancel order')
		expect(buttons()).not.toContain('Record refund')
		expect(buttons()).toContain('Hand over')
	})

	it('a manager may show the contact, cancel and record a refund', () => {
		draw(
			{
				selected: 'o1',
				grants: MANAGER,
				detail: detailOf({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					refundableCents: 1500,
				}),
			},
			[summary()],
			MANAGER,
		)
		expect(buttons()).toEqual(
			expect.arrayContaining(['Show contact', 'Cancel order', 'Refund']),
		)
		expect(buttons()).not.toContain('Record refund')
	})

	it('keeps "Record refund" for an order paid at handoff', () => {
		draw(
			{
				selected: 'o1',
				grants: MANAGER,
				detail: detailOf({
					paymentMethod: 'handoff',
					paymentStatus: 'paid',
					refundableCents: 1500,
				}),
			},
			[summary()],
			MANAGER,
		)
		expect(buttons()).toContain('Record refund')
		expect(buttons()).not.toContain('Refund')
	})

	it('shows Disputed and offers no refund while the payment is disputed', () => {
		draw(
			{
				selected: 'o1',
				grants: MANAGER,
				detail: detailOf({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					refundableCents: 1500,
					disputed: true,
				}),
			},
			[summary()],
			MANAGER,
		)
		expect(document.body.textContent).toContain('Disputed')
		expect(buttons()).not.toContain('Refund')
	})

	it('shows a pending refund with its amount, and no second refund', () => {
		draw(
			{
				selected: 'o1',
				grants: MANAGER,
				detail: detailOf({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					refundableCents: 500,
					refundStatus: 'pending',
					refundPendingCents: 1000,
				}),
			},
			[summary()],
			MANAGER,
		)
		expect(document.body.textContent).toContain('Refund pending')
		expect(document.body.textContent).toContain('10.00')
		expect((button('Refund') as HTMLButtonElement).disabled).toBe(true)
	})

	it('asks "Refund the guest?" only for an online-paid order and a refund grant', () => {
		const paid = detailOf({
			paymentMethod: 'online',
			paymentStatus: 'paid',
			refundableCents: 1500,
		})
		draw(
			{ selected: 'o1', grants: MANAGER, detail: paid },
			[summary()],
			MANAGER,
		)
		act(() => button('Cancel order').click())
		expect(document.body.textContent).toContain('Refund the guest?')
		expect(document.body.textContent).toContain('No refund')
		const withoutGrant = { ...MANAGER, refund: false }
		draw(
			{ selected: 'o1', grants: withoutGrant, detail: paid },
			[summary()],
			withoutGrant,
		)
		expect(document.body.textContent).not.toContain('Refund the guest?')
	})

	it('says what a cancel with a refund came to', () => {
		draw(
			{
				selected: 'o1',
				grants: MANAGER,
				detail: detailOf({ status: 'cancelled', cancelledAt: NOW }),
				refundOutcome: { started: false, code: 'payment_disputed' },
			},
			[summary()],
			MANAGER,
		)
		expect(document.body.textContent).toContain('payment is disputed')
	})

	it('hands a pay-at-handoff order over only once payment is ticked', () => {
		draw({ selected: 'o1', detail: detailOf() })
		const handOver = button('Hand over') as HTMLButtonElement
		expect(handOver.disabled).toBe(true)
		const box = document.querySelector<HTMLInputElement>(
			'input[type="checkbox"]',
		)!
		act(() => box.click())
		expect((button('Hand over') as HTMLButtonElement).disabled).toBe(false)
		act(() => button('Hand over').click())
		expect(command).toHaveBeenCalledWith({
			action: 'handed_over',
			expectedVersion: 'a'.repeat(64),
			markPaid: true,
		})
	})

	it('pauses every action when the feed is stale, and says so', () => {
		draw({
			stale: true,
			selected: 'o1',
			detail: detailOf({ paymentStatus: 'paid', paymentMethod: 'online' }),
		})
		expect((button('Hand over') as HTMLButtonElement).disabled).toBe(true)
		expect(document.body.textContent).toContain('Updates are paused')
		expect(document.body.textContent).toContain('Connection lost')
	})

	describe('acceptance', () => {
		const pending = (values: Partial<PosOnlineOrderSummary> = {}) =>
			summary({
				id: 'p1',
				number: 'W-7',
				status: 'pending_acceptance',
				openedAt: null,
				paymentMethod: 'online',
				paymentStatus: 'paid',
				acceptanceDeadlineAt: NOW + 192_000,
				...values,
			})

		it('puts a waiting order first with its countdown and alerts for it', () => {
			draw({}, [summary({ id: 'o2', number: 'W-2' }), pending()])
			const cards = [...document.querySelectorAll('article')].map((a) =>
				a.getAttribute('aria-label'),
			)
			expect(cards[0]).toBe('Order W-7')
			const card = document.querySelector('article[aria-label="Order W-7"]')!
			expect(card.textContent).toContain('Accept within 3:12')
			expect(card.textContent).toContain('Waiting for you')
			expect(card.textContent).not.toContain('Late')
			expect(
				document.querySelector('[aria-label="Orders waiting for you"]')
					?.textContent,
			).toContain('W-7')
			expect(buttons()).toContain('Waiting for you 1')
		})

		it('says the time is up once the deadline has passed but keeps Accept', () => {
			draw(
				{
					selected: 'p1',
					grants: MANAGER,
					detail: detailOf({
						...pending({ acceptanceDeadlineAt: NOW - 1_000 }),
					}),
				},
				[pending({ acceptanceDeadlineAt: NOW - 1_000 })],
				MANAGER,
			)
			expect(document.body.textContent).toContain('Time is up')
			expect(buttons()).toEqual(
				expect.arrayContaining(['Accept order', 'Reject']),
			)
			expect(buttons()).not.toContain('Hand over')
			expect(buttons()).not.toContain('Cancel order')
		})

		it('sends accept with the order version, and gates Reject by the cancel grant', () => {
			draw(
				{
					selected: 'p1',
					detail: detailOf({ ...pending(), version: 'b'.repeat(64) }),
				},
				[pending()],
			)
			expect(buttons()).toContain('Accept order')
			expect(buttons()).not.toContain('Reject')
			act(() => button('Accept order').click())
			expect(command).toHaveBeenCalledWith({
				action: 'accept',
				expectedVersion: 'b'.repeat(64),
			})
		})

		it('rejects with a reason and tells a paid order is refunded in full', () => {
			draw(
				{
					selected: 'p1',
					grants: MANAGER,
					detail: detailOf({ ...pending(), version: 'b'.repeat(64) }),
				},
				[pending()],
				MANAGER,
			)
			act(() => button('Reject').click())
			expect(document.body.textContent).toContain('refunded in full')
			expect(document.body.textContent).toContain('out of stock')
			act(() => button('Kitchen closed').click())
			act(() => button('Reject order').click())
			expect(command).toHaveBeenCalledWith({
				action: 'reject',
				expectedVersion: 'b'.repeat(64),
				reason: 'kitchen_closed',
			})
		})

		it('shows the reason on a rejected order and says someone else decided', () => {
			draw({
				selected: 'p1',
				actionError: new OrdersError('order_not_pending', 409),
				detail: detailOf({
					...pending(),
					status: 'cancelled',
					cancelledAt: NOW,
					rejectedReason: 'out_of_stock',
				}),
			})
			expect(document.body.textContent).toContain('Rejected: Out of stock')
			expect(document.body.textContent).toContain(
				'Someone else already decided on this order',
			)
		})

		it('says "changed on another screen" for a stale Mark ready on an order that once waited', () => {
			draw({
				selected: 'p1',
				actionName: 'ready',
				actionError: new OrdersError('stale_version', 409),
				detail: detailOf({
					...pending({
						status: 'accepted',
						acceptanceDeadlineAt: NOW - 60_000,
					}),
				}),
			})
			expect(document.body.textContent).toContain(
				'This order changed on another screen',
			)
			expect(document.body.textContent).not.toContain(
				'Someone else already decided',
			)
		})

		it('says someone else decided when a stale accept finds the order no longer waiting', () => {
			draw({
				selected: 'p1',
				actionName: 'accept',
				actionError: new OrdersError('stale_version', 409),
				detail: detailOf({
					...pending({
						status: 'accepted',
						acceptanceDeadlineAt: NOW - 60_000,
					}),
				}),
			})
			expect(document.body.textContent).toContain(
				'Someone else already decided on this order',
			)
		})

		it('shows a failed reject inside the reject dialog, keeps it up, and closes the dialog once the order is decided', () => {
			const waiting = detailOf({ ...pending(), version: 'b'.repeat(64) })
			draw(
				{ selected: 'p1', grants: MANAGER, detail: waiting },
				[pending()],
				MANAGER,
			)
			act(() => button('Reject').click())
			expect(pinActionError).toHaveBeenLastCalledWith(true)
			const failure = new OrdersError('connection_lost')
			draw(
				{
					selected: 'p1',
					grants: MANAGER,
					detail: waiting,
					actionName: 'reject',
					actionError: failure,
				},
				[pending()],
				MANAGER,
			)
			const dialog = openDialog('Reject order W-7?')!
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				'connection',
			)
			// Another screen accepted it: the dialog closes, the sheet explains.
			draw(
				{
					selected: 'p1',
					grants: MANAGER,
					detail: detailOf({ ...pending({ status: 'accepted' }) }),
					actionName: 'reject',
					actionError: new OrdersError('stale_version', 409),
				},
				[pending({ status: 'accepted' })],
				MANAGER,
			)
			expect(pinActionError).toHaveBeenLastCalledWith(false)
			expect(openDialog('Reject order W-7?')).toBeUndefined()
			expect(document.body.textContent).toContain(
				'Someone else already decided on this order',
			)
		})
	})
})

describe('order detail: packaging fee, utensils, pickup text and large order (#251, #257, #355, #408)', () => {
	const payment = () =>
		document.querySelector('section[aria-label="Payment"]')!.textContent ?? ''
	const notes = () => document.querySelector('section[aria-label="Packing"]')
	const pickupSection = () =>
		document.querySelector('section[aria-label="Pickup instructions"]')
	const open = (values: Partial<PosOnlineOrderDetail>) =>
		draw({ selected: 'o1', detail: detailOf(values) })

	it('lists the packaging fee as its own line, so the shown lines add up to the total', () => {
		// 15.00 of items + a 1.00 bag fee.
		open({ packagingFeeCents: 100, totalCents: 1600 })
		const text = payment()
		expect(text).toContain('Packaging fee')
		expect(text).toContain('$1.00')
		expect(text).toContain('$15.00')
		expect(text).toContain('$16.00')
		// The row sits with the other fees, before tax and tip.
		expect(text.indexOf('Packaging fee')).toBeLessThan(text.indexOf('Total'))
	})

	it('shows the name the restaurant gave the fee, and the default in the staff language', () => {
		open({
			packagingFeeCents: 100,
			packagingFeeLabel: 'Bag <b>fee</b>',
			totalCents: 1600,
		})
		expect(payment()).toContain('Bag <b>fee</b>')
		expect(document.querySelector('section[aria-label="Payment"] b')).toBeNull()
		expect(payment()).not.toContain('Packaging fee')
		open({
			packagingFeeCents: 100,
			packagingFeeLabel: 'Packaging fee',
			totalCents: 1600,
		})
		expect(payment()).toContain('Packaging fee')
	})

	it('shows no packaging line for an order without one, or from an older node', () => {
		open({})
		expect(payment()).not.toContain('Packaging')
		open({ packagingFeeCents: 0, totalCents: 1500 })
		expect(payment()).not.toContain('Packaging')
	})

	it('says "Utensils: yes" or "No utensils" as a clear line, and nothing when not asked', () => {
		open({ utensilsRequested: true })
		expect(notes()!.textContent).toContain('Utensils: yes')
		open({ utensilsRequested: false })
		expect(notes()!.textContent).toContain('No utensils')
		open({ utensilsRequested: null })
		expect(notes()).toBeNull()
		open({})
		expect(notes()).toBeNull()
	})

	it('says "Large order +N min" only when a large order added time', () => {
		open({ largeOrderExtraMinutes: 15 })
		expect(notes()!.textContent).toContain('Large order +15 min')
		open({ largeOrderExtraMinutes: 0 })
		expect(notes()).toBeNull()
	})

	it('shows the pickup text escaped, with its line breaks, for a pickup order only', () => {
		open({ pickupInstructions: 'Use the <b>side</b> door.\nRing the bell.' })
		const section = pickupSection()!
		expect(section.textContent).toContain('Pickup instructions')
		expect(section.textContent).toContain(
			'Use the <b>side</b> door.\nRing the bell.',
		)
		// Text, never markup: nothing was made bold.
		expect(section.querySelector('b')).toBeNull()
		expect(section.querySelector('p')!.className).toContain(
			'whitespace-pre-line',
		)
		open({
			fulfillment: 'delivery',
			pickupInstructions: 'Use the side door.',
		})
		expect(pickupSection()).toBeNull()
	})

	it('shows nothing for empty or missing pickup text', () => {
		open({ pickupInstructions: '  \n ' })
		expect(pickupSection()).toBeNull()
		open({ pickupInstructions: null })
		expect(pickupSection()).toBeNull()
		open({})
		expect(pickupSection()).toBeNull()
	})

	it('puts the utensils answer and the large-order note on the printed kitchen ticket, not the guest ticket', () => {
		vi.stubGlobal('print', vi.fn())
		open({ utensilsRequested: false, largeOrderExtraMinutes: 15 })
		act(() => button('Kitchen ticket').click())
		const kitchen = document.getElementById('receipt')!.textContent ?? ''
		expect(kitchen).toContain('No utensils')
		expect(kitchen).toContain('Large order +15 min')
		act(() => button('Guest ticket').click())
		const guest = document.getElementById('receipt')?.textContent ?? ''
		expect(guest).not.toContain('No utensils')
		expect(guest).not.toContain('Large order')
	})
})

describe('daily limits are a manager control (#409)', () => {
	const api = (rows = true) => ({
		...demoApi,
		controls: vi.fn(async () => ({
			locationId: 'loc',
			pause: null,
			heldByStock: [],
			serverNow: NOW,
		})),
		dailyLimits: vi.fn(async () => ({
			enabled: true,
			businessDate: '2026-03-10',
			rows: rows
				? [
						{
							key: 'item:i-lamb',
							kind: 'item' as const,
							id: 'i-lamb',
							name: 'Lamb shank special',
							limit: 20,
							showRemaining: true,
							toppedUpUnits: 0,
							soldUnits: 16,
							heldUnits: 0,
							remaining: 4,
						},
					]
				: [],
		})),
	})
	const openControls = async () => {
		await act(async () =>
			(
				document.querySelector(
					'button[aria-label="Pause and sold out"]',
				) as HTMLButtonElement
			).click(),
		)
	}

	it('gives a signed-in manager the section in the controls sheet', async () => {
		const mine = api()
		draw({ api: mine }, [summary()], MANAGER, 'manager')
		await openControls()
		expect(mine.dailyLimits).toHaveBeenCalledTimes(1)
		const section = document.querySelector(
			'section[aria-labelledby="controls-daily-limits"]',
		)
		expect(section?.textContent).toContain('Lamb shank special')
		expect(section?.textContent).toContain('Left: 4')
	})

	it('never mounts the controls for a cashier or a signed-out tablet, so nothing is read', async () => {
		for (const role of ['cashier', null] as const) {
			const mine = api()
			draw({ api: mine }, [summary()], CASHIER, role)
			expect(
				document.querySelector('button[aria-label="Pause and sold out"]'),
			).toBeNull()
			expect(mine.dailyLimits).not.toHaveBeenCalled()
			expect(document.body.textContent).not.toContain('Daily limits')
		}
	})

	it('leaves the sheet as it was when no dish has a limit', async () => {
		draw({ api: api(false) }, [summary()], MANAGER, 'manager')
		await openControls()
		expect(document.body.textContent).toContain('Online ordering here')
		expect(document.body.textContent).not.toContain('Daily limits')
	})
})
