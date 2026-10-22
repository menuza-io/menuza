import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from './db.ts'
import { usePos } from './store.ts'

const unitRow = {
	key: 'zatca:unit',
	value: {
		environment: 'sandbox',
		privateKeyHex: 'a'.repeat(64),
		certificate: 'cert',
		seller: {},
	},
}

beforeEach(async () => {
	await db.meta.clear()
	await db.orders.clear()
	await db.meta.put(unitRow)
	await db.meta.put({ key: 'zatca:pih', value: 'P'.repeat(43) + '=' })
	usePos.setState({
		settings: {
			...usePos.getState().settings,
			appUrl: 'https://app.example.com',
			slug: 'demo',
			tenantApiUrl: 'https://api.example.com',
			deviceToken: 'pdv1.secret',
			demo: false,
		},
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('a terminal that stops being this restaurant’s', () => {
	it('unpairing forgets the ZATCA signing key and chain hash', async () => {
		usePos.getState().unpair()
		await settled()
		expect(await db.meta.get('zatca:unit')).toBeUndefined()
		expect(await db.meta.get('zatca:pih')).toBeUndefined()
		expect(usePos.getState().settings.deviceToken).toBeNull()
	})

	it('the server saying it was removed forgets them too', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'device_revoked' }), {
					status: 401,
				}),
			),
		)
		await usePos.getState().verifyPairing()
		expect(usePos.getState().pairingLost).toBe(true)
		expect(await db.meta.get('zatca:unit')).toBeUndefined()
	})
})

describe('pairing from a link', () => {
	it('refuses a link to a server that is not https before contacting it', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		const code = `ppc1.org_1.${'a'.repeat(43)}`
		const problem = await usePos
			.getState()
			.pair(
				`https://pos.example.com/#a=${encodeURIComponent('http://evil.example.net')}&c=${code}`,
			)
		expect(problem).toMatch(/secure \(https\)/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(usePos.getState().settings.tenantApiUrl).toBe(
			'https://api.example.com',
		)
	})
})

describe('taking over another terminal’s tab', () => {
	it('refuses a tab with no tax rate before claiming it', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		const problem = await usePos.getState().takeOverTab({
			terminal: { code: 'T2', label: 'Bar' },
			order: { id: 'o1', revision: 2, taxRatePercent: null } as never,
		})
		expect(problem).toMatch(/no tax rate/)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
