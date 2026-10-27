import { describe, expect, it, vi } from 'vitest'
import {
	clearTableSession,
	loadTableSession,
	readTableContext,
	readTableFragment,
	saveTableSession,
	stripTableFragment,
	submitTableRound,
	tableHeaders,
	takeStashedTableScan,
	type TableSession,
} from './table-session.ts'

const token = `tbl-1.2.${'a'.repeat(64)}`
const tabToken = `tab-1.1.${'b'.repeat(64)}`

function storage() {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		values,
	}
}

function session(overrides: Partial<TableSession> = {}): TableSession {
	return {
		orgId: 'org-1',
		locationId: 'loc-1',
		tableToken: token,
		tableLabel: 'T4',
		tabId: null,
		tabToken: null,
		tabNumber: null,
		policy: {
			requireGuestName: false,
			requireGuestPhone: false,
			onlineTabPayAvailable: false,
		},
		savedAt: Date.now(),
		...overrides,
	}
}

describe('table codes in the fragment', () => {
	it('reads a well-formed code and ignores anything else', () => {
		expect(
			readTableFragment(`https://x.example/menu?location=l#table=${token}`),
		).toBe(token)
		expect(readTableFragment('https://x.example/menu#table=nope')).toBeNull()
		expect(
			readTableFragment('https://x.example/menu?table=' + token),
		).toBeNull()
	})

	it('takes a code the head script stashed, once and only while fresh', () => {
		const store = storage()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: token, at: 1000 }))
		expect(takeStashedTableScan(store, 2000)).toBe(token)
		expect(takeStashedTableScan(store, 2000)).toBeNull()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: token, at: 1000 }))
		expect(takeStashedTableScan(store, 1000 + 6 * 60_000)).toBeNull()
		store.setItem('menuza_qr_scan', JSON.stringify({ code: 'nope', at: 1000 }))
		expect(takeStashedTableScan(store, 2000)).toBeNull()
	})

	it('strips only the table code from the address', () => {
		expect(
			stripTableFragment(`https://x.example/menu?location=l#table=${token}`),
		).toBe('https://x.example/menu?location=l')
		expect(
			stripTableFragment(`https://x.example/menu#table=${token}&item=abc`),
		).toBe('https://x.example/menu#item=abc')
	})
})

describe('table sessions', () => {
	it('round-trips, expires and refuses tampered data', () => {
		const store = storage()
		vi.stubGlobal('localStorage', store)
		saveTableSession(session({ tabToken, tabId: 'tab-1', tabNumber: '007' }))
		expect(loadTableSession('org-1')?.tabNumber).toBe('007')
		expect(loadTableSession('org-2')).toBeNull()
		expect(loadTableSession('org-1', Date.now() + 13 * 3_600_000)).toBeNull()
		store.setItem(
			'menuza_qr_tab_org-1',
			JSON.stringify({ ...session(), tableToken: 'x' }),
		)
		expect(loadTableSession('org-1')).toBeNull()
		clearTableSession('org-1')
		vi.unstubAllGlobals()
	})

	it('sends the tab token once there is a tab, else the table token', () => {
		expect(tableHeaders(session())).toEqual({ 'X-Table-Token': token })
		expect(tableHeaders(session({ tabToken }))).toEqual({
			'X-Tab-Token': tabToken,
		})
	})

	it('validates the table context', () => {
		expect(readTableContext({ table: {}, dineIn: {} })).toBeNull()
		expect(
			readTableContext({
				table: { label: 'T4', locationId: 'loc-1' },
				dineIn: {
					enabled: true,
					requireGuestName: true,
					requireGuestPhone: false,
					onlineTabPayAvailable: false,
				},
				openTab: null,
			})?.dineIn.requireGuestName,
		).toBe(true)
	})

	it('posts rounds with the capability header and never a price', async () => {
		vi.stubGlobal('document', {
			documentElement: {
				dataset: { tenantApiUrl: 'https://regional.example/', orgSlug: 'cafe' },
			},
		})
		const fetchMock = vi.fn(async () =>
			Response.json(
				{
					order: {
						id: 'o1',
						number: '1',
						status: 'accepted',
						paymentStatus: 'unpaid',
						currency: 'USD',
						subtotalCents: 800,
						taxCents: 0,
						deliveryFeeCents: 0,
						tipCents: 0,
						totalCents: 800,
						holdExpiresAt: null,
					},
					receiptToken: 'r'.repeat(64),
					tab: { id: 'tab-1', tabNumber: '001', tabToken },
				},
				{ status: 201 },
			),
		)
		vi.stubGlobal('fetch', fetchMock)
		const created = await submitTableRound(session(), {
			fulfillment: 'dine_in',
		})
		expect(created.tab.tabNumber).toBe('001')
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://regional.example/orders')
		expect((init.headers as Record<string, string>)['X-Table-Token']).toBe(
			token,
		)
		expect(JSON.parse(String(init.body))).toEqual({
			fulfillment: 'dine_in',
			slug: 'cafe',
		})
		vi.unstubAllGlobals()
	})
})
