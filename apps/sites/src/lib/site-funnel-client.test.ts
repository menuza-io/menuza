import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	armFor,
	countStep,
	rememberAssignment,
	stepsForPath,
} from './site-funnel-client'

function memoryStorage(): Storage {
	const data = new Map<string, string>()
	return {
		get length() {
			return data.size
		},
		clear: () => data.clear(),
		getItem: (key) => data.get(key) ?? null,
		key: (index) => [...data.keys()][index] ?? null,
		removeItem: (key) => void data.delete(key),
		setItem: (key, value) => void data.set(key, String(value)),
	}
}

const context = { tenantApiUrl: 'https://api.test', orgSlug: 'acme' }

describe('funnel steps by page (#179)', () => {
	it('maps the ordering pages to their step', () => {
		expect(stepsForPath('/menu')).toEqual(['menu_view'])
		expect(stepsForPath('/ar/menu')).toEqual(['menu_view'])
		expect(stepsForPath('/menu/margherita')).toEqual(['menu_view'])
		expect(stepsForPath('/menu/checkout')).toEqual(['checkout'])
		expect(stepsForPath('/menu/success')).toEqual(['order'])
		expect(stepsForPath('/')).toEqual([])
		expect(stepsForPath('/about')).toEqual([])
	})
})

describe('beacons (#179, #338)', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.stubGlobal('localStorage', memoryStorage())
		vi.stubGlobal('sessionStorage', memoryStorage())
		vi.stubGlobal('window', { innerWidth: 390 })
		vi.stubGlobal('location', { search: '?src=qr_table', pathname: '/menu' })
		fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	const sent = () =>
		fetchMock.mock.calls.map(
			(call) =>
				JSON.parse(String((call[1] as RequestInit).body)) as Record<
					string,
					unknown
				>,
		)

	it('sends a step once per session, with only counts', () => {
		countStep(context, 'visit')
		countStep(context, 'visit')
		countStep(context, 'menu_view')
		const bodies = sent()
		expect(bodies).toHaveLength(2)
		expect(bodies[0]).toEqual({
			slug: 'acme',
			event: 'visit',
			device: 'phone',
			entry: 'qr_table',
		})
		// Nothing that names a person or a browser.
		for (const body of bodies) {
			expect(Object.keys(body).sort()).toEqual(
				['device', 'entry', 'event', 'slug'].sort(),
			)
		}
		expect((fetchMock.mock.calls[0]![1] as RequestInit).credentials).toBe(
			'omit',
		)
		expect(fetchMock.mock.calls[0]![0]).toBe(
			'https://api.test/forms/site-events',
		)
	})

	it('credits a later step to the entry the session started with', () => {
		countStep(context, 'visit')
		vi.stubGlobal('location', {
			search: '?order=abc',
			pathname: '/menu/success',
		})
		countStep(context, 'order', 'order:abc')
		expect(sent().map((b) => b.entry)).toEqual(['qr_table', 'qr_table'])
	})

	it('counts a step again for each test arm the visitor is in', () => {
		rememberAssignment('exp1', 'b')
		countStep(context, 'visit')
		const bodies = sent()
		expect(bodies.map((b) => b.variant)).toEqual([undefined, 'exp1:b'])
	})

	it('counts one order per confirmation, not per reload', () => {
		countStep(context, 'order', 'order:abc')
		countStep(context, 'order', 'order:abc')
		countStep(context, 'order', 'order:def')
		expect(sent()).toHaveLength(2)
	})

	it('keeps a returning visitor in the same arm and splits new visitors', () => {
		const first = armFor('exp1')
		for (let i = 0; i < 20; i++) expect(armFor('exp1')).toBe(first)
		// A junk value is replaced by a fresh assignment.
		localStorage.setItem('menuza:exp:exp2', 'zzz')
		expect(['a', 'b']).toContain(armFor('exp2'))
		const arms = new Set<string>()
		for (let i = 0; i < 40; i++) {
			localStorage.clear()
			arms.add(armFor('exp1'))
		}
		expect(arms).toEqual(new Set(['a', 'b']))
	})
})
