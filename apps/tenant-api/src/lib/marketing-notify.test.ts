import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postMarketingNotify } from './marketing-notify.ts'

const event = {
	orgId: 'org-1',
	kind: 'broadcast_skipped_late' as const,
	campaignId: 'camp-1',
}

describe('postMarketingNotify', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		process.env.APP_URL = 'https://app.example.test/'
		process.env.INTERNAL_COMMAND_TOKEN = 'internal-command-token-0123456789'
		fetchMock.mockReset()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('posts the ids to the App with the internal token and nothing else', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('{"inApp":1}', { status: 200 }),
		)
		expect(await postMarketingNotify(event)).toEqual({ status: 'delivered' })

		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://app.example.test/resources/marketing/notify')
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe(
			'Bearer internal-command-token-0123456789',
		)
		expect(JSON.parse(init.body)).toEqual(event)
		// A redirect from the App is an error, never followed with the token.
		expect(init.redirect).toBe('error')
	})

	it('refuses to send a field the contract does not allow', async () => {
		const result = await postMarketingNotify({
			...event,
			name: 'Secret promo',
		} as never)
		expect(result).toEqual({ status: 'rejected', code: 'invalid_event' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		[401, 'retry'],
		[429, 'retry'],
		[503, 'retry'],
		[400, 'rejected'],
		[404, 'rejected'],
	])('treats an App answer of %i as %s', async (status, outcome) => {
		fetchMock.mockResolvedValueOnce(new Response('{}', { status }))
		expect(await postMarketingNotify(event)).toMatchObject({ status: outcome })
	})

	it('asks to retry when the network fails or the App is not configured, and never throws', async () => {
		fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
		expect(await postMarketingNotify(event)).toEqual({
			status: 'retry',
			code: 'network_error',
		})
		process.env.INTERNAL_COMMAND_TOKEN = 'short'
		expect(await postMarketingNotify(event)).toEqual({
			status: 'retry',
			code: 'not_configured',
		})
	})
})
