import { LOYALTY_MEMBER_CODE_TTL_MS } from '@repo/loyalty'
import { describe, expect, it, vi } from 'vitest'
import {
	testApproval,
	testEntry,
	testProgram,
	testQuote,
	testWallet,
} from './loyalty/test-fixtures.ts'
import {
	createAttemptKeys,
	createLoyaltyClient,
	isRetryableLoyaltyError,
	LoyaltyClientError,
	loyaltyErrorCodeFrom,
	loyaltyErrorFromResponse,
	memberCodeDeadline,
	type LoyaltyClient,
} from './loyalty-client.ts'

function setup(...answers: Array<Response | Error>) {
	const queue = [...answers]
	const next = async () => {
		const answer = queue.shift()
		if (!answer) throw new Error('Unexpected request')
		if (answer instanceof Error) throw answer
		return answer
	}
	const authedFetch =
		vi.fn<(path: string, init: RequestInit) => Promise<Response>>(next)
	const fetchImpl = vi.fn<typeof fetch>(next)
	const client = createLoyaltyClient({
		baseUrl: () => 'https://us.api.test/',
		authedFetch,
		fetchImpl,
		binding: () => ({ slug: 'acme' }),
		newKey: () => 'generated-key',
	})
	return { client, authedFetch, fetchImpl }
}

function sent(
	mock: { mock: { calls: Array<[unknown, RequestInit?]> } },
	index = 0,
) {
	const [target, init = {}] = mock.mock.calls[index]!
	return {
		target: String(target),
		method: init.method,
		headers: new Headers(init.headers),
		body: init.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
		cache: init.cache,
	}
}

describe('loyalty client requests', () => {
	it('reads the public program anonymously', async () => {
		const ctx = setup(Response.json({ program: testProgram() }))
		await expect(ctx.client.program()).resolves.toEqual(testProgram())
		expect(ctx.authedFetch).not.toHaveBeenCalled()
		const request = sent(ctx.fetchImpl)
		expect(request.target).toBe('https://us.api.test/loyalty/program?slug=acme')
		expect(request.method).toBe('GET')
		expect(request.headers.get('X-Client')).toBe('web')
		expect(request.headers.get('Authorization')).toBeNull()
		expect(request.cache).toBe('no-store')
	})

	it('fails a request that never answers as a network error', async () => {
		const client = createLoyaltyClient({
			baseUrl: () => 'https://us.api.test/',
			fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
			binding: () => ({ slug: 'acme' }),
			timeoutMs: 5,
		})
		await expect(client.program()).rejects.toMatchObject({ code: 'network' })
	})

	it.each(['checkout', 'tab'] as const)(
		'cancels a %s quote its caller stopped waiting for',
		async (kind) => {
			let seen: AbortSignal | null | undefined
			const authedFetch = vi.fn((_path: string, init: RequestInit) => {
				seen = init.signal
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('Aborted', 'AbortError')),
					)
				})
			})
			const client = createLoyaltyClient({
				baseUrl: () => 'https://us.api.test/',
				authedFetch,
				binding: () => ({ slug: 'acme' }),
			})
			const controller = new AbortController()
			const quote =
				kind === 'checkout'
					? client.checkoutQuote({
							order: {},
							selection: null,
							signal: controller.signal,
						})
					: client.tabQuote({
							tabToken: 'tab-token',
							tipPercent: 0,
							selection: null,
							signal: controller.signal,
						})
			await vi.waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1))
			expect(seen?.aborted).toBe(false)
			controller.abort()
			await expect(quote).rejects.toMatchObject({ code: 'network' })
			expect(seen?.aborted).toBe(true)
		},
	)

	it('answers null while loyalty is off', async () => {
		const ctx = setup(
			Response.json({ program: null }),
			Response.json({ wallet: null }),
		)
		await expect(ctx.client.program()).resolves.toBeNull()
		await expect(ctx.client.wallet()).resolves.toBeNull()
	})

	it('reads the wallet with the customer token', async () => {
		const ctx = setup(Response.json({ wallet: testWallet() }))
		await expect(ctx.client.wallet()).resolves.toEqual(testWallet())
		expect(ctx.fetchImpl).not.toHaveBeenCalled()
		const request = sent(ctx.authedFetch)
		expect(request.target).toBe('/loyalty/wallet?slug=acme')
		expect(request.method).toBe('GET')
	})

	it('pages through history with the cursor', async () => {
		const ctx = setup(
			Response.json({ entries: [testEntry()], nextCursor: 'c2' }),
			Response.json({ entries: [], nextCursor: null }),
		)
		await expect(ctx.client.history({ limit: 20 })).resolves.toEqual({
			entries: [testEntry()],
			nextCursor: 'c2',
		})
		await ctx.client.history({ cursor: 'c2', limit: 20 })
		expect(sent(ctx.authedFetch, 0).target).toBe(
			'/loyalty/history?slug=acme&limit=20',
		)
		expect(sent(ctx.authedFetch, 1).target).toBe(
			'/loyalty/history?slug=acme&cursor=c2&limit=20',
		)
	})

	it('asks for a member code and for the till requests waiting', async () => {
		const approval = testApproval({ createdAt: 1_000 })
		const ctx = setup(
			Response.json({ code: 'ABCD-EFGH', expiresAt: 5_000 }, { status: 201 }),
			Response.json({ approvals: [approval] }),
		)
		await expect(ctx.client.memberCode()).resolves.toEqual({
			code: 'ABCD-EFGH',
			expiresAt: 5_000,
		})
		await expect(ctx.client.approvals()).resolves.toEqual([approval])
		const code = sent(ctx.authedFetch, 0)
		expect(code.target).toBe('/loyalty/member-code?slug=acme')
		expect(code.method).toBe('POST')
		expect(code.body).toEqual({})
		expect(sent(ctx.authedFetch, 1).target).toBe('/loyalty/approvals?slug=acme')
	})

	it('decides a request by its encoded id', async () => {
		const approval = testApproval({
			id: 'apr/1',
			status: 'approved',
			createdAt: 1_000,
		})
		const ctx = setup(Response.json({ approval }))
		await expect(
			ctx.client.decideApproval('apr/1', 'approve', 'key-9'),
		).resolves.toEqual(approval)
		const request = sent(ctx.authedFetch)
		expect(request.target).toBe('/loyalty/approvals/apr%2F1/decide')
		expect(request.method).toBe('POST')
		expect(request.body).toEqual({ decision: 'approve', slug: 'acme' })
		expect(request.headers.get('Idempotency-Key')).toBe('key-9')
	})

	it('quotes the cart and the open tab with the picked reward', async () => {
		const order = { slug: 'acme', lines: [{ itemId: 'i1', quantity: 1 }] }
		const selection = {
			rewardId: 'rwd_coffee',
			rewardVersion: 1,
			expectedDiscountMinor: 500,
			targetLineId: null,
		}
		const picked = testQuote({
			selectedRewardId: 'rwd_coffee',
			availableAfter: 50,
			totals: { ...testQuote().totals, discountMinor: 500, totalMinor: 1_665 },
		})
		const ctx = setup(Response.json(testQuote()), Response.json(picked))
		await expect(
			ctx.client.checkoutQuote({ order, selection: null }),
		).resolves.toEqual(testQuote())
		await expect(
			ctx.client.tabQuote({ tabToken: 'tab-token', tipPercent: 10, selection }),
		).resolves.toEqual(picked)
		const checkout = sent(ctx.authedFetch, 0)
		expect(checkout.target).toBe('/loyalty/checkout/quote')
		expect(checkout.method).toBe('POST')
		expect(checkout.body).toEqual({ order, selection: null, slug: 'acme' })
		expect(checkout.headers.get('X-Tab-Token')).toBeNull()
		const tab = sent(ctx.authedFetch, 1)
		expect(tab.target).toBe('/loyalty/tab/quote')
		expect(tab.body).toEqual({ tipPercent: 10, selection, slug: 'acme' })
		expect(tab.headers.get('X-Tab-Token')).toBe('tab-token')
	})

	it('turns failures into typed errors', async () => {
		const ctx = setup(
			Response.json(
				{ error: 'On hold', code: 'member_inactive' },
				{ status: 409 },
			),
			new TypeError('offline'),
			Response.json({ wallet: { nonsense: true } }),
		)
		await expect(ctx.client.wallet()).rejects.toMatchObject({
			code: 'member_inactive',
			status: 409,
		})
		await expect(ctx.client.wallet()).rejects.toMatchObject({
			code: 'network',
			status: 0,
		})
		await expect(ctx.client.wallet()).rejects.toMatchObject({
			code: 'invalid_response',
			status: 200,
		})
	})
})

describe('loyalty error codes', () => {
	it('prefers the server code and falls back to the status', () => {
		expect(
			loyaltyErrorCodeFrom(409, { error: 'x', code: 'program_inactive' }),
		).toBe('program_inactive')
		expect(loyaltyErrorCodeFrom(403, { error: 'organization_mismatch' })).toBe(
			'organization_mismatch',
		)
		expect(loyaltyErrorCodeFrom(401, { error: 'Unauthorized' })).toBe(
			'signed_out',
		)
		expect(loyaltyErrorCodeFrom(404, { error: 'Not found' })).toBe(
			'organization_not_found',
		)
		expect(loyaltyErrorCodeFrom(429, null)).toBe('rate_limited')
		expect(loyaltyErrorCodeFrom(503, 'down')).toBe('loyalty_unavailable')
		expect(loyaltyErrorCodeFrom(422, {})).toBe('invalid_request')
		expect(loyaltyErrorCodeFrom(500, {})).toBe('unknown')
	})

	it('reads a whole-second retry hint', () => {
		expect(
			loyaltyErrorFromResponse(429, {
				code: 'rate_limited',
				retryAfterSeconds: 2.2,
			}).retryAfterSeconds,
		).toBe(3)
		expect(
			loyaltyErrorFromResponse(429, {
				code: 'rate_limited',
				retryAfterSeconds: 'soon',
			}).retryAfterSeconds,
		).toBeNull()
	})

	it('maps order refusals explicitly, never as a site or loyalty answer', () => {
		const order = (status: number, code: string) =>
			loyaltyErrorCodeFrom(status, { error: code, code, message: 'x' })
		// A tab that moved on is not "rewards are off on this site".
		expect(order(404, 'tab_not_found')).toBe('order_refused')
		expect(order(409, 'tab_closed')).toBe('order_refused')
		expect(order(422, 'loyalty_on_tab')).toBe('order_refused')
		expect(order(422, 'contact_name_required')).toBe('order_refused')
		// Ordering down for now is not "loyalty is unavailable".
		expect(order(503, 'ordering_unavailable')).toBe('order_unavailable')
		expect(order(503, 'dine_in_unavailable')).toBe('order_unavailable')
		expect(order(404, 'dine_in_unavailable')).toBe('order_unavailable')
		expect(order(409, 'tab_paying')).toBe('order_unavailable')
		expect(order(423, 'tab_locked')).toBe('order_unavailable')
		expect(order(429, 'table_rate_limited')).toBe('rate_limited')
		expect(order(400, 'invalid_request')).toBe('invalid_request')
		// A code this client does not know never falls back to a site answer.
		expect(order(404, 'some_new_code')).toBe('unknown')
		expect(order(503, 'some_new_code')).toBe('unknown')
	})

	it('reports signed_out when the organization is no longer active', () => {
		expect(
			loyaltyErrorCodeFrom(403, {
				error: 'Organization is no longer active',
				code: 'organization_inactive',
			}),
		).toBe('signed_out')
		expect(
			loyaltyErrorCodeFrom(403, { error: 'Organization is no longer active' }),
		).toBe('unknown')
	})

	it('retries only what may succeed with the same key', () => {
		expect(isRetryableLoyaltyError(new LoyaltyClientError('network', 0))).toBe(
			true,
		)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('rate_limited', 429)),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(
				new LoyaltyClientError('loyalty_unavailable', 503),
			),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('unknown', 502)),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('member_inactive', 409)),
		).toBe(false)
		expect(isRetryableLoyaltyError(new Error('boom'))).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('order_unavailable', 404)),
		).toBe(true)
		expect(
			isRetryableLoyaltyError(new LoyaltyClientError('order_refused', 409)),
		).toBe(false)
	})
})

describe('createAttemptKeys', () => {
	it('keeps one key per intent until a definitive answer', () => {
		let n = 0
		const keys = createAttemptKeys(() => `k${++n}`)
		expect(keys.key('decide:apr_2:approve')).toBe('k1')
		keys.settle('decide:apr_2:approve', new LoyaltyClientError('network', 0))
		expect(keys.key('decide:apr_2:approve')).toBe('k1')
		keys.settle(
			'decide:apr_2:approve',
			new LoyaltyClientError('program_inactive', 409),
		)
		expect(keys.key('decide:apr_2:approve')).toBe('k2')
		keys.settle('decide:apr_2:approve')
		expect(keys.key('decide:apr_2:approve')).toBe('k3')
		expect(keys.key('decide:apr_1:approve')).toBe('k4')
	})
})

describe('memberCodeDeadline', () => {
	const ttl = LOYALTY_MEMBER_CODE_TTL_MS

	it('follows the server when the clocks agree', () => {
		expect(memberCodeDeadline(1_000 + 60_000, 1_000, ttl)).toBe(61_000)
	})

	it('never runs past one TTL from arrival, and never starts expired', () => {
		expect(memberCodeDeadline(1_000 + ttl * 3, 1_000, ttl)).toBe(1_000 + ttl)
		expect(memberCodeDeadline(500, 1_000, ttl)).toBe(1_000 + ttl)
	})
})

describe('the customer session', () => {
	function client(answer: () => Response | Error) {
		const clearSession = vi.fn()
		const reply = async () => {
			const next = answer()
			if (next instanceof Error) throw next
			return next
		}
		return {
			clearSession,
			client: createLoyaltyClient({
				baseUrl: () => 'https://us.api.test/',
				authedFetch: reply,
				fetchImpl: reply as typeof fetch,
				binding: () => ({ slug: 'acme' }),
				clearSession,
			}),
		}
	}

	it.each([
		[
			'when the region refuses it',
			() =>
				Response.json({ error: 'Invalid or expired token' }, { status: 401 }),
			'signed_out',
		],
		[
			'when it belongs to another organization',
			() =>
				Response.json(
					{ error: 'organization_mismatch', code: 'organization_mismatch' },
					{ status: 403 },
				),
			'organization_mismatch',
		],
		[
			'when the organization is no longer active',
			() =>
				Response.json(
					{
						error: 'Organization is no longer active',
						code: 'organization_inactive',
					},
					{ status: 403 },
				),
			'signed_out',
		],
	])('is forgotten on every member call %s', async (_label, answer, code) => {
		const calls = [
			(c: LoyaltyClient) => c.wallet(),
			(c: LoyaltyClient) =>
				c.tabQuote({ tabToken: 'tab-token', tipPercent: 0, selection: null }),
			(c: LoyaltyClient) => c.checkoutQuote({ order: {}, selection: null }),
		]
		for (const call of calls) {
			const ctx = client(answer)
			await expect(call(ctx.client)).rejects.toMatchObject({ code })
			expect(ctx.clearSession).toHaveBeenCalledTimes(1)
		}
	})

	it('is kept through failures that may pass', async () => {
		for (const answer of [
			() => Response.json({ code: 'rate_limited' }, { status: 429 }),
			() => Response.json({ error: 'down' }, { status: 503 }),
			() => Response.json({ code: 'member_inactive' }, { status: 409 }),
			() => new TypeError('offline'),
		]) {
			const ctx = client(answer)
			await expect(ctx.client.wallet()).rejects.toBeInstanceOf(
				LoyaltyClientError,
			)
			expect(ctx.clearSession).not.toHaveBeenCalled()
		}
	})

	it('is not touched by the public program', async () => {
		const ctx = client(() =>
			Response.json({ error: 'Unauthorized' }, { status: 401 }),
		)
		await expect(ctx.client.program()).rejects.toMatchObject({
			code: 'signed_out',
		})
		expect(ctx.clearSession).not.toHaveBeenCalled()
	})
})
