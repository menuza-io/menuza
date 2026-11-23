import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forward = vi.hoisted(() => vi.fn())
vi.mock('../lib/sms-status-forward.ts', () => ({
	forwardSmsStatus: forward,
	SMS_STATUS_APP_PATH: '/resources/support/sms-status',
}))

import { mockSignature } from '../lib/sms-inbound-provider.ts'
import { lookupNumber, mockLookup } from '../lib/phone-lookup.ts'
import { phoneLookupRoutes } from './phone-lookup.ts'
import { smsStatusWebhookRoutes } from './sms-status.ts'

const AUTH = 'twilio-auth-token-for-tests'
const TOKEN = 'test-internal-token-very-long-12345'
const app = new Hono()
	.route('/webhooks/sms-status', smsStatusWebhookRoutes)
	.route('/api/phone-lookup', phoneLookupRoutes)

function report(body: string, signature?: string) {
	return app.request('/webhooks/sms-status/mock', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			...(signature ? { 'X-Mock-Signature': signature } : {}),
		},
		body,
	})
}

beforeEach(() => {
	forward.mockReset().mockResolvedValue(true)
	vi.stubEnv('NODE_ENV', 'test')
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH)
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
})
afterEach(() => vi.unstubAllEnvs())

describe('text delivery report (#246)', () => {
	it('hands the App the message id, the status and the error code, and nothing else', async () => {
		const body =
			'MessageSid=SM1234567890abcdef&MessageStatus=undelivered&ErrorCode=30006&To=%2B15551230000&From=%2B15550001111&Body=secret'
		const response = await report(body, mockSignature(AUTH, body))
		expect(response.status).toBe(200)
		expect(forward).toHaveBeenCalledWith({
			providerMessageId: 'SM1234567890abcdef',
			status: 'undelivered',
			errorCode: '30006',
		})
		// No number and no body in what is forwarded.
		expect(JSON.stringify(forward.mock.calls)).not.toMatch(/5551230000|secret/)
	})

	it('refuses a forged or unsigned report before reading it', async () => {
		const body = 'MessageSid=SM1234567890abcdef&MessageStatus=delivered'
		expect((await report(body, 'f'.repeat(64))).status).toBe(401)
		expect((await report(body)).status).toBe(401)
		expect(forward).not.toHaveBeenCalled()
	})

	it('asks the provider to retry when the App could not be told', async () => {
		forward.mockResolvedValue(false)
		const body = 'MessageSid=SM1234567890abcdef&MessageStatus=delivered'
		expect((await report(body, mockSignature(AUTH, body))).status).toBe(502)
	})
})

describe('phone lookup (#246)', () => {
	function lookup(to: string, authorized = true) {
		return app.request('/api/phone-lookup', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(authorized ? { Authorization: `Bearer ${TOKEN}` } : {}),
			},
			body: JSON.stringify({ to }),
		})
	}

	it('identifies a landline, a virtual line, an invalid number and a mobile', async () => {
		vi.stubEnv('TWILIO_ACCOUNT_SID', '')
		expect(await (await lookup('+14155550000')).json()).toMatchObject({
			valid: true,
			lineType: 'landline',
		})
		expect(await (await lookup('+14155557777')).json()).toMatchObject({
			valid: true,
			lineType: 'voip',
		})
		expect(await (await lookup('+14155559999')).json()).toMatchObject({
			valid: false,
		})
		expect(await (await lookup('+14155551234')).json()).toMatchObject({
			valid: true,
			lineType: 'mobile',
		})
		// Not even a phone number: no provider call, not valid.
		expect(await (await lookup('not a number')).json()).toMatchObject({
			valid: false,
		})
	})

	it('is for the App only', async () => {
		expect((await lookup('+14155550000', false)).status).toBe(401)
	})

	it('reads Twilio Lookup v2 with a faked provider', async () => {
		vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123')
		const fetchImpl = vi.fn(async () =>
			Response.json({
				valid: true,
				line_type_intelligence: {
					type: 'landline',
					carrier_name: 'Acme Telecom',
				},
			}),
		) as unknown as typeof fetch
		expect(await lookupNumber('+14155550000', fetchImpl)).toEqual({
			valid: true,
			lineType: 'landline',
			carrier: 'Acme Telecom',
		})
		const notFound = vi.fn(
			async () => new Response('', { status: 404 }),
		) as unknown as typeof fetch
		expect(await lookupNumber('+14155550001', notFound)).toEqual({
			valid: false,
			lineType: 'unknown',
			carrier: null,
		})
		const down = vi.fn(async () => {
			throw new Error('network')
		}) as unknown as typeof fetch
		expect(await lookupNumber('+14155550001', down)).toBeNull()
		expect(mockLookup('+1415555aaaa').valid).toBe(true)
	})
})
