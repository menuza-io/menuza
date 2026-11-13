// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	fetchSubscriptions: vi.fn(),
	setSubscription: vi.fn(),
}))

vi.mock('~/lib/marketing-consent-client', async () => {
	const actual = await vi.importActual('~/lib/marketing-consent-client')
	return {
		...actual,
		fetchSubscriptions: mocks.fetchSubscriptions,
		setSubscription: mocks.setSubscription,
	}
})

import { mountMessagesSection } from './messages-section-client'

function section(extra = '', wrapSms = '') {
	document.body.innerHTML = `<section data-messages hidden ${extra}
		data-text-version-marketing="guest-profile-us-2026-11"
		data-label-pending="Check your inbox to confirm"
		data-label-needs-email="Add an email address first"
		data-label-needs-phone="Verify your phone first"
		data-label-error="Could not save">
		<ul><li>
			<button role="switch" aria-checked="false" data-topic="marketing" data-channel="email" disabled></button>
			<div data-switch-row ${wrapSms}><button role="switch" aria-checked="false" data-topic="marketing" data-channel="sms" disabled></button></div>
			<p data-status></p>
		</li></ul></section>`
	return document.querySelector<HTMLElement>('[data-messages]')!
}
const sw = (channel: string) =>
	document.querySelector<HTMLButtonElement>(`[data-channel="${channel}"]`)!
const status = () => document.querySelector('[data-status]')!.textContent

describe('mountMessagesSection', () => {
	beforeEach(() => {
		mocks.fetchSubscriptions.mockReset()
		mocks.setSubscription.mockReset()
	})

	it('stays hidden when the subscriptions cannot be loaded', async () => {
		mocks.fetchSubscriptions.mockResolvedValue(null)
		const root = section()
		await mountMessagesSection(root)
		expect(root.hidden).toBe(true)
		expect(sw('sms').disabled).toBe(true)
	})

	it('paints state and shows the pending hint for an unconfirmed email', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([
			{
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				confirmed: false,
			},
			{ topic: 'marketing', channel: 'sms', subscribed: true },
		])
		const root = section()
		await mountMessagesSection(root)
		expect(root.hidden).toBe(false)
		expect(sw('email').getAttribute('aria-checked')).toBe('true')
		expect(sw('sms').getAttribute('aria-checked')).toBe('true')
		expect(status()).toBe('Check your inbox to confirm')
	})

	it('turns a switch on and shows pending after an email opt-in', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([])
		mocks.setSubscription.mockResolvedValue({ status: 'ok', state: 'pending' })
		await mountMessagesSection(section())
		sw('email').click()
		await vi.waitFor(() => expect(status()).toBe('Check your inbox to confirm'))
		expect(mocks.setSubscription).toHaveBeenCalledWith(
			'marketing',
			'email',
			true,
			'profile',
			'guest-profile-us-2026-11',
		)
		expect(sw('email').getAttribute('aria-checked')).toBe('true')
	})

	it('rolls back and explains a 409', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([])
		mocks.setSubscription.mockResolvedValue({ status: 'needs_phone' })
		await mountMessagesSection(section())
		sw('sms').click()
		await vi.waitFor(() => expect(status()).toBe('Verify your phone first'))
		expect(sw('sms').getAttribute('aria-checked')).toBe('false')
		expect(sw('sms').disabled).toBe(false)
	})

	it('rolls back an opt-out that failed', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([
			{ topic: 'marketing', channel: 'sms', subscribed: true },
		])
		mocks.setSubscription.mockResolvedValue({ status: 'error' })
		await mountMessagesSection(section())
		sw('sms').click()
		await vi.waitFor(() => expect(status()).toBe('Could not save'))
		expect(sw('sms').getAttribute('aria-checked')).toBe('true')
	})

	it('keeps focus and ignores presses while a save is in flight', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([])
		let finish!: (v: unknown) => void
		mocks.setSubscription.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		await mountMessagesSection(section())
		const button = sw('sms')
		button.focus()
		button.click()
		expect(button.disabled).toBe(false)
		expect(button.getAttribute('aria-disabled')).toBe('true')
		expect(button.getAttribute('aria-busy')).toBe('true')
		expect(document.activeElement).toBe(button)
		button.click()
		expect(mocks.setSubscription).toHaveBeenCalledTimes(1)
		finish({ status: 'ok', state: 'on' })
		await vi.waitFor(() =>
			expect(button.hasAttribute('aria-disabled')).toBe(false),
		)
		expect(button.hasAttribute('aria-busy')).toBe(false)
		expect(document.activeElement).toBe(button)
	})

	it('sends no text version for a topic outside the offers wording', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([])
		mocks.setSubscription.mockResolvedValue({ status: 'ok', state: 'on' })
		document.body.innerHTML = `<section data-messages hidden data-text-version-marketing="v1"><ul><li>
			<button role="switch" aria-checked="false" data-topic="reservations" data-channel="email" disabled></button>
			<p data-status></p></li></ul></section>`
		await mountMessagesSection(
			document.querySelector<HTMLElement>('[data-messages]')!,
		)
		sw('email').click()
		await vi.waitFor(() => expect(mocks.setSubscription).toHaveBeenCalled())
		expect(mocks.setSubscription.mock.calls[0]?.[4]).toBeUndefined()
	})

	it('in KSA shows the Text switch only for an active subscription and never opts in', async () => {
		mocks.fetchSubscriptions.mockResolvedValue([])
		const root = section('data-ksa="true"', 'hidden')
		await mountMessagesSection(root)
		expect(
			document.querySelector<HTMLElement>('[data-switch-row]')!.hidden,
		).toBe(true)
		sw('sms').click()
		expect(mocks.setSubscription).not.toHaveBeenCalled()

		mocks.fetchSubscriptions.mockResolvedValue([
			{ topic: 'marketing', channel: 'sms', subscribed: true },
		])
		mocks.setSubscription.mockResolvedValue({ status: 'ok', state: 'off' })
		await mountMessagesSection(section('data-ksa="true"', 'hidden'))
		expect(
			document.querySelector<HTMLElement>('[data-switch-row]')!.hidden,
		).toBe(false)
		sw('sms').click()
		await vi.waitFor(() => expect(mocks.setSubscription).toHaveBeenCalled())
	})
})
