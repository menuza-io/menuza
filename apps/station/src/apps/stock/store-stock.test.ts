// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stockOrigin } from './local.ts'
import { logWaste, stockRows } from './queue.ts'
import { ctx, ORIGIN, resetStock, session, settings } from './testing.ts'
import { shownApp } from '~/lib/config.ts'
import { usePos } from '~/lib/store.ts'

/** Stock inside the till's own shell: when it is offered, what its queue does when the restaurant changes, and the till's sync sending it. */

beforeEach(async () => {
	await resetStock()
	usePos.setState({
		settings: { ...settings, demo: false },
		session: null,
		online: true,
	})
})
afterEach(() => vi.unstubAllGlobals())

const waste = () =>
	logWaste(ctx, {
		itemId: 'item_tomato',
		amount: 1,
		unit: 'kg',
		reason: 'spoiled',
	})

describe('Stock is an app of the terminal', () => {
	it('shows only when the terminal offers it, and falls back to the till when it stops', () => {
		const base = { signInRequired: true, activeApp: 'stock' as const }
		expect(
			shownApp({
				...base,
				apps: { timeclock: false, reservations: false, inventory: true },
			}),
		).toBe('stock')
		expect(
			shownApp({
				...base,
				apps: { timeclock: false, reservations: false, inventory: false },
			}),
		).toBe('pos')
		// The other apps are unchanged.
		expect(
			shownApp({
				...base,
				activeApp: 'kitchen',
				apps: { timeclock: false, reservations: false, inventory: false },
			}),
		).toBe('kitchen')
	})

	it('learns from the server that a manager switched it on or off', async () => {
		const answer = (inventory: boolean) =>
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(
					Response.json({
						device: { signInRequired: true, scopeId: 'main' },
						apps: { timeclock: false, reservations: false, inventory },
					}),
				),
			)
		usePos.setState({
			settings: {
				...usePos.getState().settings,
				apps: { timeclock: false, reservations: false, inventory: false },
			},
		})
		answer(true)
		await usePos.getState().verifyPairing()
		expect(usePos.getState().settings.apps.inventory).toBe(true)
		answer(false)
		await usePos.getState().verifyPairing()
		expect(usePos.getState().settings.apps.inventory).toBe(false)
	})

	it('demo mode offers it with a sample kitchen, and leaving demo takes it away', async () => {
		await usePos.getState().updateSettings({ demo: true })
		expect(usePos.getState().settings.apps.inventory).toBe(true)
		expect(stockOrigin(usePos.getState().settings)).toBe('demo')
		await usePos.getState().updateSettings({ demo: false })
		expect(usePos.getState().settings.apps.inventory).toBe(false)
	})
})

describe('what waits for a restaurant', () => {
	it('is thrown away when this tablet is set up for another one, never sent to it', async () => {
		await waste()
		expect(await stockRows(ORIGIN)).toHaveLength(1)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})))
		await usePos.getState().updateSettings({ slug: 'another-restaurant' })
		expect(await stockRows(ORIGIN)).toEqual([])
		expect(await stockRows(stockOrigin(usePos.getState().settings))).toEqual([])
	})

	it('stays through a change that does not move restaurants', async () => {
		await waste()
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})))
		await usePos.getState().updateSettings({ terminalCode: 'T9' })
		expect(await stockRows(ORIGIN)).toHaveLength(1)
	})
})

describe('the till’s own sync', () => {
	it('sends Stock’s waiting entries for whoever is signed in, with their session', async () => {
		await waste()
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, _init?: RequestInit) =>
				String(input).endsWith('/pos/inventory/waste')
					? Response.json({
							accepted: [
								{
									clientId: (await stockRows(ORIGIN))[0]!.id,
									id: 'wst_1',
									quantity: 1,
								},
							],
							duplicates: [],
							refused: [],
							lateSync: [],
						})
					: Response.json({}),
		)
		vi.stubGlobal('fetch', fetchImpl)
		usePos.setState({ session: session() })
		await usePos.getState().sync()
		const calls = fetchImpl.mock.calls.filter(([url]) =>
			String(url).includes('/pos/inventory/'),
		)
		expect(calls).toHaveLength(1)
		expect(
			new Headers((calls[0]![1] as RequestInit).headers).get(
				'Pos-Staff-Session',
			),
		).toBe('staff-session-token-aaaaaaaa')
		expect(await stockRows(ORIGIN)).toEqual([])
	})

	it('waits while the till is locked: nothing is sent without a person, nothing is lost', async () => {
		await waste()
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({}),
		)
		vi.stubGlobal('fetch', fetchImpl)
		usePos.setState({ session: null })
		await usePos.getState().sync()
		expect(
			fetchImpl.mock.calls.filter(([url]) =>
				String(url).includes('/pos/inventory/'),
			),
		).toEqual([])
		expect(await stockRows(ORIGIN)).toHaveLength(1)
	})

	it('does not send for a terminal that does not offer Stock', async () => {
		await waste()
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				Response.json({}),
		)
		vi.stubGlobal('fetch', fetchImpl)
		usePos.setState({
			session: session(),
			settings: {
				...usePos.getState().settings,
				apps: { timeclock: false, reservations: false, inventory: false },
			},
		})
		await usePos.getState().sync()
		expect(
			fetchImpl.mock.calls.filter(([url]) =>
				String(url).includes('/pos/inventory/'),
			),
		).toEqual([])
		expect(await stockRows(ORIGIN)).toHaveLength(1)
	})
})
