import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendSms = vi.hoisted(() => vi.fn())
vi.mock('@repo/sms', () => ({ sendSms }))

import { alertTextRoutes } from './alert-texts.ts'

const TOKEN = 'test-internal-token-very-long-12345'
const app = new Hono().route('/api/alert-texts', alertTextRoutes)
const TEXT =
	'New order W-0042. Pickup 6:45 PM · $38.50\nhttps://app.example.test/acme/orders\nReply STOP to opt out.'

function send(body: unknown, headers: Record<string, string> = {}) {
	return app.request('/api/alert-texts', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: `Bearer ${TOKEN}`,
			...headers,
		},
		body: JSON.stringify(body),
	})
}

describe('POST /api/alert-texts (#241)', () => {
	beforeEach(() => {
		sendSms.mockReset().mockResolvedValue({ success: true, mock: true })
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('ORDER_ALERT_SMS_ENABLED', '')
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('sends the text to a US number for the App', async () => {
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
		})
		expect(response.status).toBe(200)
		expect(sendSms).toHaveBeenCalledWith({ to: '+14155550100', message: TEXT })
	})

	it('refuses a caller without the internal token', async () => {
		const response = await send(
			{ orgId: 'org_1', to: '+14155550100', text: TEXT },
			{ Authorization: 'Bearer wrong-token-wrong-token-wrong' },
		)
		expect(response.status).toBe(401)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it('is not available on the Saudi node', async () => {
		vi.stubEnv('DATA_REGION', 'ksa')
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
		})
		expect(response.status).toBe(409)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it('drops texts while ORDER_ALERT_SMS_ENABLED=false', async () => {
		vi.stubEnv('ORDER_ALERT_SMS_ENABLED', 'false')
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
		})
		expect(response.status).toBe(503)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it.each([
		['a number outside the US and Canada', { to: '+966501234567' }],
		['a Caribbean +1 number', { to: '+18095550100' }],
		['a text with no opt-out phrase', { text: 'New order W-1' }],
		['an extra field', { name: 'Layla' }],
		['an empty text', { text: '' }],
	])('refuses %s', async (_name, patch) => {
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
			...patch,
		})
		expect(response.status).toBe(400)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it('answers 502 without echoing the number or the text when the provider fails', async () => {
		sendSms.mockRejectedValue(new Error('Twilio said +14155550100 was bad'))
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
		})
		expect(response.status).toBe(502)
		const body = await response.text()
		expect(body).not.toContain('+14155550100')
		expect(body).not.toContain('W-0042')
	})
})
