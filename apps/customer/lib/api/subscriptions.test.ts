import { MARKETING_CONSENT_TEXT_VERSION } from '@repo/common/marketing-consent'
import { ApiError } from '@/lib/api/api-error'
import {
	SubscriptionsClient,
	subscriptionFailure,
	subscriptionState,
} from '@/lib/api/subscriptions'
import { makeSignedInSession } from '@/test/loyalty/session'
import { StubTransport } from '@/test/stub-transport'

async function setup(transport: StubTransport) {
	const session = await makeSignedInSession(transport.send)
	return new SubscriptionsClient(session)
}

describe('SubscriptionsClient', () => {
	it('lists the rows with the customer token', async () => {
		const transport = new StubTransport([
			{
				json: {
					drops: { sms: false },
					subscriptions: [
						{
							topic: 'marketing',
							channel: 'email',
							subscribed: true,
							confirmed: false,
						},
					],
				},
			},
		])
		const rows = await (await setup(transport)).list()
		expect(rows).toHaveLength(1)
		const sent = transport.recorded[0]!
		expect(sent.request.method).toBe('GET')
		expect(sent.url.pathname).toBe('/subscriptions')
		expect(sent.request.headers.Authorization).toMatch(/^Bearer /)
	})

	it('opts in with the source and text version, and maps pending', async () => {
		const transport = new StubTransport([{ json: { pending: true } }])
		const state = await (await setup(transport)).set('marketing', 'email', true)
		expect(state).toBe('pending')
		const sent = transport.recorded[0]!
		expect(sent.request.method).toBe('PUT')
		expect(sent.url.pathname).toBe('/subscriptions/marketing/email')
		expect(sent.body).toEqual({
			subscribed: true,
			source: 'profile',
			textVersion: MARKETING_CONSENT_TEXT_VERSION,
		})
	})

	it('opts out without a text version', async () => {
		const transport = new StubTransport([{ json: { subscribed: false } }])
		const state = await (
			await setup(transport)
		).set('reservations', 'sms', false)
		expect(state).toBe('off')
		expect(transport.recorded[0]!.body).toEqual({
			subscribed: false,
			source: 'profile',
		})
	})

	it('surfaces a 409 as an ApiError the screen can word', async () => {
		const transport = new StubTransport([
			{ status: 409, json: { error: 'An email address is required' } },
		])
		const failure = await (
			await setup(transport)
		)
			.set('marketing', 'email', true)
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ApiError)
		expect(subscriptionFailure(failure, 'email')).toBe('needs_email')
		expect(subscriptionFailure(failure, 'sms')).toBe('needs_phone')
		expect(subscriptionFailure(new Error('x'), 'sms')).toBe('unknown')
	})
})

describe('subscriptionState', () => {
	it('treats a missing row as off and an unconfirmed email as pending', () => {
		const rows = [
			{
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				confirmed: false,
			},
			{ topic: 'marketing', channel: 'sms', subscribed: true },
		] as const
		expect(subscriptionState(rows, 'marketing', 'email')).toBe('pending')
		expect(subscriptionState(rows, 'marketing', 'sms')).toBe('on')
		expect(subscriptionState(rows, 'reservations', 'sms')).toBe('off')
	})
})
