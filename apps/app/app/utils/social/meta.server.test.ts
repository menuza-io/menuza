import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SocialError } from './errors.ts'
import { exchangeMetaCode } from './meta.server.ts'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
	vi.stubEnv('SOCIAL_MOCK', '')
	vi.stubEnv('META_APP_ID', 'app-id')
	vi.stubEnv('META_APP_SECRET', 'app-secret')
	vi.stubEnv('BASE_URL', 'https://app.example.com')
	vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
	fetchMock.mockReset()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('Meta Graph requests', () => {
	it('never follows a redirect and reports Meta as unavailable', async () => {
		let cancelled = false
		fetchMock.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true
					},
				}),
				{ status: 302, headers: { Location: 'http://169.254.169.254/' } },
			),
		)

		await expect(exchangeMetaCode('code')).rejects.toMatchObject({
			name: SocialError.name,
			code: 'unavailable',
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
		expect(cancelled).toBe(true)
	})

	it('exchanges the code over two Graph calls', async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({ access_token: 'short' }))
			.mockResolvedValueOnce(Response.json({ access_token: 'long' }))

		await expect(exchangeMetaCode('code')).resolves.toBe('long')
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})
