// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountTableOrdering } from './table-ordering.ts'
import { type CartStore } from '~/lib/ordering/cart-store'
import {
	TableRequestError,
	type TableContext,
	type TableSession,
} from '~/lib/ordering/table-session'
import { type CartItem } from '~/lib/ordering/types'

/**
 * How many are at the table (#422): asked once where the restaurant limits a
 * table's head count, kept for the tab session, sent with every round, and
 * refused in the region's own words when it is too big.
 */

const mocks = vi.hoisted(() => ({
	submitRound: vi.fn(),
	context: { value: null as unknown },
}))

vi.mock('~/lib/ordering/table-session', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	loadTableSession: () => storedSession(),
	saveTableSession: () => {},
	fetchTableContext: () => Promise.resolve(mocks.context.value),
	submitTableRound: mocks.submitRound,
	fetchTab: () => Promise.reject(new Error('not used')),
}))

const ORG = 'org-1'
const LOCATION = 'loc-1'
const tableToken = `tbl-1.1.${'a'.repeat(64)}`

function storedSession(): TableSession {
	return {
		orgId: ORG,
		locationId: LOCATION,
		tableToken,
		tableLabel: 'T4',
		tabId: null,
		tabToken: null,
		tabNumber: null,
		policy: {
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: false,
		},
		savedAt: Date.now(),
	}
}

function context(maxGuests: number | null): TableContext {
	return {
		table: { label: 'T4', locationId: LOCATION },
		dineIn: {
			enabled: true,
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: false,
		},
		maxGuests,
		openTab: null,
	}
}

const LABELS = {
	tableLabel: 'Table {label}',
	tabNumber: 'Tab {number}',
	sendToKitchen: 'Send to kitchen',
	sending: 'Sending',
	sent: 'Sent',
	errorGeneric: 'generic error',
	guestsTitle: 'How many are at your table?',
	guestsInvalid: 'Enter how many people are at your table.',
	orderTooLarge: 'orderTooLarge',
	orderTooLargeCall: 'orderTooLargeCall {phone}',
	orderTooLargeGuests: 'This group is too large to order from the table.',
	dailyDishSoldOut: 'generic sold out',
	dishSoldOut: 'There is not enough {name} left',
	dishesSoldOut: 'not enough of {names}',
	dishOnlyLeft: 'Only {count} of {name} left',
}

const line = (over: Partial<CartItem> = {}): CartItem => ({
	id: 'l1',
	itemId: 'special',
	quantity: 1,
	name: 'Lamb special',
	basePrice: 10,
	unitPrice: 10,
	options: [],
	instructions: '',
	...over,
})

const created = {
	order: {
		id: 'o1',
		number: '1',
		status: 'accepted',
		paymentStatus: 'unpaid',
		currency: 'USD',
		subtotalCents: 1000,
		taxCents: 0,
		deliveryFeeCents: 0,
		tipCents: 0,
		totalCents: 1000,
		holdExpiresAt: null,
	},
	receiptToken: 'r'.repeat(64),
	tab: { id: 'tab-1', tabNumber: '001', tabToken: `tab-1.1.${'b'.repeat(64)}` },
}

async function mount() {
	document.body.innerHTML = `
		<script type="application/json" id="table-labels">${JSON.stringify(LABELS)}</script>
		<div id="table-notice"></div>
		<div id="table-alert"></div>
		<div id="cart-drawer-header-extra"></div>
		<button id="drawer-checkout-btn" type="button"><span>Checkout</span></button>
		<div id="table-guests-backdrop" class="site-overlay hidden">
			<form id="table-guests">
				<button id="table-guests-close" type="button">Close</button>
				<input name="guests" type="number" />
				<p id="table-guests-error" class="hidden"></p>
				<button type="submit">Send</button>
			</form>
		</div>`
	const clear = vi.fn()
	let cart: CartItem[] = [line()]
	mountTableOrdering({
		orgId: ORG,
		locationId: LOCATION,
		locale: 'en',
		formatMoney: (amount) => `$${amount.toFixed(2)}`,
		store: { lines: () => cart, clear } as unknown as CartStore,
		cart: { open: vi.fn(), close: vi.fn(), refresh: vi.fn() },
	})
	await vi.waitFor(() =>
		expect(document.documentElement.dataset.tableMode).toBe('true'),
	)
	const byId = (id: string) => document.getElementById(id)!
	const form = byId('table-guests') as HTMLFormElement
	return {
		setCart(next: CartItem[]) {
			cart = next
		},
		send() {
			byId('drawer-checkout-btn').click()
		},
		backdrop: byId('table-guests-backdrop'),
		error: byId('table-guests-error'),
		cartError: () => byId('cart-drawer-header-extra').textContent ?? '',
		answer(text: string) {
			;(form.elements.namedItem('guests') as HTMLInputElement).value = text
			form.dispatchEvent(new Event('submit', { cancelable: true }))
		},
		close() {
			byId('table-guests-close').click()
		},
	}
}

beforeEach(() => {
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	sessionStorage.clear()
	mocks.submitRound.mockReset()
	mocks.submitRound.mockResolvedValue(created)
	mocks.context.value = context(4)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('how many are at the table (#422)', () => {
	it('asks before the first round and sends the answer with it', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		expect(mocks.submitRound).not.toHaveBeenCalled()

		t.answer('3')
		await vi.waitFor(() => expect(mocks.submitRound).toHaveBeenCalledTimes(1))
		expect(mocks.submitRound.mock.calls[0]![1]).toMatchObject({
			fulfillment: 'dine_in',
			guestCount: 3,
		})
		expect(t.backdrop).toHaveClass('hidden')
	})

	it('keeps the answer for the tab session instead of asking again', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		t.answer('3')
		await vi.waitFor(() => expect(mocks.submitRound).toHaveBeenCalledTimes(1))

		t.send()
		await vi.waitFor(() => expect(mocks.submitRound).toHaveBeenCalledTimes(2))
		expect(t.backdrop).toHaveClass('hidden')
		expect(mocks.submitRound.mock.calls[1]![1]).toMatchObject({ guestCount: 3 })
	})

	it('sends nothing when the sheet is closed', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		t.close()
		await Promise.resolve()
		expect(t.backdrop).toHaveClass('hidden')
		expect(mocks.submitRound).not.toHaveBeenCalled()
	})

	it('does not accept something that is not a count', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		for (const bad of ['', '0', 'four', '-2']) {
			t.answer(bad)
			await vi.waitFor(() =>
				expect(t.error).toHaveTextContent(
					'Enter how many people are at your table.',
				),
			)
		}
		expect(mocks.submitRound).not.toHaveBeenCalled()
		expect(t.backdrop).not.toHaveClass('hidden')
	})

	it('tells a group over the limit so at once, with no round trip', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		t.answer('9')
		await vi.waitFor(() =>
			expect(t.error).toHaveTextContent(
				'This group is too large to order from the table.',
			),
		)
		expect(mocks.submitRound).not.toHaveBeenCalled()
		// The limit itself is never in the message.
		expect(t.error.textContent).not.toMatch(/\b4\b/)
	})

	it('never asks, and sends no head count, where the restaurant sets no limit', async () => {
		mocks.context.value = context(null)
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(mocks.submitRound).toHaveBeenCalledTimes(1))
		expect(t.backdrop).toHaveClass('hidden')
		expect(mocks.submitRound.mock.calls[0]![1]).not.toHaveProperty('guestCount')
	})

	it('says so in the region’s words, and asks again next time, when the region refuses the group', async () => {
		const t = await mount()
		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
		mocks.submitRound.mockRejectedValueOnce(
			new TableRequestError('order_too_large', 422, {
				error: 'order_too_large',
				details: { kind: 'guests', fulfillment: 'dine_in' },
			}),
		)
		t.answer('4')
		await vi.waitFor(() =>
			expect(t.cartError()).toBe(
				'This group is too large to order from the table.',
			),
		)

		t.send()
		await vi.waitFor(() => expect(t.backdrop).not.toHaveClass('hidden'))
	})
})

describe('a dish that ran out for today (#409) at the table', () => {
	it('names the dish from the cart, and keeps the cart', async () => {
		mocks.context.value = context(null)
		const t = await mount()
		mocks.submitRound.mockRejectedValueOnce(
			new TableRequestError('daily_dish_sold_out', 422, {
				error: 'daily_dish_sold_out',
				details: {
					short: [{ key: 'item:special', kind: 'item', id: 'special' }],
				},
			}),
		)
		t.send()
		await vi.waitFor(() =>
			expect(t.cartError()).toBe('There is not enough Lamb special left'),
		)
	})

	it('names an option the guest chose', async () => {
		mocks.context.value = context(null)
		const t = await mount()
		t.setCart([
			line({
				options: [
					{
						groupId: 'g',
						groupName: 'Side',
						optionId: 'dessert',
						optionName: 'Dessert',
						priceDelta: 2,
					},
				],
			}),
		])
		mocks.submitRound.mockRejectedValueOnce(
			new TableRequestError('daily_dish_sold_out', 422, {
				details: {
					short: [{ key: 'option:dessert', kind: 'option', id: 'dessert' }],
				},
			}),
		)
		t.send()
		await vi.waitFor(() =>
			expect(t.cartError()).toBe('There is not enough Dessert left'),
		)
	})

	it('says only how many are left when the region sent that number', async () => {
		mocks.context.value = context(null)
		const t = await mount()
		mocks.submitRound.mockRejectedValueOnce(
			new TableRequestError('daily_dish_sold_out', 422, {
				details: {
					short: [
						{ key: 'item:special', kind: 'item', id: 'special', remaining: 2 },
					],
				},
			}),
		)
		t.send()
		await vi.waitFor(() =>
			expect(t.cartError()).toBe('Only 2 of Lamb special left'),
		)
	})
})
