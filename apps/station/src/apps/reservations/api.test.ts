import { describe, expect, it, vi } from 'vitest'
import { createHostApi, HostApiError } from './api.ts'
import dayFeed from './fixtures/day-feed.json'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

const settings = {
	tenantApiUrl: 'https://us.node.test/',
	deviceToken: 'pdv1.org.dev.secret',
} as PosSettings

const session = (token = 'session-token-aaaaaaaaaaaaaaaaaaaa'): Session => ({
	staff: { id: 's1', name: 'Rana K.' },
	role: 'cashier',
	mode: 'online',
	at: 0,
	serverSession: { token, expiresAt: Date.now() + 3_600_000 },
})

function server(ttlMs = 15 * 60_000) {
	let minted = 0
	const calls: Array<{ url: string; init: RequestInit }> = []
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			calls.push({ url, init: init ?? {} })
			const headers = new Headers(init?.headers)
			if (url.endsWith('/pos/reservations/token')) {
				minted += 1
				return Response.json({
					token: `rsv-token-${minted}-xxxxxxxxxxxxxxxxxxxx`,
					expiresAt: Date.now() + ttlMs,
					locationId: 'loc_pub_main',
					canReadGuest: false,
					features: { waitlist: true, online: true },
				})
			}
			if (headers.get('If-None-Match') === '"v1"')
				return new Response(null, { status: 304 })
			return Response.json(dayFeed, { headers: { ETag: '"v1"' } })
		},
	)
	return { fetchImpl, calls, minted: () => minted }
}

describe('host stand client', () => {
	it('trades the device secret and the session for a token, then reuses it', async () => {
		const s = server()
		let current: Session | null = session()
		const api = createHostApi({
			settings: () => settings,
			session: () => current,
			fetchImpl: s.fetchImpl as never,
		})
		const first = await api.day()
		expect('feed' in first && first.feed.reservations).toHaveLength(3)
		const mint = s.calls[0]!
		expect(mint.url).toBe('https://us.node.test/pos/reservations/token')
		const mintHeaders = new Headers(mint.init.headers)
		expect(mintHeaders.get('Authorization')).toBe(
			`Bearer ${settings.deviceToken}`,
		)
		expect(mintHeaders.get('Pos-Staff-Session')).toBe(
			current.serverSession!.token,
		)
		const day = s.calls[1]!
		expect(day.url).toBe(
			'https://us.node.test/operator/reservations/book/day?locationId=loc_pub_main',
		)
		expect(new Headers(day.init.headers).get('Authorization')).toBe(
			'Bearer rsv-token-1-xxxxxxxxxxxxxxxxxxxx',
		)

		// Polling with the ETag answers "unchanged" and mints nothing new.
		expect(await api.day('"v1"')).toEqual({ unchanged: true })
		expect(s.minted()).toBe(1)

		// Someone else signs in: their own token.
		current = session('another-session-bbbbbbbbbbbbbbbbbbbb')
		await api.day()
		expect(s.minted()).toBe(2)
	})

	it('refuses without an online sign-in, and says so', async () => {
		const s = server()
		const api = createHostApi({
			settings: () => settings,
			session: () => ({ ...session(), serverSession: undefined }),
			fetchImpl: s.fetchImpl as never,
		})
		const error = await api.day().catch((e: unknown) => e)
		expect(error).toBeInstanceOf(HostApiError)
		expect((error as HostApiError).needsSignIn).toBe(true)
		expect(s.calls).toHaveLength(0)
	})

	it('mints again once when a token dies early', async () => {
		let dayCalls = 0
		const s = server()
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).includes('/book/day') && dayCalls++ === 0)
					return Response.json({ error: 'expired' }, { status: 401 })
				return s.fetchImpl(input, init)
			},
		)
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: fetchImpl as never,
		})
		const result = await api.day()
		expect('feed' in result).toBe(true)
		expect(s.minted()).toBe(2)
	})

	it('sends writes with an idempotency key and reports a stale version', async () => {
		const s = server()
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).includes('/status'))
					return Response.json({ error: 'stale_version' }, { status: 409 })
				return s.fetchImpl(input, init)
			},
		)
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: fetchImpl as never,
		})
		const error = (await api
			.transition('res_1', 'seated', { tableIds: ['t1'], expectedVersion: 3 })
			.catch((e: unknown) => e)) as HostApiError
		expect(error.stale).toBe(true)
		const [, init] = fetchImpl.mock.calls.at(-1)! as [string, RequestInit]
		expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(
			/[0-9a-f-]{36}/,
		)
		expect(JSON.parse(String(init.body))).toEqual({
			toStatus: 'seated',
			tableIds: ['t1'],
			expectedVersion: 3,
		})
	})

	it('judges a token’s age by this tablet’s clock, even when it runs fast', async () => {
		// Five-minute tokens on a tablet 4.5 minutes ahead of the server.
		const s = server(5 * 60_000)
		const ahead = 270_000
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: s.fetchImpl as never,
			now: () => Date.now() + ahead,
			skewMs: () => -ahead,
		})
		await api.day()
		await api.day()
		await api.day()
		expect(s.minted()).toBe(1)
	})

	it('forgetting the person drops a token still being minted for them', async () => {
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const s = server()
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input).endsWith('/pos/reservations/token')) await gate
				return s.fetchImpl(input, init)
			},
		)
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: fetchImpl as never,
		})
		const first = api.grant()
		api.forget()
		release()
		await first
		// The till locked meanwhile: the next call mints afresh, never reusing it.
		await api.grant()
		expect(s.minted()).toBe(2)
	})

	it('asks for another day by its business date, and for today with none', async () => {
		const s = server()
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: s.fetchImpl as never,
		})
		await api.day(undefined, '2026-01-17')
		await api.day()
		const days = s.calls.filter((c) => c.url.includes('/book/day'))
		expect(days[0]!.url).toBe(
			'https://us.node.test/operator/reservations/book/day?locationId=loc_pub_main&date=2026-01-17',
		)
		expect(days[1]!.url).not.toContain('date=')
	})

	it('a lost connection is offline, not a refusal', async () => {
		const api = createHostApi({
			settings: () => settings,
			session: () => session(),
			fetchImpl: (async () => {
				throw new TypeError('Failed to fetch')
			}) as never,
		})
		const error = (await api.day().catch((e: unknown) => e)) as HostApiError
		expect(error.offline).toBe(true)
	})
})
