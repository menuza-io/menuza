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

function section() {
	document.body.innerHTML = `<section data-messages hidden
		data-label-pending="Check your inbox to confirm"
		data-label-needs-email="Add an email address first"
		data-label-needs-phone="Verify your phone first"
		data-label-error="Could not save">
		<ul><li>
			<button role="switch" aria-checked="false" data-topic="marketing" data-channel="email" disabled></button>
			<button role="switch" aria-checked="false" data-topic="marketing" data-channel="sms" disabled></button>
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
})
