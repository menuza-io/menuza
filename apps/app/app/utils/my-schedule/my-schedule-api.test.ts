import { describe, expect, it, vi } from 'vitest'
import {
	createMyScheduleApi,
	MyScheduleApiError,
	MyScheduleNetworkError,
} from './my-schedule-api.ts'

const TOKEN = `slk1.org_1.link-0001.${'a'.repeat(64)}`

function api(
	respond: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
	const calls: Array<{ url: string; init: RequestInit }> = []
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} })
			return respond(String(input), init ?? {})
		},
	) as unknown as typeof fetch
	return {
		calls,
		client: createMyScheduleApi({
			tenantApiUrl: 'https://us.tenant.test/',
			token: TOKEN,
			fetchImpl,
			timeoutMs: 200,
		}),
	}
}

const schedule = {
	serverNow: 1,
	person: { firstName: 'Ana', firstNameAr: null, locale: 'en' },
	scopes: [],
	from: '2026-03-01',
	to: '2026-04-05',
	shifts: [],
	link: { expiresAt: 5 },
}

describe('the schedule link client', () => {
	it('sends the token only as a bearer header, never in the address, and no referrer', async () => {
		const { client, calls } = api(() => Response.json(schedule))
		await client.schedule({ from: '2026-03-01', to: '2026-03-30' })
		const [call] = calls
		expect(call!.url).toBe(
			'https://us.tenant.test/schedule-link/me?from=2026-03-01&to=2026-03-30',
		)
		expect(call!.url).not.toContain('slk1')
		expect(new Headers(call!.init.headers).get('Authorization')).toBe(
			`Bearer ${TOKEN}`,
		)
		expect(call!.init.referrerPolicy).toBe('no-referrer')
		expect(call!.init.cache).toBe('no-store')
	})

	it('posts requests as JSON and encodes ids in paths', async () => {
		const { client, calls } = api(() =>
			Response.json({
				id: 'x',
				category: 'sick',
				startDate: '2026-03-10',
				endDate: '2026-03-10',
				allDay: true,
				startMinute: null,
				endMinute: null,
				note: null,
				status: 'pending',
				decisionNote: null,
				createdAt: 1,
			}),
		)
		await client.requestTimeOff({
			category: 'sick',
			startDate: '2026-03-10',
			endDate: '2026-03-10',
			allDay: true,
		})
		await client.cancelTimeOff('a/b c')
		expect(calls[0]!.init.method).toBe('POST')
		expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
			category: 'sick',
		})
		expect(calls[1]!.url).toBe(
			'https://us.tenant.test/schedule-link/me/time-off/a%2Fb%20c/cancel',
		)
	})

	it.each([
		'invalid_link',
		'link_revoked',
		'link_expired',
		'staff_inactive',
		'schedule_disabled',
	])('knows %s means the whole link is gone', async (code) => {
		const { client } = api(() =>
			Response.json({ error: code }, { status: 401 }),
		)
		const error = await client.schedule().catch((e: unknown) => e)
		expect(error).toBeInstanceOf(MyScheduleApiError)
		expect((error as MyScheduleApiError).code).toBe(code)
		expect((error as MyScheduleApiError).linkGone).toBe(true)
	})

	it('does not treat an ordinary refusal as the link being gone, and reads Retry-After', async () => {
		const { client } = api(
			() =>
				new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), {
					status: 429,
					headers: { 'Retry-After': '90', 'content-type': 'application/json' },
				}),
		)
		const error = (await client
			.requests()
			.catch((e: unknown) => e)) as MyScheduleApiError
		expect(error.linkGone).toBe(false)
		expect(error.status).toBe(429)
		expect(error.retryAfterSeconds).toBe(90)
	})

	it('treats an HTML error page or a changed shape as a bad answer, not data', async () => {
		const html = api(() => new Response('<html>oops</html>', { status: 200 }))
		const first = (await html.client
			.schedule()
			.catch((e: unknown) => e)) as MyScheduleApiError
		expect(first.code).toBe('malformed_response')
		const shaped = api(() => Response.json({ serverNow: 'later' }))
		const second = (await shaped.client
			.schedule()
			.catch((e: unknown) => e)) as MyScheduleApiError
		expect(second.status).toBe(502)
		const broken = api(() => new Response('<html>', { status: 503 }))
		expect(
			(
				(await broken.client
					.schedule()
					.catch((e: unknown) => e)) as MyScheduleApiError
			).code,
		).toBe('request_failed')
	})

	it('reports a missing connection and a hung request as the network being down', async () => {
		const down = api(() => {
			throw new TypeError('Failed to fetch')
		})
		expect(
			await down.client.schedule().catch((e: unknown) => e),
		).toBeInstanceOf(MyScheduleNetworkError)
		const hung = createMyScheduleApi({
			tenantApiUrl: 'https://us.tenant.test',
			token: TOKEN,
			timeoutMs: 20,
			fetchImpl: ((_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError')),
					)
				})) as unknown as typeof fetch,
		})
		expect(await hung.schedule().catch((e: unknown) => e)).toBeInstanceOf(
			MyScheduleNetworkError,
		)
	})
})
