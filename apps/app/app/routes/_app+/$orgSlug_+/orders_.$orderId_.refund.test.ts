import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RefundsModule from '#app/utils/restaurant-orders/refunds.server.ts'
import type * as RegionalApi from '#app/utils/restaurant-orders/regional-order-api.server.ts'

const mocks = vi.hoisted(() => ({
	order: [] as string[],
	userId: vi.fn(),
	impersonating: vi.fn(),
	organization: vi.fn(),
	permission: vi.fn(),
	locations: vi.fn(),
	loyaltyGrants: vi.fn(),
	intent: vi.fn(),
	execute: vi.fn(),
}))

vi.mock('@repo/auth', () => ({
	getUserId: async (...args: unknown[]) => {
		mocks.order.push('session')
		return mocks.userId(...args)
	},
	isImpersonating: async (...args: unknown[]) => {
		mocks.order.push('impersonation')
		return mocks.impersonating(...args)
	},
}))
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: async (...args: unknown[]) => {
		mocks.order.push('membership')
		return mocks.organization(...args)
	},
}))
vi.mock('#app/utils/organization/permissions.server.ts', () => ({
	ORG_PERMISSIONS: { UPDATE_ORDER_REFUND_ANY: 'update:order_refund:any' },
	requireUserWithOrganizationPermission: async (...args: unknown[]) => {
		mocks.order.push('permission')
		return mocks.permission(...args)
	},
}))
vi.mock('#app/utils/loyalty/access.server.ts', () => ({
	resolveLoyaltyLocationIds: async (...args: unknown[]) => {
		mocks.order.push('locations')
		return mocks.locations(...args)
	},
	getUserLoyaltyGrants: async (...args: unknown[]) => {
		mocks.order.push('loyalty grant')
		return mocks.loyaltyGrants(...args)
	},
}))
vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof RegionalApi>()),
		requestRestaurantOrderRefundIntent: mocks.intent,
	}),
)
vi.mock(
	'#app/utils/restaurant-orders/refunds.server.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof RefundsModule>()),
		executeRestaurantOrderRefund: mocks.execute,
	}),
)

const { action } = await import('./orders_.$orderId_.refund.ts')
const { RegionalOrderApiError } =
	await import('#app/utils/restaurant-orders/regional-order-api.server.ts')

const INTENT = {
	refundId: 'rf_1',
	orderId: 'ord_1',
	tabPaymentId: null,
	amountCents: 1000,
	currency: 'USD',
	processor: 'connect',
	sessionId: 'cs_1',
	paymentId: null,
	status: 'pending',
	providerRefundId: null,
	createdAt: '2026-11-14T10:00:00.000Z',
	updatedAt: '2026-11-14T10:00:00.000Z',
	replayed: false,
}

function post(
	body: unknown,
	headers: Record<string, string> = { 'Idempotency-Key': 'idem_key_0001' },
	method = 'POST',
) {
	return action({
		request: new Request('https://app.test/acme/orders/ord_1/refund', {
			method,
			headers: { 'Content-Type': 'application/json', ...headers },
			...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
		}),
		params: { orgSlug: 'acme', orderId: 'ord_1' },
		context: {},
	} as never) as Promise<Response>
}

async function outcome(promise: Promise<Response>) {
	try {
		return await promise
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

const VALID = { amountCents: 1000, note: 'Cold food' }

describe('POST /:orgSlug/orders/:orderId/refund guards', () => {
	beforeEach(() => {
		mocks.order = []
		mocks.userId.mockReset().mockResolvedValue('user_1')
		mocks.impersonating.mockReset().mockResolvedValue(false)
		mocks.organization.mockReset().mockResolvedValue({
			id: 'org_1',
			dataRegion: 'us',
			hasProvisionedDb: true,
		})
		mocks.permission.mockReset().mockResolvedValue('user_1')
		mocks.locations.mockReset().mockResolvedValue(null)
		mocks.loyaltyGrants.mockReset().mockResolvedValue([])
		mocks.intent.mockReset().mockResolvedValue(INTENT)
		mocks.execute.mockReset().mockResolvedValue({
			outcome: 'executed',
			refundId: 'rf_1',
			orderId: 'ord_1',
			amountCents: 1000,
			currency: 'USD',
			status: 'succeeded',
			providerRefundId: 're_1',
			failureCode: null,
		})
	})

	it('checks session, membership, the refund permission, impersonation, locations and the loyalty grant in that order', async () => {
		const response = await post(VALID)
		expect(response.status).toBe(200)
		expect(mocks.order).toEqual([
			'session',
			'membership',
			'permission',
			'impersonation',
			'locations',
			'loyalty grant',
		])
		expect(mocks.permission).toHaveBeenCalledWith(
			expect.any(Request),
			'org_1',
			'update:order_refund:any',
		)
		expect(await response.json()).toEqual({
			refund: {
				refundId: 'rf_1',
				orderId: 'ord_1',
				amountCents: 1000,
				currency: 'USD',
				status: 'succeeded',
				failureCode: null,
			},
			replayed: false,
		})
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		expect(mocks.intent).toHaveBeenCalledWith({
			dataRegion: 'us',
			orgId: 'org_1',
			orderId: 'ord_1',
			amountCents: 1000,
			note: 'Cold food',
			idempotencyKey: 'idem_key_0001',
			actor: { origin: 'operator', actorId: 'user_1' },
			loyaltyAccess: { refundLoyalty: false },
		})
	})

	it('sends whether the member holds the loyalty refund grant', async () => {
		mocks.loyaltyGrants.mockResolvedValue([
			'read:loyalty:any',
			'update:loyalty_redemption:any',
		])
		await post(VALID)
		expect(mocks.loyaltyGrants).toHaveBeenCalledWith('user_1', 'org_1')
		expect(mocks.intent.mock.calls[0]![0]).toMatchObject({
			loyaltyAccess: { refundLoyalty: true },
		})
		mocks.intent.mockClear()
		mocks.loyaltyGrants.mockResolvedValue(['read:loyalty:any'])
		await post(VALID)
		expect(mocks.intent.mock.calls[0]![0]).toMatchObject({
			loyaltyAccess: { refundLoyalty: false },
		})
	})

	it('passes the region’s loyalty refusal through and refunds nothing', async () => {
		mocks.intent.mockRejectedValue(
			new RegionalOrderApiError('loyalty_refund_forbidden', 403),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ error: 'loyalty_refund_forbidden' })
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('refuses with 403 when the region cannot confirm the loyalty check', async () => {
		mocks.intent.mockRejectedValue(
			new RegionalOrderApiError('loyalty_check_unsupported', 403),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({
			error: 'loyalty_check_unsupported',
		})
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('refuses a signed-out request with 401 before anything else', async () => {
		mocks.userId.mockResolvedValue(null)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(401)
		expect(mocks.order).toEqual(['session'])
		expect(mocks.intent).not.toHaveBeenCalled()
	})

	it('answers 404 to a non-member (another organization) and never calls the region', async () => {
		mocks.organization.mockRejectedValue(
			new Response('Not Found', { status: 404 }),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(404)
		expect(mocks.permission).not.toHaveBeenCalled()
		expect(mocks.intent).not.toHaveBeenCalled()
	})

	it('refuses a member without the refund permission before anything reaches the region', async () => {
		mocks.permission.mockRejectedValue(
			new Response('Forbidden', { status: 403 }),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(403)
		expect(mocks.impersonating).not.toHaveBeenCalled()
		expect(mocks.intent).not.toHaveBeenCalled()
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('refuses an impersonating admin', async () => {
		mocks.impersonating.mockResolvedValue(true)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ error: 'impersonation_forbidden' })
		expect(mocks.intent).not.toHaveBeenCalled()
	})

	it('sends a location-limited member’s location ids for the region to enforce', async () => {
		mocks.locations.mockResolvedValue(['loc_a', 'loc_b'])
		const response = await post(VALID)
		expect(response.status).toBe(200)
		expect(mocks.intent).toHaveBeenCalledWith(
			expect.objectContaining({
				orgId: 'org_1',
				orderId: 'ord_1',
				locationIds: ['loc_a', 'loc_b'],
			}),
		)
		expect(mocks.execute).toHaveBeenCalled()
	})

	it('leaves the location ids out for a member who reaches every location', async () => {
		await post(VALID)
		expect(mocks.intent.mock.calls[0]![0]).not.toHaveProperty('locationIds')
	})

	it('sends an empty scope as is (the region reaches nothing with it)', async () => {
		mocks.locations.mockResolvedValue([])
		mocks.intent.mockRejectedValue(
			new RegionalOrderApiError('order_not_found', 404),
		)
		const response = await outcome(post(VALID))
		expect(mocks.intent.mock.calls[0]![0]).toMatchObject({ locationIds: [] })
		expect(response.status).toBe(404)
		expect(await response.json()).toEqual({ error: 'order_not_found' })
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('refuses with 403 when the region cannot confirm the location check', async () => {
		mocks.locations.mockResolvedValue(['loc_a'])
		mocks.intent.mockRejectedValue(
			new RegionalOrderApiError('location_scope_unsupported', 403),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({
			error: 'location_scope_unsupported',
		})
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('answers a retryable 503 when an unchecked refund could not be released', async () => {
		mocks.locations.mockResolvedValue(['loc_a'])
		mocks.intent.mockRejectedValue(
			new RegionalOrderApiError('refund_release_failed', 503),
		)
		const response = await outcome(post(VALID))
		expect(response.status).toBe(503)
		expect(await response.json()).toEqual({
			error: 'regional_unavailable',
			retryable: true,
		})
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('needs an Idempotency-Key header', async () => {
		for (const headers of [{}, { 'Idempotency-Key': 'short' }] as Record<
			string,
			string
		>[]) {
			const response = await outcome(post(VALID, headers))
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({
				error: 'idempotency_key_required',
			})
		}
		expect(mocks.intent).not.toHaveBeenCalled()
	})

	it('validates the body without echoing it', async () => {
		for (const body of [
			null,
			{},
			{ amountCents: 1000 },
			{ amountCents: 1000, note: 'ab' },
			{ amountCents: -5, note: 'Cold food' },
			{ amountCents: 10.5, note: 'Cold food' },
			{ full: false, note: 'Cold food' },
			{ amountCents: 1000, note: 'Cold food', guestEmail: 'a@b.test' },
		]) {
			const response = await outcome(post(body))
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({ error: 'invalid_request' })
		}
		expect(mocks.intent).not.toHaveBeenCalled()
	})

	it('is POST only', async () => {
		const response = await outcome(post(null, {}, 'GET'))
		expect(response.status).toBe(405)
		expect(mocks.order).toEqual([])
	})

	it('sends a full refund as `full`', async () => {
		await post({ full: true, note: 'Kitchen closed' })
		expect(mocks.intent).toHaveBeenCalledWith(
			expect.objectContaining({ full: true, note: 'Kitchen closed' }),
		)
		expect(mocks.intent.mock.calls[0]![0]).not.toHaveProperty('amountCents')
	})

	it('answers a replay of a finished refund without running the provider again', async () => {
		mocks.intent.mockResolvedValue({
			...INTENT,
			status: 'succeeded',
			replayed: true,
		})
		const response = await post(VALID)
		expect(await response.json()).toMatchObject({
			refund: { status: 'succeeded' },
			replayed: true,
		})
		expect(mocks.execute).not.toHaveBeenCalled()
	})

	it('reads the refund back when another path finished it meanwhile', async () => {
		mocks.execute.mockResolvedValue({
			outcome: 'not_pending',
			refundId: 'rf_1',
		})
		mocks.intent
			.mockResolvedValueOnce(INTENT)
			.mockResolvedValueOnce({ ...INTENT, status: 'failed', replayed: true })
		const response = await post(VALID)
		expect(await response.json()).toMatchObject({
			refund: { status: 'failed' },
			replayed: false,
		})
		expect(mocks.intent).toHaveBeenCalledTimes(2)
	})
})
