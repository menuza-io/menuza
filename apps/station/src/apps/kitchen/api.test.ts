import { DEFAULT_KDS_CONFIG } from '@repo/common/kds'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKitchenApi } from './api.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

const settings = {
	tenantApiUrl: 'https://us.node.test/',
	deviceToken: 'pdv1.org.dev.secret',
} as PosSettings
const feed = {
	config: DEFAULT_KDS_CONFIG,
	configVersion: 0,
	tickets: [],
	serverNow: Date.now(),
	truncated: false,
}

afterEach(() => vi.useRealTimers())

describe('kitchen regional client', () => {
	it('calls the regional API directly with device and staff credentials, without cookies or caching', async () => {
		const fetchImpl = vi.fn(async () => Response.json(feed))
		const session = { serverSession: { token: 'staff-token' } } as Session
		await expect(
			createKitchenApi(settings, session, fetchImpl).feed(),
		).resolves.toEqual(feed)
		expect(fetchImpl).toHaveBeenCalledWith(
			'https://us.node.test/pos/kds',
			expect.objectContaining({
				cache: 'no-store',
				credentials: 'omit',
				headers: {
					Authorization: `Bearer ${settings.deviceToken}`,
					'Pos-Staff-Session': 'staff-token',
				},
			}),
		)
	})

	it('refuses an unpaired screen before sending a request', async () => {
		const fetchImpl = vi.fn()
		await expect(
			createKitchenApi(
				{ ...settings, deviceToken: null },
				null,
				fetchImpl,
			).feed(),
		).rejects.toMatchObject({ code: 'invalid_device', status: 401 })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses malformed feeds and preserves stale-write errors', async () => {
		await expect(
			createKitchenApi(settings, null, async () => Response.json({})).feed(),
		).rejects.toMatchObject({ code: 'invalid_response' })
		await expect(
			createKitchenApi(settings, null, async () =>
				Response.json({ error: 'stale_ticket' }, { status: 409 }),
			).feed(),
		).rejects.toMatchObject({ code: 'stale_ticket', status: 409 })
	})

	it('aborts slow calls without requiring AbortSignal.timeout and never retries a write', async () => {
		vi.useFakeTimers()
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener('abort', () =>
						reject(new Error('aborted')),
					),
				),
		)
		const result = createKitchenApi(settings, null, fetchImpl)
			.configure(0, DEFAULT_KDS_CONFIG)
			.catch((failure: unknown) => failure)
		await vi.advanceTimersByTimeAsync(8_000)
		expect(await result).toMatchObject({ code: 'connection_lost' })
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})
