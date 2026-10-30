// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { type QrPublicTab } from '@repo/common/qr-ordering'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountTableOrdering } from './table-ordering.ts'
import { type CartStore } from '~/lib/ordering/cart-store'
import {
	TableRequestError,
	type TableContext,
	type TableSession,
} from '~/lib/ordering/table-session'

const mocks = vi.hoisted(() => ({
	placement: vi.fn(),
	startTabPayment: vi.fn(),
	mountTabRewards: vi.fn(),
	navigate: vi.fn(),
}))

vi.mock('~/lib/client-auth', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	getAccessToken: () => 'customer-token',
}))

vi.mock('~/lib/ordering/table-session', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	loadTableSession: () => storedSession(),
	saveTableSession: () => {},
	fetchTableContext: () => Promise.resolve(tableContext()),
	fetchTab: () => Promise.resolve(openTab()),
	startTabPayment: mocks.startTabPayment,
}))

vi.mock('~/lib/loyalty/tab-rewards', () => ({
	mountTabRewards: mocks.mountTabRewards,
}))

const ORG = 'org-1'
const LOCATION = 'loc-1'
const tabToken = `tab-1.1.${'b'.repeat(64)}`
const coffee = {
	rewardId: 'rwd_coffee',
	rewardVersion: 1,
	expectedDiscountMinor: 500,
	targetLineId: null,
}

function storedSession(): TableSession {
	return {
		orgId: ORG,
		locationId: LOCATION,
		tableToken: `tbl-1.1.${'a'.repeat(64)}`,
		tableLabel: 'T4',
		tabId: 'tab-1',
		tabToken,
		tabNumber: '007',
		policy: {
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: true,
		},
		savedAt: Date.now(),
	}
}

function tableContext(): TableContext {
	return {
		table: { label: 'T4', locationId: LOCATION },
		dineIn: {
			enabled: true,
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: true,
		},
		openTab: {
			id: 'tab-1',
			tabToken,
			tabNumber: '007',
			roundsCount: 1,
			totalCents: 2_165,
		},
	}
}

function openTab(): QrPublicTab {
	return {
		id: 'tab-1',
		tabNumber: '007',
		status: 'open',
		paymentStatus: 'unpaid',
		table: { id: 'tbl-1', label: 'T4', locationId: LOCATION },
		openedAt: '2030-01-01T12:00:00.000Z',
		closedAt: null,
		rounds: [],
		totals: {
			currency: 'USD',
			subtotalCents: 2_000,
			taxCents: 165,
			taxInclusive: false,
			tipCents: 0,
			loyaltyDiscountCents: 0,
			totalCents: 2_165,
		},
		roundsPending: false,
	}
}

const LABELS = Object.fromEntries(
	[
		'tableLabel',
		'tabNumber',
		'sendToKitchen',
		'sending',
		'sent',
		'round',
		'emptyTab',
		'payAtCounter',
		'tax',
		'includesTax',
		'closed',
		'cancelled',
		'statusAccepted',
		'statusPreparing',
		'statusReady',
		'statusCompleted',
		'statusCancelled',
		'errorGeneric',
		'errorTableGone',
		'errorLocked',
		'errorTabPaying',
		'errorClosed',
		'errorRateLimited',
		'errorUnavailable',
		'payNow',
		'paying',
		'checkingPayment',
		'paidThanks',
		'payLater',
		'payUnavailable',
		'payCancelled',
		'contactMissing',
		'nameMissing',
		'phoneInvalid',
		'leaveConfirm',
		'leaveWarning',
		'tabLoadFailed',
		'tryAgain',
		'stillConfirming',
		'payPending',
	].map((key) => [key, key]),
)

/** The region's answer to starting the payment, charging `amountCents`. */
function started(amountCents: number) {
	return {
		url: 'https://pay.example/c/1',
		amountCents,
		tipCents: 0,
		loyaltyDiscountCents: 0,
		currency: 'USD',
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

function mount() {
	document.body.innerHTML = `
		<script type="application/json" id="table-labels">${JSON.stringify({
			...LABELS,
			payAmount: 'Pay {amount}',
			payAmountChanged: 'The total is now {amount}.',
		})}</script>
		<div id="table-notice"></div>
		<div id="table-alert"></div>
		<button id="open-tab-btn" type="button">View tab</button>
		<div id="tab-drawer-backdrop" class="site-overlay hidden">
			<div id="tab-drawer">
				<button id="close-tab-btn" type="button">Close tab</button>
				<div id="tab-rounds"></div>
				<div id="tab-pay-slot"></div>
			</div>
		</div>
		<div id="tab-pay-backdrop" class="site-overlay hidden">
			<form id="tab-pay">
				<button id="tab-pay-close" type="button">Close</button>
				<input name="name" />
				<input name="phone" />
				<fieldset>
					<input type="radio" name="tipPercent" value="0" checked />
				</fieldset>
				<div id="tab-rewards" class="hidden">
					<div id="tab-rewards-options"></div>
				</div>
				<p id="tab-pay-error" class="hidden"></p>
				<p id="tab-pay-changed" class="hidden"></p>
				<button id="tab-pay-submit" type="submit">Pay</button>
			</form>
		</div>`
	mountTableOrdering({
		orgId: ORG,
		locationId: LOCATION,
		locale: 'en',
		formatMoney: (amount) => `$${amount.toFixed(2)}`,
		store: {} as CartStore,
		cart: { open: vi.fn(), close: vi.fn(), refresh: vi.fn() },
		navigate: mocks.navigate,
	})
	const byId = (id: string) => document.getElementById(id)!
	const form = byId('tab-pay') as HTMLFormElement
	return {
		sheet: byId('tab-pay-backdrop'),
		submit: byId('tab-pay-submit') as HTMLButtonElement,
		changed: byId('tab-pay-changed'),
		name: form.elements.namedItem('name') as HTMLInputElement,
		tip: form.querySelector('fieldset')!,
		rewardOptions: byId('tab-rewards-options'),
		error: byId('tab-pay-error'),
		/** Opens the tab drawer, then the pay sheet from its Pay button. */
		async openSheet() {
			byId('open-tab-btn').click()
			const pay = await vi.waitFor(() => {
				const button = byId('tab-pay-slot').querySelector('button')
				expect(button).not.toBeNull()
				return button!
			})
			pay.click()
			// The reward picker loads on first use.
			await vi.waitFor(() => expect(mocks.mountTabRewards).toHaveBeenCalled())
			await Promise.resolve()
		},
		pay() {
			;(form.elements.namedItem('name') as HTMLInputElement).value = 'Sam'
			;(form.elements.namedItem('phone') as HTMLInputElement).value =
				'+1 555 0100'
			form.dispatchEvent(new Event('submit', { cancelable: true }))
		},
		close() {
			byId('tab-pay-close').click()
		},
	}
}

beforeEach(() => {
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	mocks.placement.mockReset()
	mocks.startTabPayment.mockReset()
	mocks.mountTabRewards.mockReset()
	mocks.navigate.mockReset()
	mocks.mountTabRewards.mockImplementation(() => ({
		open: () => {},
		amountMinor: (total: number, tip: number) => total + tip,
		placement: mocks.placement,
		refused: () => null,
	}))
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('paying the tab from the phone', () => {
	it('lets the guest close the sheet while the reward is still being confirmed', async () => {
		const t = mount()
		// The table session starts up from the stored tab.
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		const confirming = deferred<{ ok: true; loyalty: typeof coffee }>()
		mocks.placement.mockReturnValueOnce(confirming.promise)
		t.pay()
		expect(t.submit).toHaveAttribute('aria-busy', 'true')
		expect(t.name).toBeDisabled()

		t.close()
		expect(t.sheet).toHaveClass('hidden')
		expect(t.submit).not.toHaveAttribute('aria-busy')
		expect(t.submit).toBeEnabled()
		expect(t.name).toBeEnabled()

		// The reward is confirmed after the guest left: nothing is sent.
		confirming.resolve({ ok: true, loyalty: coffee })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(mocks.startTabPayment).not.toHaveBeenCalled()

		// Opening the sheet again starts a fresh payment.
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: coffee })
		mocks.startTabPayment.mockReturnValueOnce(new Promise(() => {}))
		await t.openSheet()
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.startTabPayment).toHaveBeenCalledTimes(1),
		)
		expect(mocks.startTabPayment.mock.calls[0]?.[2]).toMatchObject({
			loyalty: coffee,
		})
	})

	it('keeps the sheet open once the payment start is on its way', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockReturnValueOnce(new Promise(() => {}))
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.startTabPayment).toHaveBeenCalledTimes(1),
		)
		// The region is fixing the amount and the hosted page follows.
		t.close()
		expect(t.sheet).not.toHaveClass('hidden')
		expect(t.submit).toHaveAttribute('aria-busy', 'true')
	})

	it('opens the payment page when the region charges what the sheet showed', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		expect(t.submit).toHaveTextContent('Pay $21.65')
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_165))
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith('https://pay.example/c/1'),
		)
		expect(t.changed).toHaveClass('hidden')
	})

	it('shows a changed amount before the payment page opens', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_400))
		t.pay()
		await vi.waitFor(() =>
			expect(t.changed).toHaveTextContent('The total is now $24.00.'),
		)
		expect(t.changed).not.toHaveClass('hidden')
		expect(mocks.navigate).not.toHaveBeenCalled()
		expect(t.submit).toHaveTextContent('Pay $24.00')
		expect(t.submit).toBeEnabled()
		expect(t.submit).not.toHaveAttribute('aria-busy')
		expect(t.submit).toHaveFocus()
		// The hosted page charges this tip and reward, so they stay as they are.
		expect(t.name).toBeDisabled()

		// Paying again opens the page the region already started.
		t.pay()
		expect(mocks.navigate).toHaveBeenCalledWith('https://pay.example/c/1')
		expect(mocks.startTabPayment).toHaveBeenCalledTimes(1)
		expect(t.submit).toHaveAttribute('aria-busy', 'true')
	})

	it('lets the guest back out of a changed amount', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_400))
		t.pay()
		await vi.waitFor(() => expect(t.submit).toHaveTextContent('Pay $24.00'))

		t.close()
		expect(t.sheet).toHaveClass('hidden')
		expect(t.changed).toHaveClass('hidden')
		expect(t.name).toBeEnabled()
		expect(mocks.navigate).not.toHaveBeenCalled()

		// Opening the sheet again asks the region afresh.
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_165))
		await t.openSheet()
		expect(t.submit).toHaveTextContent('Pay $21.65')
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith('https://pay.example/c/1'),
		)
		expect(mocks.startTabPayment).toHaveBeenCalledTimes(2)
	})

	it('keeps the tip and reward locked after backing out of a started payment', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: coffee })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_400))
		t.pay()
		await vi.waitFor(() => expect(t.submit).toHaveTextContent('Pay $24.00'))

		t.close()
		// The region holds a payment with this tip and reward: another one
		// would be refused as someone else paying.
		expect(t.tip).toBeDisabled()
		expect(t.rewardOptions.inert).toBe(true)
		expect(t.name).toBeEnabled()

		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: coffee })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_400))
		await t.openSheet()
		await vi.waitFor(() => expect(t.changed).toHaveTextContent('payPending'))
		expect(t.changed).not.toHaveClass('hidden')
		expect(t.tip).toBeDisabled()
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.startTabPayment).toHaveBeenCalledTimes(2),
		)
		expect(mocks.startTabPayment.mock.calls[1]?.[2]).toMatchObject({
			tipPercent: 0,
			loyalty: coffee,
		})
	})

	it('does not blame another diner while the region still holds this guest’s payment', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockResolvedValueOnce(started(2_400))
		t.pay()
		await vi.waitFor(() => expect(t.submit).toHaveTextContent('Pay $24.00'))
		t.close()

		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockRejectedValueOnce(
			new TableRequestError('tab_paying', 409),
		)
		await t.openSheet()
		t.pay()
		await vi.waitFor(() => expect(t.error).toHaveTextContent('payPending'))
		expect(t.error).not.toHaveTextContent('errorTabPaying')
		expect(t.tip).toBeDisabled()
		expect(t.name).toBeEnabled()
	})

	it('keeps the tip locked when the payment start got no answer', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockRejectedValueOnce(
			new TableRequestError('network', 0),
		)
		t.pay()
		await vi.waitFor(() => expect(t.error).toHaveTextContent('errorGeneric'))
		// The region may have started it: the same tip is re-served.
		expect(t.tip).toBeDisabled()
		expect(t.name).toBeEnabled()
		expect(t.submit).toBeEnabled()
	})

	it('lets the guest close the sheet once a payment start that never answered has timed out', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		const answer = deferred<never>()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockReturnValueOnce(answer.promise)
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.startTabPayment).toHaveBeenCalledTimes(1),
		)
		// Sent: the sheet cannot be closed while the region may answer.
		t.close()
		expect(t.sheet).not.toHaveClass('hidden')
		// The request timed out: the try again error shows and closing works.
		answer.reject(new TableRequestError('network', 0))
		await vi.waitFor(() => expect(t.error).toHaveTextContent('errorGeneric'))
		expect(t.submit).toBeEnabled()
		t.close()
		expect(t.sheet).toHaveClass('hidden')
	})

	it('unlocks the tip once the region refuses the payment for good', async () => {
		const t = mount()
		await vi.waitFor(() =>
			expect(document.documentElement.dataset.tableMode).toBe('true'),
		)
		await t.openSheet()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockRejectedValueOnce(
			new TableRequestError('network', 0),
		)
		t.pay()
		await vi.waitFor(() => expect(t.error).toHaveTextContent('errorGeneric'))
		expect(t.tip).toBeDisabled()
		mocks.placement.mockResolvedValueOnce({ ok: true, loyalty: null })
		mocks.startTabPayment.mockRejectedValueOnce(
			new TableRequestError('tab_closed', 409),
		)
		t.pay()
		await vi.waitFor(() =>
			expect(mocks.startTabPayment).toHaveBeenCalledTimes(2),
		)
		await vi.waitFor(() => expect(t.tip).toBeEnabled())
		expect(t.rewardOptions.inert).toBe(false)
	})
})
