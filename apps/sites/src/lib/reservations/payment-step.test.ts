// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PayApiError, readPay, type PayApi } from './pay.ts'
import {
	buildPolicyPanel,
	createPaymentStep,
	freeCancelText,
} from './payment-step.ts'
import { testLabels } from './test-labels.ts'
import { type BookingResponse, type HoldPolicy } from './types.ts'

const labels = testLabels()

afterEach(() => {
	document.body.replaceChildren()
	vi.useRealTimers()
})

const policy: HoldPolicy = {
	kind: 'deposit',
	purpose: 'deposit',
	termsVersion: 3,
	terms: 'Deposits are refundable up to the window.',
	amountMinor: 2500,
	totalAmountMinor: 5000,
	perCover: true,
	currency: 'USD',
	freeCancelUntilMin: 1440,
	lateCancelFeeMinor: 1000,
	noShowFeeMinor: 2500,
}

describe('policy panel', () => {
	it('shows what is owed in the policy currency, fees, window and terms', () => {
		const panel = buildPolicyPanel({
			labels,
			policy,
			locale: 'en',
			partySize: 2,
		})
		document.body.append(panel.element)
		const text = panel.element.textContent ?? ''
		expect(text).toContain('You will pay a deposit of $50.00')
		expect(text).toContain('$25.00 per guest for 2 guests')
		expect(text).toContain('Free cancellation up to 1 days')
		expect(text).toContain('Late cancellation fee: $10.00')
		expect(text).toContain('No-show fee: $25.00')
		expect(text).toContain('Deposits are refundable')
		expect(panel.element.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
	})

	it('formats SAR with its own digits and a guarantee shows no charge', () => {
		const sar = buildPolicyPanel({
			labels,
			policy: { ...policy, currency: 'SAR', totalAmountMinor: 50000 },
			locale: 'ar',
			partySize: 2,
		})
		expect(sar.element.textContent).toMatch(/500\.00/)
		const guarantee = buildPolicyPanel({
			labels,
			policy: { ...policy, purpose: 'guarantee', kind: 'card_guarantee' },
			locale: 'en',
			partySize: 2,
		})
		expect(guarantee.element.textContent).toContain('Nothing is charged now')
	})

	it('requires consent and focuses the checkbox when missing', () => {
		const panel = buildPolicyPanel({
			labels,
			policy,
			locale: 'en',
			partySize: 2,
		})
		document.body.append(panel.element)
		expect(panel.check()).toBe(false)
		expect(panel.consent.getAttribute('aria-invalid')).toBe('true')
		expect(panel.consent.matches(':focus')).toBe(true)
		panel.consent.checked = true
		panel.consent.dispatchEvent(new Event('change'))
		expect(panel.check()).toBe(true)
		expect(panel.consent.hasAttribute('aria-invalid')).toBe(false)
	})

	it('words the cancel window by days, hours or minutes', () => {
		expect(freeCancelText(labels, 0)).toContain('until your booking time')
		expect(freeCancelText(labels, 120)).toContain('2 hours')
		expect(freeCancelText(labels, 90)).toContain('90 minutes')
	})
})

const booking = (expiresAt: string): BookingResponse => ({
	reservation: {
		id: 'rsv_1',
		confirmationCode: 'ABCD1234',
		status: 'pending_payment',
		channel: 'web',
		locationId: 'loc',
		locationName: 'Cafe',
		date: '2026-11-01',
		localMin: 1140,
		time: '19:00',
		startAt: '',
		endAt: '',
		partySize: 2,
		timeZone: 'UTC',
	},
	manageToken: 'manage-token-1',
	payment: {
		paymentToken: 'pay-token-12345',
		purpose: 'deposit',
		amountMinor: 5000,
		currency: 'USD',
		expiresAt,
		payUrl: null,
	},
})

function memory() {
	const map = new Map<string, string>()
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		map,
	}
}

describe('payment step', () => {
	it('stores the capability, calls checkout once and redirects', async () => {
		const storage = memory()
		const redirect = vi.fn()
		const checkout = vi.fn(async () => ({
			checkoutUrl: 'https://pay.example/1',
		}))
		const step = createPaymentStep({
			labels,
			locale: 'en',
			booking: booking(new Date(Date.now() + 600_000).toISOString()),
			clockOffsetMs: 0,
			api: { checkout } as unknown as PayApi,
			redirect,
			storage,
			bookHref: '/reserve',
		})
		document.body.append(step.element)
		expect(step.element.textContent).toContain('$50.00')
		expect(step.element.querySelector('[role="timer"]')?.textContent).toMatch(
			/Held for \d+:\d+/,
		)
		step.element
			.querySelector<HTMLButtonElement>('[data-action="pay"]')!
			.click()
		await new Promise((r) => setTimeout(r, 0))
		expect(checkout).toHaveBeenCalledTimes(1)
		expect(redirect).toHaveBeenCalledWith('https://pay.example/1')
		expect(
			readPay({ kind: 'reservation', id: 'rsv_1' }, storage),
		).toMatchObject({
			token: 'pay-token-12345',
			amountMinor: 5000,
			currency: 'USD',
		})
		expect(storage.map.get('rsv_manage_token')).toBe('manage-token-1')
		step.destroy()
	})

	it('re-enables on a network error without redirecting, and expires on hold_expired', async () => {
		const redirect = vi.fn()
		const checkout = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockRejectedValueOnce(new PayApiError(409, 'hold_expired', false))
		const step = createPaymentStep({
			labels,
			locale: 'en',
			booking: booking(new Date(Date.now() + 600_000).toISOString()),
			clockOffsetMs: 0,
			api: { checkout } as unknown as PayApi,
			redirect,
			storage: memory(),
			bookHref: '/reserve',
		})
		document.body.append(step.element)
		const button = step.element.querySelector<HTMLButtonElement>(
			'[data-action="pay"]',
		)!
		button.click()
		await new Promise((r) => setTimeout(r, 0))
		expect(step.element.textContent).toContain(labels.errorNetwork)
		expect(button.disabled).toBe(false)
		button.click()
		await new Promise((r) => setTimeout(r, 0))
		expect(step.element.textContent).toContain(labels.payStepExpired)
		expect(redirect).not.toHaveBeenCalled()
		step.destroy()
	})

	it('counts down from the server clock and expires at the deadline', () => {
		vi.useFakeTimers()
		const onExpired = vi.fn()
		const base = Date.now()
		const step = createPaymentStep({
			labels,
			locale: 'en',
			// Device clock is 60 s behind the server: the server deadline is 10 s away on the device.
			booking: booking(new Date(base + 70_000).toISOString()),
			clockOffsetMs: 60_000,
			redirect: vi.fn(),
			storage: memory(),
			bookHref: '/reserve',
			onExpired,
			api: {} as PayApi,
		})
		document.body.append(step.element)
		expect(step.element.querySelector('[role="timer"]')?.textContent).toContain(
			'0:10',
		)
		vi.advanceTimersByTime(11_000)
		expect(onExpired).toHaveBeenCalledTimes(1)
		expect(step.element.textContent).toContain(labels.payStepExpired)
	})
})
