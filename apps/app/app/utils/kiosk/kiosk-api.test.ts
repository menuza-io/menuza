import { describe, expect, it, vi } from 'vitest'
import {
	createKioskApi,
	KioskApiError,
	KioskNetworkError,
} from './kiosk-api.ts'

const SECRET = `kdv1.org_1.device01.${'a'.repeat(43)}`
const URL_BASE = 'https://us.tenant.test/'

function api(fetchImpl: typeof fetch, timeoutMs?: number) {
	return createKioskApi({
		tenantApiUrl: URL_BASE,
		deviceSecret: SECRET,
		fetchImpl,
		timeoutMs,
	})
}

describe('kiosk api', () => {
	it('sends the device secret only as a bearer header, to the kiosk path', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({
				firstName: 'Rana',
				state: 'out',
				allowedEvents: ['clock_in'],
				positions: [],
				nextShifts: [],
				serverNow: 1,
			}),
		)
		const result = await api(fetchImpl as never).identify('4821')
		expect(result).toMatchObject({ firstName: 'Rana', promptTips: false })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://us.tenant.test/kiosk/identify')
		expect(new Headers(init.headers).get('Authorization')).toBe(
			`Bearer ${SECRET}`,
		)
		expect(init.body).toBe(JSON.stringify({ pin: '4821' }))
		expect(url).not.toContain(SECRET)
		expect(init.cache).toBe('no-store')
	})

	it('pairs without a device secret, using the code as the credential', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json(
				{
					deviceSecret: SECRET,
					device: {
						id: 'd1',
						name: 'Front',
						scopeId: 'loc-1',
						identifyMode: 'pin',
						showNextShifts: false,
					},
					scope: { name: 'Downtown', timeZone: 'America/Chicago' },
					serverNow: 1,
				},
				{ status: 201 },
			),
		)
		const pairing = createKioskApi({
			tenantApiUrl: URL_BASE,
			fetchImpl: fetchImpl as never,
		})
		const paired = await pairing.pair('kpc1.org_1.' + 'b'.repeat(43))
		expect(paired.deviceSecret).toBe(SECRET)
		const init = (
			fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		)[1]
		expect(new Headers(init.headers).get('Authorization')).toBeNull()
	})

	it('turns a refusal into a typed error with the retry delay', async () => {
		const fetchImpl = async () =>
			Response.json(
				{ error: 'invalid_pin', retryAfterSeconds: 30 },
				{ status: 401, headers: { 'Retry-After': '30' } },
			)
		const error = await api(fetchImpl as never)
			.identify('0000')
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(KioskApiError)
		expect(error).toMatchObject({
			status: 401,
			code: 'invalid_pin',
			retryAfterSeconds: 30,
			transient: false,
			deviceGone: false,
		})
	})

	it('falls back to the Retry-After header', async () => {
		const fetchImpl = async () =>
			Response.json(
				{ error: 'backoff' },
				{ status: 429, headers: { 'Retry-After': '90' } },
			)
		const error = (await api(fetchImpl as never)
			.identify('0000')
			.catch((e: unknown) => e)) as KioskApiError
		expect(error.retryAfterSeconds).toBe(90)
		expect(error.transient).toBe(true)
	})

	it('knows when the device itself is gone', async () => {
		for (const code of ['device_revoked', 'invalid_device']) {
			const fetchImpl = async () =>
				Response.json({ error: code }, { status: 401 })
			const error = (await api(fetchImpl as never)
				.config()
				.catch((e: unknown) => e)) as KioskApiError
			expect(error.deviceGone).toBe(true)
			expect(error.certainlyRevoked).toBe(code === 'device_revoked')
		}
	})

	it('does not treat the kill switch as the device being gone', async () => {
		const fetchImpl = async () =>
			Response.json({ error: 'kiosk_disabled' }, { status: 503 })
		const error = (await api(fetchImpl as never)
			.config()
			.catch((e: unknown) => e)) as KioskApiError
		expect(error.deviceGone).toBe(false)
		expect(error.paused).toBe(true)
	})

	it('treats a thrown fetch as being offline', async () => {
		const fetchImpl = async () => {
			throw new TypeError('Failed to fetch')
		}
		await expect(api(fetchImpl as never).config()).rejects.toBeInstanceOf(
			KioskNetworkError,
		)
	})

	it('treats a hung request as being offline', async () => {
		const fetchImpl = (_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () =>
					reject(new DOMException('x', 'AbortError')),
				)
			})
		await expect(api(fetchImpl as never, 20).config()).rejects.toBeInstanceOf(
			KioskNetworkError,
		)
	})

	it('does not mistake a proxy error page for an answer', async () => {
		const fetchImpl = async () =>
			new Response('<html>Bad gateway</html>', { status: 200 })
		const error = (await api(fetchImpl as never)
			.config()
			.catch((e: unknown) => e)) as KioskApiError
		expect(error).toBeInstanceOf(KioskApiError)
		expect(error.transient).toBe(true)
	})

	it('treats server errors as worth retrying', async () => {
		const fetchImpl = async () =>
			Response.json({ error: 'Internal Server Error' }, { status: 500 })
		const error = (await api(fetchImpl as never)
			.config()
			.catch((e: unknown) => e)) as KioskApiError
		expect(error.transient).toBe(true)
	})
})
