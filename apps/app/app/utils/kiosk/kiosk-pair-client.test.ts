import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairKiosk } from './kiosk-pair-client.ts'

const URLS = { us: 'https://us.tenant.test', ksa: 'https://ksa.tenant.test' }
const SECRET = `kdv1.org_1.device01.${'a'.repeat(43)}`
const CODE = `kpc1.org_1.${'b'.repeat(43)}`

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key),
})

function paired(status = 201) {
	return Response.json(
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
			serverNow: 5,
		},
		{ status },
	)
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	})
	store.clear()
})

describe('pairKiosk', () => {
	it('uses only the named region and stores the device on success', async () => {
		const fetchMock = vi.fn(async () => paired())
		vi.stubGlobal('fetch', fetchMock)
		const result = await pairKiosk(URLS, CODE, 'ksa')
		expect(result.ok).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
			'https://ksa.tenant.test/kiosk/pair',
		)
		expect(store.get('kiosk.device.v1')).toContain(SECRET)
	})

	it('tries both nodes for a bare code, stopping at the one that accepts it', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ error: 'invalid_pairing_code' }, { status: 401 }),
			)
			.mockResolvedValueOnce(paired())
		vi.stubGlobal('fetch', fetchMock)
		const result = await pairKiosk(URLS, CODE)
		expect(result.ok).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('does not keep guessing past a real refusal', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ error: 'kiosk_disabled' }, { status: 503 }),
		)
		vi.stubGlobal('fetch', fetchMock)
		const result = await pairKiosk(URLS, CODE)
		expect(result).toMatchObject({ ok: false, code: 'kiosk_disabled' })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('reports an unusable code once both nodes refused it, and stores nothing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ error: 'invalid_pairing_code' }, { status: 401 }),
			),
		)
		const result = await pairKiosk(URLS, CODE)
		expect(result).toMatchObject({ ok: false, code: 'invalid_pairing_code' })
		expect(store.size).toBe(0)
	})

	it('says so when the browser will not keep the pairing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => paired()),
		)
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => {
				throw new Error('blocked')
			},
			removeItem: () => undefined,
		})
		expect(await pairKiosk(URLS, CODE, 'us')).toMatchObject({
			ok: false,
			code: 'storage_unavailable',
		})
	})

	it('reports being offline instead of an invalid code', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch')
			}),
		)
		expect(await pairKiosk(URLS, CODE, 'us')).toMatchObject({
			ok: false,
			code: 'network_unavailable',
		})
	})
})
