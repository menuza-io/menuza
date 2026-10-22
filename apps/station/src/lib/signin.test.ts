import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db, getMeta, setMeta } from './db.ts'
import {
	CACHE_MAX_AGE_MS,
	DEMO_PIN,
	attemptSignIn,
	forgetCachedStaff,
	rememberStaff,
	type SignInDeps,
} from './signin.ts'

const ana = { id: 'staff-ana', name: 'Ana K.' }
const omar = { id: 'staff-omar', name: 'Omar R.' }
const online: SignInDeps = {
	tenantApiUrl: 'https://api.test',
	deviceToken: 'pdv1.secret',
	demo: false,
	online: true,
}
const offline: SignInDeps = { ...online, online: false }
const reply = (status: number, body: unknown = {}) =>
	vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(async () => {
	await db.staff.clear()
	await db.meta.clear()
	vi.restoreAllMocks()
})

describe('demo mode', () => {
	it('uses a fixed demo PIN, works with no network, and never calls a server', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		const ok = await attemptSignIn(DEMO_PIN, { ...online, demo: true })
		expect(ok).toMatchObject({
			ok: true,
			session: { staff: { name: 'Demo Cashier' }, role: 'manager' },
		})
		expect(
			await attemptSignIn('4321', { ...offline, demo: true }),
		).toMatchObject({ ok: false, reason: 'wrong_pin' })
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('online sign-in', () => {
	it('asks the server, returns who signed in, and remembers them for later', async () => {
		const fetchMock = reply(200, { staff: ana, role: 'cashier' })
		vi.stubGlobal('fetch', fetchMock)
		const r = await attemptSignIn('4321', online)
		expect(r).toMatchObject({
			ok: true,
			session: { staff: ana, role: 'cashier', mode: 'online' },
		})
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://api.test/pos/sign-in')
		expect(init.headers.Authorization).toBe('Bearer pdv1.secret')
		expect(JSON.parse(init.body)).toEqual({ pin: '4321' })
		const remembered = await db.staff.toArray()
		expect(remembered).toHaveLength(1)
		expect(JSON.stringify(remembered)).not.toContain('4321')
	})

	it('a wrong PIN is refused, and a remembered person whose PIN changed is forgotten', async () => {
		await rememberStaff('4321', ana, 'cashier')
		vi.stubGlobal(
			'fetch',
			reply(401, { error: 'invalid_pin', retryAfterSeconds: 0 }),
		)
		const r = await attemptSignIn('4321', online)
		expect(r).toMatchObject({ ok: false, reason: 'wrong_pin' })
		expect(await db.staff.count()).toBe(0)
	})

	it("relays the server's wait, in seconds", async () => {
		vi.stubGlobal(
			'fetch',
			reply(429, { error: 'backoff', retryAfterSeconds: 90 }),
		)
		const r = await attemptSignIn('4321', online)
		expect(r).toMatchObject({
			ok: false,
			reason: 'wait',
			retryAfterSeconds: 90,
		})
		expect((r as { message: string }).message).toContain('90 seconds')
	})

	it('a removed terminal and a terminal with sign-in switched off are told apart', async () => {
		vi.stubGlobal('fetch', reply(401, { error: 'device_revoked' }))
		expect(await attemptSignIn('4321', online)).toMatchObject({
			ok: false,
			reason: 'terminal_removed',
		})
		vi.stubGlobal('fetch', reply(409, { error: 'sign_in_not_required' }))
		expect(await attemptSignIn('4321', online)).toMatchObject({
			ok: false,
			reason: 'sign_in_off',
		})
	})

	it('rejects something that cannot be a PIN without asking anyone', async () => {
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		for (const bad of ['', '12', 'abcd', '1234567'])
			expect(await attemptSignIn(bad, online)).toMatchObject({
				ok: false,
				reason: 'bad_pin',
			})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('a person with a new PIN replaces the old entry for that PIN, and a PIN names one person', async () => {
		await rememberStaff('4321', ana, 'cashier')
		await rememberStaff('4321', omar, 'cashier') // omar now holds 4321: ana's old entry is stale
		expect((await db.staff.toArray()).map((s) => s.id)).toEqual([omar.id])
		await rememberStaff('4321', omar, 'manager') // same person again: updated, not duplicated
		const all = await db.staff.toArray()
		expect(all).toHaveLength(1)
		expect(all[0]!.role).toBe('manager')
	})
})

describe('when the server cannot decide, the till uses the people it remembers', () => {
	it.each([
		[
			'the network fails',
			() => vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		],
		['the server is down', () => reply(503, { error: 'service_unavailable' })],
		[
			'it does not recognise the terminal',
			() => reply(401, { error: 'invalid_device' }),
		],
		['an unexpected error', () => reply(500, { error: 'internal_error' })],
	])('%s', async (_name, make) => {
		await rememberStaff('4321', ana, 'manager')
		vi.stubGlobal('fetch', make())
		expect(await attemptSignIn('4321', online)).toMatchObject({
			ok: true,
			session: { staff: ana, role: 'manager', mode: 'offline' },
		})
	})

	it('a wrong PIN is still wrong, and never slips through', async () => {
		await rememberStaff('4321', ana, 'cashier')
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('x')))
		expect(await attemptSignIn('9999', online)).toMatchObject({
			ok: false,
			reason: 'wrong_pin',
		})
	})
})

describe('offline sign-in', () => {
	it('works for someone who has signed in online on this device', async () => {
		await rememberStaff('4321', ana, 'cashier')
		await rememberStaff('8765', omar, 'manager')
		expect(await attemptSignIn('8765', offline)).toMatchObject({
			ok: true,
			session: { staff: omar, role: 'manager', mode: 'offline' },
		})
		expect(await attemptSignIn('4321', offline)).toMatchObject({
			ok: true,
			session: { staff: ana, mode: 'offline' },
		})
	})

	it('the very first sign-in on a device needs a connection, and says so', async () => {
		const r = await attemptSignIn('4321', offline)
		expect(r).toMatchObject({ ok: false, reason: 'needs_connection' })
		expect((r as { message: string }).message).toMatch(
			/first sign-in on this device needs a connection/,
		)
	})

	it('works for no one who has not been seen, and the unpaired case is offline too', async () => {
		await rememberStaff('4321', ana, 'cashier')
		expect(await attemptSignIn('0000', offline)).toMatchObject({
			ok: false,
			reason: 'wrong_pin',
		})
		expect(
			await attemptSignIn('4321', { ...online, deviceToken: null }),
		).toMatchObject({ ok: true })
	})

	it('slows down after repeated wrong PINs, and the wait survives a reload', async () => {
		await rememberStaff('4321', ana, 'cashier')
		for (let i = 0; i < 5; i++) await attemptSignIn('0000', offline)
		const during = await attemptSignIn('4321', offline)
		expect(during).toMatchObject({ ok: false, reason: 'wait' })
		expect(
			(during as { retryAfterSeconds: number }).retryAfterSeconds,
		).toBeGreaterThan(0)
		// "Reload": the guard is read back from storage, not memory.
		expect(await getMeta('pin-guard')).toMatchObject({ failures: 5 })
		expect(await attemptSignIn('4321', offline)).toMatchObject({
			ok: false,
			reason: 'wait',
		})
	})

	it('forgives time: after the wait the right PIN works again', async () => {
		await rememberStaff('4321', ana, 'cashier')
		const t0 = Date.now()
		for (let i = 0; i < 5; i++) await attemptSignIn('0000', offline, t0)
		expect(await attemptSignIn('4321', offline, t0 + 1000)).toMatchObject({
			reason: 'wait',
		})
		expect(await attemptSignIn('4321', offline, t0 + 31_000)).toMatchObject({
			ok: true,
		})
	})

	it('asks for a connection once the remembered sign-in is too old, rather than trusting it forever', async () => {
		const then = Date.now()
		await rememberStaff('4321', ana, 'cashier', then)
		expect(
			await attemptSignIn('4321', offline, then + CACHE_MAX_AGE_MS - 1000),
		).toMatchObject({ ok: true })
		const stale = await attemptSignIn(
			'4321',
			offline,
			then + CACHE_MAX_AGE_MS + 1000,
		)
		expect(stale).toMatchObject({ ok: false, reason: 'needs_connection' })
		// Going online again renews it.
		vi.stubGlobal('fetch', reply(200, { staff: ana, role: 'cashier' }))
		expect(
			await attemptSignIn('4321', online, then + CACHE_MAX_AGE_MS + 2000),
		).toMatchObject({ ok: true, session: { mode: 'online' } })
		expect(
			await attemptSignIn('4321', offline, then + CACHE_MAX_AGE_MS + 3000),
		).toMatchObject({ ok: true })
	})

	it('a successful online sign-in clears earlier offline mistakes', async () => {
		await rememberStaff('4321', ana, 'cashier')
		for (let i = 0; i < 3; i++) await attemptSignIn('0000', offline)
		vi.stubGlobal('fetch', reply(200, { staff: ana, role: 'cashier' }))
		await attemptSignIn('4321', online)
		expect(await getMeta('pin-guard')).toMatchObject({ failures: 0 })
	})
})

describe('device storage', () => {
	it('keeps one salt for the device and never stores a PIN', async () => {
		await rememberStaff('4321', ana, 'cashier')
		const salt = await getMeta<string>('pin-salt')
		await rememberStaff('8765', omar, 'cashier')
		expect(await getMeta('pin-salt')).toBe(salt)
		await setMeta('probe', 1)
		const dump = JSON.stringify([
			await db.staff.toArray(),
			await db.meta.toArray(),
		])
		expect(dump).not.toMatch(/4321|8765/)
	})
})

describe('forgetCachedStaff', () => {
	it('removes remembered people and the offline attempt counter', async () => {
		await rememberStaff('4321', { id: 's1', name: 'Ana K.' }, 'cashier')
		await setMeta('pin-guard', {
			failures: 2,
			lastFailureAt: 1,
			blockedUntil: null,
		})
		await forgetCachedStaff()
		expect(await db.staff.count()).toBe(0)
		expect(await getMeta('pin-guard')).toBeUndefined()
	})
})
