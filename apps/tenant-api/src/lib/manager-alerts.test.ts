import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ManagerAlertEvent } from '@repo/staffing'
import { sendManagerAlert } from './manager-alerts.ts'

const event: ManagerAlertEvent = {
	orgId: 'clw9x0a12000008l00staffa',
	eventId: 'a'.repeat(32),
	kind: 'no_clock_in',
	scopeId: 'loc-1',
	count: 2,
}

describe('sending a manager alert to the App', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
		vi.stubEnv('APP_URL', 'https://app.example.test/')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'x'.repeat(32))
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
	})

	it('posts the event, authenticated, and nothing else', async () => {
		fetchMock.mockResolvedValue(Response.json({ inApp: 2, emailed: 1 }))
		const outcome = await sendManagerAlert(event)
		expect(outcome).toEqual({
			status: 'delivered',
			result: { inApp: 2, emailed: 1 },
		})
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://app.example.test/resources/staffing/notify')
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe(`Bearer ${'x'.repeat(32)}`)
		expect(init.redirect).toBe('error')
		expect(JSON.parse(init.body)).toEqual(event)
	})

	it('refuses to send an event that carries more than the contract allows', async () => {
		const leaky = {
			...event,
			staffId: 'staff-1',
			name: 'Rana',
		} as unknown as ManagerAlertEvent
		expect(await sendManagerAlert(leaky)).toEqual({
			status: 'rejected',
			code: 'invalid_event',
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		[500, 'retry'],
		[503, 'retry'],
		[429, 'retry'],
		[401, 'retry'],
		[400, 'rejected'],
		[403, 'rejected'],
		[404, 'rejected'],
	])('treats HTTP %i as %s', async (status, expected) => {
		fetchMock.mockResolvedValue(new Response('no', { status }))
		const outcome = await sendManagerAlert(event)
		expect(outcome).toEqual({ status: expected, code: `http_${status}` })
	})

	it('retries when the network fails or nothing is configured', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNRESET'))
		expect(await sendManagerAlert(event)).toEqual({
			status: 'retry',
			code: 'network_error',
		})
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', '')
		expect(await sendManagerAlert(event)).toEqual({
			status: 'retry',
			code: 'not_configured',
		})
	})

	it('counts a 200 as delivered even when the body is unfamiliar', async () => {
		fetchMock.mockResolvedValue(new Response('ok'))
		expect(await sendManagerAlert(event)).toEqual({
			status: 'delivered',
			result: { inApp: 0, emailed: 0 },
		})
	})
})
