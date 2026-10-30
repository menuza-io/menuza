import { type LoyaltyProgramConfig, type LoyaltyScope } from '@repo/loyalty'
import { describe, expect, it, vi } from 'vitest'
import {
	LoyaltyApiError,
	createLoyaltyClient,
	createLoyaltyClientPool,
	newLoyaltyIdempotencyKey,
	type LoyaltyClientPool,
	type LoyaltyRequestOptions,
	type LoyaltyTokenResponse,
} from './loyalty-client.ts'

const ORG_SLUG = 'acme'

const programConfig: LoyaltyProgramConfig = {
	name: 'Club',
	unitLabel: 'points',
	currency: 'SAR',
	timeZone: 'Asia/Riyadh',
	minimumSpendMinor: 0,
	earning: { method: 'spend', points: 1, perMinor: 100 },
	terms: 'The terms',
	labels: { items: {}, categories: {} },
}

function makeToken(
	scope: LoyaltyScope,
	expiresAt = Date.now() + 900_000,
): LoyaltyTokenResponse {
	return {
		jwt: `jwt-${scope}-${expiresAt}`,
		tenantApiUrl: 'https://tenant.test',
		expiresAt,
		scope,
		grants: [],
		locationIds: null,
		features: { enabled: true, redemption: true },
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

type FetchCall = { url: string; init: RequestInit }

function createFetchHarness({
	tokenExpiresAt = Date.now() + 900_000,
}: { tokenExpiresAt?: number } = {}) {
	const calls: FetchCall[] = []
	let apiHandler: (call: FetchCall) => Response = () => jsonResponse({})

	const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
		const url = String(input)
		const call: FetchCall = { url, init: init ?? {} }
		calls.push(call)
		if (url.includes('/loyalty/token')) {
			const scope =
				(new URL(url, 'https://app.test').searchParams.get(
					'scope',
				) as LoyaltyScope | null) ?? 'read'
			return jsonResponse(makeToken(scope, tokenExpiresAt))
		}
		return apiHandler(call)
	}) as unknown as typeof fetch

	const apiCalls = () =>
		calls.filter((call) => !call.url.includes('/loyalty/token'))
	const tokenCalls = () =>
		calls.filter((call) => call.url.includes('/loyalty/token'))

	return {
		fetchImpl,
		calls,
		apiCalls,
		tokenCalls,
		setApiHandler(handler: (call: FetchCall) => Response) {
			apiHandler = handler
		},
	}
}

describe('createLoyaltyClientPool', () => {
	it('mints one token per scope and reuses it', async () => {
		const harness = createFetchHarness()
		harness.setApiHandler(() => jsonResponse({ program: null }))
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})
		const read = pool.forScope('read')

		await read.request('/operator/loyalty/program')
		await read.request('/operator/loyalty/program')

		expect(harness.tokenCalls()).toHaveLength(1)
		expect(harness.tokenCalls()[0]?.url).toBe(
			`/${ORG_SLUG}/loyalty/token?scope=read`,
		)
		expect(harness.apiCalls()).toHaveLength(2)
		expect(harness.apiCalls()[0]?.url).toBe(
			'https://tenant.test/operator/loyalty/program',
		)
		const headers = harness.apiCalls()[0]?.init.headers as Record<
			string,
			string
		>
		expect(headers.Authorization).toMatch(/^Bearer jwt-read-/)
	})

	it('refuses a token response that is not the credentials contract', async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ jwt: '', tenantApiUrl: 'not a url' }),
		) as unknown as typeof fetch
		const pool = createLoyaltyClientPool({ orgSlug: ORG_SLUG, fetchImpl })

		await expect(
			pool.forScope('read').request('/operator/loyalty/program'),
		).rejects.toThrow()
		// Nothing was cached: the next call mints again.
		await expect(pool.forScope('read').getToken()).rejects.toThrow()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it('dedupes concurrent token mints for the same scope', async () => {
		const harness = createFetchHarness()
		harness.setApiHandler(() => jsonResponse({ program: null }))
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})
		const read = pool.forScope('read')

		await Promise.all([
			read.request('/operator/loyalty/program'),
			read.request('/operator/loyalty/program'),
		])

		expect(harness.tokenCalls()).toHaveLength(1)
		expect(harness.apiCalls()).toHaveLength(2)
	})

	it('mints separate tokens for separate scopes', async () => {
		const harness = createFetchHarness()
		harness.setApiHandler(() => jsonResponse({ program: null }))
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})

		await pool.forScope('read').request('/operator/loyalty/program')
		await pool.forScope('members').request('/operator/loyalty/members')

		expect(harness.tokenCalls()).toHaveLength(2)
		expect(harness.tokenCalls().map((call) => call.url)).toEqual([
			`/${ORG_SLUG}/loyalty/token?scope=read`,
			`/${ORG_SLUG}/loyalty/token?scope=members`,
		])
	})

	it('refreshes a token that expires inside the skew window', async () => {
		const harness = createFetchHarness({
			tokenExpiresAt: Date.now() + 10_000,
		})
		harness.setApiHandler(() => jsonResponse({ program: null }))
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})
		const read = pool.forScope('read')

		await read.request('/operator/loyalty/program')
		await read.request('/operator/loyalty/program')

		expect(harness.tokenCalls()).toHaveLength(2)
	})

	it('retries once with a fresh token after a 401', async () => {
		const harness = createFetchHarness()
		let apiCount = 0
		harness.setApiHandler(() => {
			apiCount += 1
			return apiCount === 1
				? jsonResponse({ error: 'unauthorized', code: 'unauthorized' }, 401)
				: jsonResponse({ program: null })
		})
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})

		const result = await pool
			.forScope('read')
			.request('/operator/loyalty/program')

		expect(result).toEqual({ program: null })
		expect(harness.tokenCalls()).toHaveLength(2)
		expect(harness.apiCalls()).toHaveLength(2)
	})

	it('throws LoyaltyApiError with the API error code', async () => {
		const harness = createFetchHarness()
		harness.setApiHandler(() =>
			jsonResponse({ error: 'Version conflict', code: 'stale_version' }, 409),
		)
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: harness.fetchImpl,
		})

		const failure = await pool
			.forScope('read')
			.request('/operator/loyalty/program')
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(LoyaltyApiError)
		expect((failure as LoyaltyApiError).status).toBe(409)
		expect((failure as LoyaltyApiError).code).toBe('stale_version')
	})

	it('throws when the token mint fails', async () => {
		const harness = createFetchHarness()
		const pool = createLoyaltyClientPool({
			orgSlug: ORG_SLUG,
			fetchImpl: (async () =>
				jsonResponse({ code: 'loyalty_unavailable' }, 503)) as typeof fetch,
		})

		const failure = await pool
			.forScope('read')
			.request('/operator/loyalty/program')
			.catch((error: unknown) => error)

		expect(failure).toBeInstanceOf(LoyaltyApiError)
		expect((failure as LoyaltyApiError).status).toBe(503)
		expect((failure as LoyaltyApiError).code).toBe('loyalty_unavailable')
		expect(harness.apiCalls()).toHaveLength(0)
	})
})

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

function fakePool(responses: Record<string, unknown>) {
	const calls: Array<{
		scope: string
		path: string
		options: LoyaltyRequestOptions
	}> = []
	const pool = {
		orgSlug: ORG_SLUG,
		forScope(scope: LoyaltyScope) {
			return {
				scope,
				request: vi.fn(
					async (path: string, options?: LoyaltyRequestOptions) => {
						const opts = options ?? {}
						calls.push({ scope, path, options: opts })
						const key = `${opts.method ?? 'GET'} ${path}`
						const response = responses[key]
						if (response === undefined) {
							throw new Error(`No fake response for ${key}`)
						}
						return response
					},
				),
				getToken: vi.fn(),
				invalidate: vi.fn(),
			}
		},
		invalidateAll: vi.fn(),
	} as unknown as LoyaltyClientPool
	return { pool, calls }
}

describe('createLoyaltyClient', () => {
	it('reads the program with the read scope', async () => {
		const { pool, calls } = fakePool({
			'GET /operator/loyalty/program': { program: null },
		})
		const client = createLoyaltyClient(pool)

		const program = await client.getProgram()

		expect(program).toBeNull()
		expect(calls).toEqual([
			{
				scope: 'read',
				path: '/operator/loyalty/program',
				options: { signal: undefined },
			},
		])
	})

	it('saves the program with the setup scope and an Idempotency-Key', async () => {
		const program = {
			id: 'prog_1',
			status: 'active',
			version: 2,
			currencyLocked: true,
			current: {
				id: 'pv_2',
				version: 2,
				status: 'active',
				effectiveAt: 1000,
				config: programConfig,
				createdAt: 1000,
				createdBy: null,
			},
			history: [],
		}
		const { pool, calls } = fakePool({
			'PUT /operator/loyalty/program': { program },
		})
		const client = createLoyaltyClient(pool)

		const saved = await client.saveProgram(
			{ expectedVersion: 1, config: programConfig },
			'lty-test-fixed-key',
		)

		expect(saved.version).toBe(2)
		expect(calls).toHaveLength(1)
		const call = calls[0]!
		expect(call.scope).toBe('setup')
		expect(call.options.method).toBe('PUT')
		expect(call.options.body).toEqual({
			expectedVersion: 1,
			config: programConfig,
		})
		expect(call.options.headers?.['Idempotency-Key']).toBe('lty-test-fixed-key')
	})

	it('generates an Idempotency-Key when none is given', async () => {
		const { pool, calls } = fakePool({
			'POST /operator/loyalty/program/status': {
				program: {
					id: 'prog_1',
					status: 'paused',
					version: 3,
					currencyLocked: true,
					current: {
						id: 'pv_3',
						version: 3,
						status: 'paused',
						effectiveAt: 2000,
						config: programConfig,
						createdAt: 2000,
						createdBy: null,
					},
					history: [],
				},
			},
		})
		const client = createLoyaltyClient(pool)

		await client.setProgramStatus({ expectedVersion: 2, status: 'paused' })

		const call = calls[0]!
		expect(call.scope).toBe('setup')
		expect(call.options.headers?.['Idempotency-Key']).toMatch(/^lty-op-/)
	})

	it('reads the points account of one customer with the members scope', async () => {
		const member = {
			id: 'mem_1',
			customerId: 'cus_1',
			name: 'Ada',
			phoneLast4: '0123',
			status: 'active',
			createdAt: 1_700_000_000_000,
			balance: { points: 40, reserved: 0, available: 40 },
			lastPurchaseAt: null,
		}
		const { pool, calls } = fakePool({
			'GET /operator/loyalty/members/customer/cus%201': { member },
		})
		const client = createLoyaltyClient(pool)

		await expect(client.getCustomerMember('cus 1')).resolves.toEqual(member)

		const call = calls[0]!
		expect(call.scope).toBe('members')
		expect(call.path).toBe('/operator/loyalty/members/customer/cus%201')
		expect(call.options.body).toBeUndefined()
	})

	it('answers null for a customer who has no points account yet', async () => {
		const { pool } = fakePool({
			'GET /operator/loyalty/members/customer/cus_2': { member: null },
		})
		const client = createLoyaltyClient(pool)

		await expect(client.getCustomerMember('cus_2')).resolves.toBeNull()
	})

	it('reads the review queue and resolves with the reconcile scope', async () => {
		const redemption = {
			id: 'rdm_1',
			memberId: 'mem_1',
			rewardId: 'rwd_1',
			rewardVersion: 1,
			rewardName: 'Free coffee',
			points: 100,
			state: 'consumed',
			channel: 'web',
			sourceType: 'restaurant_order',
			sourceId: 'ord_1',
			locationId: null,
			currency: 'SAR',
			discountMinor: 500,
			reviewReason: null,
			createdAt: 1000,
			updatedAt: 2000,
		}
		const { pool, calls } = fakePool({
			'GET /operator/loyalty/review': {
				redemptions: [],
				purchases: [],
				parked: [],
			},
			'POST /operator/loyalty/redemptions/rdm_1/resolve': { redemption },
		})
		const client = createLoyaltyClient(pool)

		const queue = await client.getReview()
		expect(queue).toEqual({ redemptions: [], purchases: [], parked: [] })

		const resolved = await client.resolveRedemption(
			'rdm_1',
			{ action: 'consume', note: 'Sale paid at the counter' },
			'lty-test-resolve',
		)
		expect(resolved.state).toBe('consumed')

		expect(calls.map((call) => call.scope)).toEqual(['reconcile', 'reconcile'])
		const resolveCall = calls[1]!
		expect(resolveCall.options.method).toBe('POST')
		expect(resolveCall.options.body).toEqual({
			action: 'consume',
			note: 'Sale paid at the counter',
		})
		expect(resolveCall.options.headers?.['Idempotency-Key']).toBe(
			'lty-test-resolve',
		)
	})

	it('lists parked sources and tries one again with the reconcile scope', async () => {
		const parked = {
			sourceType: 'pos_order',
			sourceId: 'sale_1',
			memberId: 'mem_1',
			locationId: null,
			attempts: 5,
			lastError: 'loyalty_unavailable',
			parkedAt: 3000,
		}
		const { pool, calls } = fakePool({
			'GET /operator/loyalty/review': {
				redemptions: [],
				purchases: [],
				parked: [parked],
			},
			'POST /operator/loyalty/requeue': { queued: false },
		})
		const client = createLoyaltyClient(pool)

		expect((await client.getReview()).parked).toEqual([parked])
		expect(await client.requeue({ type: 'pos_order', id: 'sale_1' })).toEqual({
			queued: false,
		})

		expect(calls.map((call) => call.scope)).toEqual(['reconcile', 'reconcile'])
		const requeueCall = calls[1]!
		expect(requeueCall.options.method).toBe('POST')
		expect(requeueCall.options.body).toEqual({
			source: { type: 'pos_order', id: 'sale_1' },
		})
	})

	it('records a refund with the reconcile scope and an Idempotency-Key', async () => {
		const result = {
			refundId: 'rfd_1',
			purchaseId: 'pur_1',
			refundedMinor: 450,
			cumulativeRefundedMinor: 450,
			pointsReversed: 4,
			fullRefund: false,
			rewardRestored: false,
		}
		const { pool, calls } = fakePool({
			'POST /operator/loyalty/refunds': result,
		})
		const client = createLoyaltyClient(pool)

		const recorded = await client.recordRefund(
			{
				source: { type: 'qr_tab', id: 'tab_1' },
				amountMinor: 450,
				note: 'Refunded in the payment dashboard',
			},
			'lty-test-refund',
		)

		expect(recorded).toEqual(result)
		const call = calls[0]!
		expect(call.scope).toBe('reconcile')
		expect(call.options.method).toBe('POST')
		expect(call.options.body).toEqual({
			source: { type: 'qr_tab', id: 'tab_1' },
			amountMinor: 450,
			note: 'Refunded in the payment dashboard',
		})
		expect(call.options.headers?.['Idempotency-Key']).toBe('lty-test-refund')
	})

	it('reads the report with the reports scope', async () => {
		const report = {
			window: { from: '2026-01-01', to: '2026-01-31', timeZone: 'Asia/Riyadh' },
			currency: 'SAR',
			customers: { accountsTotal: 0, accountsOpened: 0, activeInWindow: 0 },
			points: {
				earned: 0,
				reversed: 0,
				redeemed: 0,
				restored: 0,
				adjustedNet: 0,
				reservedNow: 0,
				outstandingNow: 0,
			},
			redemptions: {
				consumed: 0,
				restored: 0,
				released: 0,
				discountCostMinor: 0,
				conversionBp: 0,
			},
			purchases: {
				count: 0,
				customerRevenueMinor: 0,
				averageOrderValueMinor: 0,
				repeatPurchaseRateBp: 0,
				frequencyHundredths: 0,
			},
			operations: {
				redemptionsInReview: 0,
				purchasesInReview: 0,
				openRedemptions: 0,
				oldestOpenRedemptionAgeMs: null,
				refundsRecorded: 0,
			},
		}
		const { pool, calls } = fakePool({
			'GET /operator/loyalty/reports': { report },
		})
		const client = createLoyaltyClient(pool)

		const result = await client.getReport({
			from: '2026-01-01',
			to: '2026-01-31',
		})

		expect(result.currency).toBe('SAR')
		const call = calls[0]!
		expect(call.scope).toBe('reports')
		expect(call.options.query).toEqual({ from: '2026-01-01', to: '2026-01-31' })
	})

	it('rejects a malformed response instead of returning it', async () => {
		const { pool } = fakePool({
			'GET /operator/loyalty/members/customer/cus_1': { member: { id: 1 } },
		})
		const client = createLoyaltyClient(pool)

		await expect(client.getCustomerMember('cus_1')).rejects.toThrow()
	})
})

describe('newLoyaltyIdempotencyKey', () => {
	it('builds prefixed unique keys', () => {
		const first = newLoyaltyIdempotencyKey('adjust')
		const second = newLoyaltyIdempotencyKey('adjust')
		expect(first).toMatch(/^lty-adjust-/)
		expect(second).toMatch(/^lty-adjust-/)
		expect(first).not.toBe(second)
	})
})
