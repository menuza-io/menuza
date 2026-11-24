import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	blockLock,
	holdLock,
	idleDecision,
	idleLockSecondsFor,
	lockBlocked,
	touch,
} from './activity.ts'
import { type PosSettings } from './config.ts'
import { db } from './db.ts'
import { createOrder, type OrderDraft } from './orders.ts'
import { flushOutbox } from './outbox.ts'
import { type CartLine } from './pricing.ts'
import { type Session } from './signin.ts'
import { usePos } from './store.ts'

/**
 * Sign Station staff out after inactivity (#364): off by default, set in
 * minutes per location, a warning for the last 10 seconds, never interrupting
 * a payment, never touching a kitchen display, and never dropping unsent work.
 */

const base = {
	signInRequired: true,
	signedIn: true,
	terminalSeconds: 120,
	locationMinutes: null as number | null,
	idleMs: 0,
}
const at = (seconds: number) => seconds * 1000

describe('the location timeout', () => {
	it('is off by default: with no timeout set anywhere nothing signs out', () => {
		const off = { ...base, terminalSeconds: 0, idleMs: at(86_400) }
		expect(idleDecision(off)).toEqual({ lock: false, warning: null })
		expect(
			idleLockSecondsFor({ terminalSeconds: 0, locationMinutes: null }),
		).toBe(0)
	})

	it('with 5 minutes, an idle till signs out at 5 minutes and not before', () => {
		const five = { ...base, locationMinutes: 5 }
		expect(idleDecision({ ...five, idleMs: at(299) }).lock).toBe(false)
		expect(idleDecision({ ...five, idleMs: at(300) }).lock).toBe(true)
		expect(idleDecision({ ...five, idleMs: at(3_000) }).lock).toBe(true)
	})

	it('replaces the till’s own timeout while it is on, and gives it back when off', () => {
		// The till alone would lock at 2 minutes.
		expect(idleDecision({ ...base, idleMs: at(120) }).lock).toBe(true)
		// The location says 5 minutes: 2 minutes is no longer enough.
		expect(
			idleDecision({ ...base, locationMinutes: 5, idleMs: at(120) }).lock,
		).toBe(false)
		expect(
			idleDecision({ ...base, locationMinutes: 0, idleMs: at(120) }).lock,
		).toBe(true)
	})

	it('never signs out a till that does not require sign-in, or one nobody is signed in to', () => {
		const five = { ...base, locationMinutes: 5, idleMs: at(3_000) }
		expect(idleDecision({ ...five, signInRequired: false }).lock).toBe(false)
		expect(idleDecision({ ...five, signedIn: false }).lock).toBe(false)
	})
})

describe('the warning', () => {
	it('shows for the last 10 seconds only, counting down', () => {
		const five = { ...base, locationMinutes: 5 }
		expect(idleDecision({ ...five, idleMs: at(289) }).warning).toBeNull()
		expect(idleDecision({ ...five, idleMs: at(290) }).warning).toBe(10)
		expect(idleDecision({ ...five, idleMs: at(295) }).warning).toBe(5)
		expect(idleDecision({ ...five, idleMs: at(299) }).warning).toBe(1)
		const out = idleDecision({ ...five, idleMs: at(300) })
		expect(out).toEqual({ lock: true, warning: null })
	})

	it('goes away when the person touches the screen', () => {
		const five = { ...base, locationMinutes: 5 }
		touch(1_000)
		// 295 seconds idle: warned.
		expect(idleDecision({ ...five, idleMs: at(295) }).warning).not.toBeNull()
		// A touch resets the clock: nothing to warn about a moment later.
		touch(296_000)
		expect(idleDecision({ ...five, idleMs: 500 })).toEqual({
			lock: false,
			warning: null,
		})
	})
})

describe('a payment in progress', () => {
	it('is never interrupted, however long it takes, and no warning shows', () => {
		const five = { ...base, locationMinutes: 5, idleMs: at(100_000) }
		expect(idleDecision({ ...five, blocked: true })).toEqual({
			lock: false,
			warning: null,
		})
		// The soft hold used by sheets still has its own floor; a payment has none.
		expect(idleDecision({ ...five, held: true }).lock).toBe(true)
	})

	it('blocks while the checkout sheet is open and counts idle time again after', () => {
		expect(lockBlocked()).toBe(false)
		const release = blockLock()
		const second = blockLock()
		expect(lockBlocked()).toBe(true)
		release()
		release()
		expect(lockBlocked()).toBe(true)
		second()
		expect(lockBlocked()).toBe(false)
	})

	it('a soft hold is not a payment block', () => {
		const release = holdLock()
		expect(lockBlocked()).toBe(false)
		release()
	})
})

describe('a kitchen display', () => {
	it('stays signed in', () => {
		const five = { ...base, locationMinutes: 5, idleMs: at(100_000) }
		expect(idleDecision({ ...five, exempt: true })).toEqual({
			lock: false,
			warning: null,
		})
	})
})

describe('unsent work', () => {
	const settings: PosSettings = {
		appUrl: 'https://app.test',
		slug: 'demo',
		tenantApiUrl: 'https://api.test',
		terminalCode: 'T1',
		locationId: 'loc-1',
		locationLocked: false,
		scopeId: 'main',
		signInRequired: true,
		dayStartMinutes: 0,
		shiftsRequired: false,
		idleLockSeconds: 120,
		deviceToken: 'device-secret',
		deviceLabel: 'Front counter',
		demo: false,
		locale: null,
		apps: {
			timeclock: false,
			reservations: false,
			inventory: false,
			orders: false,
		},
		activeApp: 'pos',
	}
	const line: CartLine = {
		id: 'l1',
		itemId: 'burger',
		name: 'Burger',
		variantId: null,
		variantLabel: null,
		quantity: 1,
		baseCents: 1000,
		instructions: '',
		options: [],
	}
	const draft: OrderDraft = {
		terminalCode: 'T1',
		locationId: 'loc-1',
		currency: 'USD',
		taxRatePercent: 10,
		orderType: 'dine_in',
		customerName: '',
		tableLabel: '12',
		lines: [line],
		adjustments: [],
		tipCents: 0,
	}
	const session: Session = {
		staff: { id: 'staff-1', name: 'Rana' } as Session['staff'],
		role: 'cashier',
		mode: 'offline',
		at: Date.now(),
	}

	beforeEach(async () => {
		await db.orders.clear()
		await db.meta.clear()
		await db.shifts.clear()
		vi.restoreAllMocks()
	})

	it('signing out shows the PIN screen and drops only the session', async () => {
		usePos.setState({ settings, session })
		expect(usePos.getState().session).not.toBeNull()
		usePos.getState().lock()
		// Locked: sign-in is required and nobody is signed in.
		expect(usePos.getState().session).toBeNull()
		expect(
			usePos.getState().settings.signInRequired &&
				usePos.getState().session === null,
		).toBe(true)
	})

	it('orders rung up offline still upload after the person was signed out', async () => {
		usePos.setState({ settings, session })
		const order = await createOrder(draft, {
			method: 'cash',
			amountCents: 1100,
			tenderedCents: 1100,
			changeCents: 0,
		})
		expect((await db.orders.get(order.id))!.sync).toBe('pending')

		// The till goes idle and signs the person out.
		usePos.getState().lock()
		expect(usePos.getState().session).toBeNull()
		expect((await db.orders.get(order.id))!.sync).toBe('pending')

		// The connection comes back; nobody is signed in, and the order goes.
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ order: { number: 'T1-0001' } }), {
				status: 201,
			}),
		)
		vi.stubGlobal('fetch', fetchMock)
		expect(await flushOutbox(settings)).toBe(1)
		expect((await db.orders.get(order.id))!).toMatchObject({ sync: 'synced' })
		const headers = fetchMock.mock.calls[0]![1].headers as Record<
			string,
			string
		>
		expect(headers.Authorization).toBe('Bearer device-secret')
		vi.unstubAllGlobals()
	})
})
