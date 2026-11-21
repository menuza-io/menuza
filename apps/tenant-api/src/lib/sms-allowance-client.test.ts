import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The setup file mocks this module for every suite; this one tests the real thing.
const { postSmsAllowance } = await vi.importActual<
	typeof import('./sms-allowance-client.ts')
>('./sms-allowance-client.ts')

const event = { orgId: 'org_1', campaignId: 'camp_1', action: 'start' as const }

describe('postSmsAllowance (#247)', () => {
	beforeEach(() => {
		process.env.APP_URL = 'https://app.example.test'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-command-token'
	})
	afterEach(() => vi.unstubAllGlobals())

	it('posts ids only, with the internal token, and reads the answer', async () => {
		const fetchMock = vi.fn(async () => Response.json({ ok: true }))
		vi.stubGlobal('fetch', fetchMock)
		expect(await postSmsAllowance(event)).toEqual({ ok: true })
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe(
			'https://app.example.test/resources/marketing/sms-allowance',
		)
		expect(JSON.parse(String(init.body))).toEqual(event)
		expect((init.headers as Record<string, string>).Authorization).toBe(
			'Bearer test-internal-command-token',
		)
	})

	it('reads "none left until" with the reset instant', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					ok: false,
					reason: 'exhausted',
					resetsAt: 1796083200000,
				}),
			),
		)
		expect(await postSmsAllowance(event)).toEqual({
			ok: false,
			reason: 'exhausted',
			resetsAt: 1796083200000,
		})
	})

	it('is unavailable on an error, a bad answer or a network failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 503 })),
		)
		expect(await postSmsAllowance(event)).toEqual({ ok: 'unavailable' })
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ surprise: 1 })),
		)
		expect(await postSmsAllowance(event)).toEqual({ ok: 'unavailable' })
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline')
			}),
		)
		expect(await postSmsAllowance(event)).toEqual({ ok: 'unavailable' })
	})

	it('refuses an event with an extra field before any request', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect(
			await postSmsAllowance({ ...event, phone: '+15550001111' } as never),
		).toEqual({ ok: 'unavailable' })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
