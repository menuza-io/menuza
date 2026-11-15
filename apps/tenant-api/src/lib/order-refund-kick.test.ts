import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	kickOrderRefundExecute,
	orderRefundKicksIdle,
	postOrderRefundExecute,
	setOrderRefundKickForTest,
} from './order-refund-kick.ts'

const TOKEN = 'test-internal-token-for-refund-kick-123456'

afterEach(() => {
	setOrderRefundKickForTest(null)
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('postOrderRefundExecute', () => {
	it('posts ids only to the App with the internal token', async () => {
		vi.stubEnv('APP_URL', 'https://app.test/')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
		const fetchMock = vi.fn(async () => Response.json({ ok: true }))
		vi.stubGlobal('fetch', fetchMock)
		expect(
			await postOrderRefundExecute({ orgId: 'org_1', refundId: 'rf_1' }),
		).toEqual({ status: 'sent' })
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://app.test/resources/orders/refund-execute')
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${TOKEN}`,
		)
		expect(JSON.parse(init.body as string)).toEqual({
			orgId: 'org_1',
			refundId: 'rf_1',
		})
	})

	it('reports what failed without throwing', async () => {
		vi.stubEnv('APP_URL', '')
		vi.stubEnv('BASE_URL', '')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', TOKEN)
		expect(
			await postOrderRefundExecute({ orgId: 'org_1', refundId: 'rf_1' }),
		).toEqual({ status: 'failed', code: 'not_configured' })

		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 503 })),
		)
		expect(
			await postOrderRefundExecute({ orgId: 'org_1', refundId: 'rf_1' }),
		).toEqual({ status: 'failed', code: 'http_503' })

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline')
			}),
		)
		expect(
			await postOrderRefundExecute({ orgId: 'org_1', refundId: 'rf_1' }),
		).toEqual({ status: 'failed', code: 'network_error' })
		expect(
			await postOrderRefundExecute({ orgId: 'org_1', refundId: '' }),
		).toEqual({ status: 'failed', code: 'invalid_request' })
	})
})

describe('kickOrderRefundExecute', () => {
	it('never throws, even when the poster does, and logs ids only', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		setOrderRefundKickForTest(async () => {
			throw new Error('boom with secret details')
		})
		expect(() => kickOrderRefundExecute('org_1', ['rf_1'])).not.toThrow()
		await orderRefundKicksIdle()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret details')
		expect(JSON.stringify(warn.mock.calls)).toContain('rf_1')
	})
})
