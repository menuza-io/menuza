import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendSms = vi.hoisted(() => vi.fn())
vi.mock('@repo/sms', () => ({ sendSms }))

import { resetRateLimits } from '../lib/rate-limit.ts'
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
		expect(sendSms).toHaveBeenCalledWith(
			expect.objectContaining({ to: '+14155550100', message: TEXT }),
		)
	})

	it('answers with the provider message id so the App can log the delivery (#246)', async () => {
		sendSms.mockResolvedValue({
			success: true,
			sid: 'SM1234567890abcdef',
			mock: false,
		})
		const response = await send({
			orgId: 'org_1',
			to: '+14155550100',
			text: TEXT,
		})
		expect(await response.json()).toEqual({
			sent: true,
			sid: 'SM1234567890abcdef',
		})
	})

	it('caps texts to one number and for one organization, so neither can be flooded', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		resetRateLimits()
		try {
			let refused = 0
			for (let i = 0; i < 31; i++) {
				const response = await send({
					orgId: 'org_flood',
					to: '+14155550142',
					text: TEXT,
				})
				if (response.status === 429) refused++
			}
			expect(refused).toBe(1)
			expect(sendSms).toHaveBeenCalledTimes(30)
			// Another number is still fine; the org cap is 600 an hour.
			const other = await send({
				orgId: 'org_flood',
				to: '+14155550143',
				text: TEXT,
			})
			expect(other.status).toBe(200)
		} finally {
			resetRateLimits()
		}
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
