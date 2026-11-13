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
beforeEach(() => {
	localStorage.clear()
	command.mockClear()
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
		busy: false,
		now: NOW,
		stale: false,
		refresh: vi.fn(async () => {}),
		openedHere: new Set(),
		selected: null,
		detail: null,
		contact: null,
		open: vi.fn(async () => {}),
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
					session: null,
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
			expect.arrayContaining(['Show contact', 'Cancel order', 'Record refund']),
		)
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
})
