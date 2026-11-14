import type * as AuthModule from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LoyaltyAccess from '#app/utils/loyalty/access.server.ts'
import type * as Permissions from '#app/utils/organization/permissions.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { mockOnboardOrganization } from '#app/utils/payments-mock/onboard.server.ts'
import {
	configureShopCommerceForTests,
	getShopCommerce,
} from '#app/utils/shop.server.ts'
import { consoleError, consoleWarn } from '#tests/setup/setup-test-env.ts'
import type * as RegionalApi from './regional-order-api.server.ts'

type Json = Record<string, any>

/**
 * A stateful fake of the region's refund routes. The real SDKs run against the
 * in-process payment emulator, whose webhooks reach the real App routes; only
 * the region is faked.
 */
const fake = vi.hoisted(() => ({
	refunds: new Map<string, Json>(),
	intents: [] as Json[],
	intentError: null as unknown,
	statuses: [] as Json[],
	statusFailures: 0,
	disputes: [] as Json[],
	payments: [] as Json[],
	pendingReads: [] as Json[],
	pendingError: null as unknown,
	auth: {
		userId: 'user_1' as string | null,
		impersonating: false,
		permitted: true,
		locationIds: null as string[] | null,
		org: null as Json | null,
	},
}))

vi.mock(
	'#app/utils/restaurant-orders/regional-order-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalApi>()
		const final = (row: Json) => row.status !== 'pending'
		return {
			...actual,
			notifyRestaurantOrderPaymentStatus: vi.fn(async (input: Json) => {
				fake.payments.push(input)
			}),
			requestRestaurantOrderRefundIntent: vi.fn(async (input: Json) => {
				fake.intents.push(input)
				if (fake.intentError) throw fake.intentError
				const existing = [...fake.refunds.values()].find(
					(row) =>
						row.orderId === input.orderId &&
						row.idempotencyKey === input.idempotencyKey,
				)
				if (existing) return { ...view(existing), replayed: true }
				const template = [...fake.refunds.values()].find(
					(row) => row.orderId === input.orderId && row.template,
				)
				if (!template)
					throw new actual.RegionalOrderApiError('order_not_found', 404)
				const busy = [...fake.refunds.values()].some(
					(row) =>
						row.orderId === input.orderId &&
						!row.template &&
						row.status === 'pending',
				)
				if (busy) throw new actual.RegionalOrderApiError('refund_pending', 409)
				const refunded = [...fake.refunds.values()]
					.filter(
						(row) =>
							row.orderId === input.orderId &&
							!row.template &&
							row.status !== 'failed',
					)
					.reduce((sum, row) => sum + row.amountCents, 0)
				const refundable = template.paidCents - refunded
				const amountCents = input.full ? refundable : input.amountCents
				if (amountCents > refundable || amountCents <= 0) {
					const error = new actual.RegionalOrderApiError(
						'refund_exceeds_payment',
						409,
					)
					error.refundableCents = refundable
					throw error
				}
				const row = {
					...template,
					template: false,
					refundId: `rf_${fake.refunds.size + 1}`,
					amountCents,
					status: 'pending',
					providerRefundId: null,
					idempotencyKey: input.idempotencyKey,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}
				fake.refunds.set(row.refundId, row)
				return { ...view(row), replayed: false }
			}),
			fetchPendingRestaurantOrderRefunds: vi.fn(async (input: Json) => {
				fake.pendingReads.push(input)
				if (fake.pendingError) throw fake.pendingError
				return [...fake.refunds.values()]
					.filter(
						(row) =>
							!row.template &&
							row.orgId === input.orgId &&
							row.status === 'pending' &&
							(!input.refundId || row.refundId === input.refundId),
					)
					.map(view)
			}),
			reportRestaurantOrderRefundStatus: vi.fn(async (input: Json) => {
				if (fake.statusFailures > 0) {
					fake.statusFailures -= 1
					throw new actual.RegionalOrderApiError('regional_unreachable', 503)
				}
				fake.statuses.push(input)
				const row =
					(input.refundId && fake.refunds.get(input.refundId)) ||
					[...fake.refunds.values()].find(
						(entry) =>
							entry.providerRefundId &&
							entry.providerRefundId === input.providerRefundId,
					)
				if (!row)
					throw new actual.RegionalOrderApiError('refund_not_found', 404)
				if (final(row)) {
					return {
						refundId: row.refundId,
						orderId: row.orderId,
						status: row.status,
						applied: false,
					}
				}
				if (input.providerRefundId)
					row.providerRefundId = input.providerRefundId
				row.status = input.status
				if (input.failureCode) row.failureCode = input.failureCode
				row.updatedAt = new Date().toISOString()
				return {
					refundId: row.refundId,
					orderId: row.orderId,
					status: row.status,
					applied: input.status !== 'pending',
				}
			}),
			reportRestaurantOrderDisputeStatus: vi.fn(async (input: Json) => {
				fake.disputes.push(input)
			}),
		}

		function view(row: Json) {
			return {
				refundId: row.refundId,
				orderId: row.orderId,
				tabPaymentId: null,
				amountCents: row.amountCents,
				currency: row.currency,
				processor: row.processor,
				sessionId: row.sessionId,
				paymentId: row.paymentId ?? null,
				status: row.status,
				providerRefundId: row.providerRefundId ?? null,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			}
		}
	},
)

vi.mock('@repo/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthModule>()
	return {
		...actual,
		getUserId: vi.fn(async () => fake.auth.userId),
		isImpersonating: vi.fn(async () => fake.auth.impersonating),
	}
})
vi.mock('#app/utils/organization/loader.server.ts', () => ({
	requireUserOrganization: vi.fn(async () => fake.auth.org),
}))
vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof Permissions>()
		return {
			...actual,
			requireUserWithOrganizationPermission: vi.fn(async () => {
				if (!fake.auth.permitted) {
					throw new Response('Forbidden', { status: 403 })
				}
				return fake.auth.userId
			}),
		}
	},
)
vi.mock('#app/utils/loyalty/access.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof LoyaltyAccess>()
	return {
		...actual,
		resolveLoyaltyLocationIds: vi.fn(async () => fake.auth.locationIds),
	}
})

const { executeRestaurantOrderRefund, RestaurantOrderRefundError } =
	await import('./refunds.server.ts')
const { reconcileRestaurantOrderRefunds } =
	await import('./refunds-reconcile.server.ts')
const { action: refundAction } =
	await import('#app/routes/_app+/$orgSlug_+/orders_.$orderId_.refund.ts')
const { action: executeAction } =
	await import('#app/routes/resources+/orders.refund-execute.ts')
const { buildRestaurantOrderMetadata, restaurantOrderCheckoutReference } =
	await import('@repo/payments')
const { ENV } = await import('varlock/env')

const env = {
	MOCKS: 'true',
	STRIPE_SECRET_KEY: 'sk_test_***',
	CHECKOUT_SECRET_KEY: '',
	CHECKOUT_WEBHOOK_SECRET: '',
}

let slugCounter = 0
async function createOrg(
	dataRegion: 'us' | 'ksa',
	provider: 'stripe' | 'checkout',
) {
	slugCounter += 1
	const slug = `ord-refund-${Date.now().toString(36)}-${slugCounter}`
	const [org] = await db
		.insert(Organization)
		.values({
			name: 'Acme Grill',
			slug,
			dataRegion,
			sitePublished: true,
			active: true,
			hasProvisionedDb: true,
		})
		.returning()
	expect(
		await mockOnboardOrganization({ orgSlug: slug, provider }),
	).toMatchObject({ ok: true })
	const [fresh] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, org!.id))
	return fresh!
}

type Org = Awaited<ReturnType<typeof createOrg>>

/** A paid online order at the emulator, registered as refundable in the fake region. */
async function paidOrder(
	org: Org,
	processor: 'connect' | 'checkout',
	options: { card?: string; orderId?: string; amountCents?: number } = {},
) {
	const orderId =
		options.orderId ?? `ord_${Math.random().toString(36).slice(2, 10)}`
	const amountCents = options.amountCents ?? 4250
	const currency = processor === 'connect' ? 'usd' : 'sar'
	const reference =
		processor === 'checkout'
			? restaurantOrderCheckoutReference(org.id, orderId)
			: null
	const session = await getShopCommerce().createCheckout({
		processor,
		productName: 'Restaurant order',
		amountCents,
		currency,
		connectAccountId:
			processor === 'connect' ? org.stripeConnectAccountId : null,
		checkoutSubEntityId:
			processor === 'checkout' ? org.checkoutSubEntityId : null,
		successUrl: `https://${org.slug}.sites.test/menu/success?order=${orderId}`,
		cancelUrl: `https://${org.slug}.sites.test/menu`,
		metadata: buildRestaurantOrderMetadata(org.id, orderId),
		reference,
		billingCountry: processor === 'checkout' ? 'SA' : null,
	})
	const emulator = getPaymentsEmulator()
	let paymentId: string
	if (processor === 'connect') {
		await emulator.testing.completeCheckout(session.id, {
			card: options.card ?? '4242424242424242',
		})
		const done = await getShopCommerce().retrieveConnectCheckoutSession(
			session.id,
		)
		paymentId = done.payment_intent as string
	} else {
		const result = (await emulator.testing.completeHostedPayment(session.id, {
			card: options.card ?? '4242424242424242',
		})) as { paymentId: string }
		paymentId = result.paymentId
	}
	fake.refunds.set(`template_${orderId}`, {
		template: true,
		orgId: org.id,
		orderId,
		processor,
		currency: currency.toUpperCase(),
		sessionId: reference ?? session.id,
		paymentId: null,
		paidCents: amountCents,
	})
	return { orderId, sessionId: reference ?? session.id, paymentId, amountCents }
}

/** Book a refund in the fake region as the refund-intent route would. */
async function book(
	orderId: string,
	body: { amountCents?: number; full?: true },
	idempotencyKey = `key_${Math.random().toString(36).slice(2)}`,
) {
	const regional = await import('./regional-order-api.server.ts')
	return regional.requestRestaurantOrderRefundIntent({
		dataRegion: 'us',
		orgId: 'ignored',
		orderId,
		...(body.full
			? { full: true as const }
			: { amountCents: body.amountCents! }),
		note: 'Guest asked',
		idempotencyKey,
		actor: { origin: 'operator', actorId: 'user_1' },
	})
}

function routeRequest(
	org: Org,
	orderId: string,
	body: unknown,
	headers: Record<string, string> = { 'Idempotency-Key': 'idem_key_0001' },
) {
	const url = `https://app.test/${org.slug}/orders/${orderId}/refund`
	return refundAction({
		request: new Request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
		}),
		params: { orgSlug: org.slug, orderId },
		context: {},
	} as never) as Promise<Response>
}

async function stripeRefunds(paymentIntentId: string) {
	return getShopCommerce().listStripeRefundsForPaymentIntent(paymentIntentId)
}

describe('restaurant order provider refunds on the payment emulators', () => {
	beforeEach(async () => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', '')
		consoleError.mockImplementation(() => {})
		consoleWarn.mockImplementation(() => {})
		fake.refunds = new Map()
		fake.intents = []
		fake.intentError = null
		fake.statuses = []
		fake.statusFailures = 0
		fake.disputes = []
		fake.payments = []
		fake.pendingReads = []
		fake.pendingError = null
		fake.auth = {
			userId: 'user_1',
			impersonating: false,
			permitted: true,
			locationIds: null,
			org: null,
		}
		configureShopCommerceForTests(process.env)
		await getPaymentsEmulator().reset()
	})
	afterEach(() => vi.unstubAllEnvs())

	describe('Stripe (destination charges)', () => {
		it('a full refund reverses the transfer and the platform fee and reports succeeded once', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const intent = await book(order.orderId, { full: true })
			const result = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})
			expect(result).toMatchObject({
				outcome: 'executed',
				status: 'succeeded',
				amountCents: 4250,
				providerRefundId: expect.stringMatching(/^re_/),
				failureCode: null,
			})
			const direct = fake.statuses.find(
				(entry) => entry.refundId === intent.refundId,
			)
			expect(direct).toEqual({
				dataRegion: 'us',
				orgId: org.id,
				orderId: order.orderId,
				refundId: intent.refundId,
				processor: 'connect',
				status: 'succeeded',
				providerRefundId: expect.stringMatching(/^re_/),
				amountCents: 4250,
				currency: 'USD',
			})
			const refunds = await stripeRefunds(order.paymentId)
			expect(refunds).toHaveLength(1)
			expect(refunds[0]!.metadata).toEqual({
				type: 'restaurant_order',
				orgId: org.id,
				orderId: order.orderId,
				refundId: intent.refundId,
			})
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			const fee = ledger.feeRefunds.reduce((sum, row) => sum + row.amount, 0)
			expect(fee).toBeGreaterThan(0)
			expect(ledger.reversals.reduce((sum, row) => sum + row.amount, 0)).toBe(
				4250 - fee,
			)

			// Called again (a second kick): the refund is no longer pending.
			expect(
				await executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: intent.refundId,
				}),
			).toEqual({ outcome: 'not_pending', refundId: intent.refundId })
			expect(await stripeRefunds(order.paymentId)).toHaveLength(1)
		})

		it('two partial refunds, one after the other, each refund their amount', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const first = await book(order.orderId, { amountCents: 1000 })
			await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: first.refundId,
			})
			const second = await book(order.orderId, { amountCents: 3250 })
			await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: second.refundId,
			})
			const amounts = (await stripeRefunds(order.paymentId))
				.map((refund) => refund.amount)
				.sort((a, b) => a - b)
			expect(amounts).toEqual([1000, 3250])
			expect(fake.refunds.get(first.refundId)?.status).toBe('succeeded')
			expect(fake.refunds.get(second.refundId)?.status).toBe('succeeded')
		})

		it('run twice at once: one provider refund', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const intent = await book(order.orderId, { full: true })
			const results = await Promise.allSettled([
				executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: intent.refundId,
				}),
				executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: intent.refundId,
				}),
			])
			expect(results.map((entry) => entry.status)).toEqual([
				'fulfilled',
				'fulfilled',
			])
			expect(await stripeRefunds(order.paymentId)).toHaveLength(1)
			expect(fake.refunds.get(intent.refundId)?.status).toBe('succeeded')
			// Neither run reported a failure.
			expect(fake.statuses.map((entry) => entry.status)).not.toContain('failed')
		})

		it('a definitive provider rejection is reported failed with Stripe’s code', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			// Refunded outside Menuza meanwhile: the charge has nothing left.
			await getShopCommerce().createReservationStripeRefund({
				paymentIntentId: order.paymentId,
				amountMinor: 4250,
				idempotencyKey: 'outside_menuza',
				metadata: {},
			})
			const intent = await book(order.orderId, { full: true })
			const result = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})
			expect(result).toMatchObject({
				status: 'failed',
				failureCode: 'charge_already_refunded',
			})
			expect(fake.statuses.at(-1)).toMatchObject({
				refundId: intent.refundId,
				status: 'failed',
				failureCode: 'charge_already_refunded',
			})
			expect(fake.statuses.at(-1)).not.toHaveProperty('providerRefundId')
		})

		it('a transient provider failure leaves the refund pending and reports nothing', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const intent = await book(order.orderId, { full: true })
			const spy = vi
				.spyOn(getShopCommerce(), 'createReservationStripeRefund')
				.mockRejectedValueOnce(
					new Stripe.errors.StripeConnectionError({ message: 'down' } as never),
				)
			const error = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			}).catch((thrown: unknown) => thrown)
			expect(error).toBeInstanceOf(RestaurantOrderRefundError)
			expect(error).toMatchObject({
				code: 'provider_unavailable',
				retryable: true,
			})
			expect(fake.statuses).toEqual([])
			expect(fake.refunds.get(intent.refundId)?.status).toBe('pending')
			spy.mockRestore()
		})

		it('a refund made but never reported is adopted on the next run, never made twice', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const intent = await book(order.orderId, { full: true })
			// The report fails every attempt of the first run.
			fake.statusFailures = 3
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			await expect(
				executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: intent.refundId,
				}),
			).rejects.toMatchObject({ code: 'regional_unavailable', retryable: true })
			expect(fake.refunds.get(intent.refundId)?.status).toBe('pending')
			const create = vi.spyOn(
				getShopCommerce(),
				'createReservationStripeRefund',
			)
			const result = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})
			expect(result).toMatchObject({ status: 'succeeded' })
			expect(create).not.toHaveBeenCalled()
			expect(await stripeRefunds(order.paymentId)).toHaveLength(1)
			create.mockRestore()
		})

		it('5126: pending at once, then the refund webhook reports failed with the reason', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect', {
				card: '4000000000005126',
			})
			const intent = await book(order.orderId, { full: true })
			const result = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})
			expect(result).toMatchObject({
				status: 'pending',
				providerRefundId: expect.stringMatching(/^re_/),
			})
			expect(fake.statuses.at(-1)).toMatchObject({
				status: 'pending',
				providerRefundId:
					result.outcome === 'executed' ? result.providerRefundId : '',
			})
			await getPaymentsEmulator().testing.settleRefund(
				(result as { providerRefundId: string }).providerRefundId,
			)
			const reported = fake.statuses.at(-1)!
			expect(reported).toEqual({
				dataRegion: 'us',
				orgId: org.id,
				orderId: order.orderId,
				refundId: intent.refundId,
				providerRefundId: (result as { providerRefundId: string })
					.providerRefundId,
				processor: 'connect',
				status: 'failed',
				failureCode: 'expired_or_canceled_card',
				amountCents: 4250,
				currency: 'USD',
			})
			expect(fake.refunds.get(intent.refundId)?.status).toBe('failed')

			// A redelivered webhook changes nothing.
			const events = await getPaymentsEmulator().events.list({
				provider: 'stripe',
			})
			const refundEvent = events.find((event) =>
				['refund.failed', 'refund.updated'].includes(event.type),
			)
			expect(refundEvent).toBeDefined()
			const reports = fake.statuses.length
			await getPaymentsEmulator().events.redeliver('stripe', refundEvent!.id)
			expect(fake.statuses).toHaveLength(reports + 1)
			expect(fake.statuses.at(-1)).toEqual(reported)
			expect(fake.refunds.get(intent.refundId)?.status).toBe('failed')
		})

		it('a dispute opens and closes on the order by its payment intent', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect', {
				card: '4000000000000259',
			})
			expect(fake.disputes).toEqual([
				{
					dataRegion: 'us',
					orgId: org.id,
					orderId: order.orderId,
					processor: 'connect',
					status: 'open',
				},
			])
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			await getPaymentsEmulator().testing.closeDispute(
				ledger.disputes[0]!.id as string,
				'lost',
			)
			expect(fake.disputes.at(-1)).toMatchObject({
				orderId: order.orderId,
				status: 'lost',
			})
			for (const entry of fake.disputes) {
				expect(Object.keys(entry).sort()).toEqual([
					'dataRegion',
					'orderId',
					'orgId',
					'processor',
					'status',
				])
			}
		})
	})

	describe('Checkout.com (split payments)', () => {
		it('a full refund is pending at once, reverses the whole commission, and the webhook settles it', async () => {
			const org = await createOrg('ksa', 'checkout')
			const order = await paidOrder(org, 'checkout')
			const intent = await book(order.orderId, { full: true })
			const result = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})
			expect(result).toMatchObject({
				status: 'pending',
				providerRefundId: expect.stringMatching(/^act_/),
			})
			const actionId = (result as { providerRefundId: string }).providerRefundId
			const action = (await getPaymentsEmulator().object(
				'checkout',
				actionId,
			)) as Json
			const payment = (await getPaymentsEmulator().object(
				'checkout',
				order.paymentId,
			)) as Json
			expect(action.reference).toBe(`ror_${intent.refundId}`)
			expect(action.amount_allocations[0].commission.amount).toBe(
				payment.amount_allocations[0].commission.amount,
			)
			await getPaymentsEmulator().testing.settleCheckoutRefund(actionId)
			expect(fake.statuses.at(-1)).toEqual({
				dataRegion: 'ksa',
				orgId: org.id,
				orderId: order.orderId,
				refundId: intent.refundId,
				providerRefundId: actionId,
				processor: 'checkout',
				status: 'succeeded',
				amountCents: 4250,
				currency: 'SAR',
			})
			expect(fake.refunds.get(intent.refundId)?.status).toBe('succeeded')
		})

		it('partial refunds reverse the commission in parts that add up', async () => {
			const org = await createOrg('ksa', 'checkout')
			const order = await paidOrder(org, 'checkout', { amountCents: 3333 })
			for (const amountCents of [1000, 2333]) {
				const intent = await book(order.orderId, { amountCents })
				const result = await executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: intent.refundId,
				})
				await getPaymentsEmulator().testing.settleCheckoutRefund(
					(result as { providerRefundId: string }).providerRefundId,
				)
			}
			const payment = (await getPaymentsEmulator().object(
				'checkout',
				order.paymentId,
			)) as Json
			const actions =
				await getShopCommerce().listReservationCheckoutPaymentActions(
					order.paymentId,
				)
			const reversed = await Promise.all(
				actions
					.filter((action) => action.type === 'Refund')
					.map(async (action) =>
						Number(
							(
								(await getPaymentsEmulator().object(
									'checkout',
									action.id,
								)) as Json
							).amount_allocations[0].commission.amount,
						),
					),
			)
			expect(reversed.reduce((sum, value) => sum + value, 0)).toBe(
				payment.amount_allocations[0].commission.amount,
			)
			expect(payment.balances.total_refunded).toBe(3333)
		})

		it('two approved payments on one reference: the stored payment id picks the right one', async () => {
			const org = await createOrg('ksa', 'checkout')
			const orderId = `ord_${Math.random().toString(36).slice(2, 10)}`
			const first = await paidOrder(org, 'checkout', { orderId })
			const second = await paidOrder(org, 'checkout', { orderId })
			expect(second.paymentId).not.toBe(first.paymentId)
			const template = fake.refunds.get(`template_${orderId}`)!
			const refundsOf = async (paymentId: string) =>
				(
					await getShopCommerce().listReservationCheckoutPaymentActions(
						paymentId,
					)
				).filter((action) => action.type === 'Refund')

			// Without the payment id the reference names two payments: nothing is
			// refunded, the refund fails and its amount is free again.
			const blind = await book(orderId, { full: true })
			expect(
				await executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: blind.refundId,
				}),
			).toMatchObject({ status: 'failed', failureCode: 'payment_not_found' })
			expect(await refundsOf(first.paymentId)).toHaveLength(0)
			expect(await refundsOf(second.paymentId)).toHaveLength(0)

			// With the id the region stored from the paid event, exactly that
			// payment is refunded.
			template.paymentId = first.paymentId
			const named = await book(orderId, { full: true })
			expect(named.paymentId).toBe(first.paymentId)
			expect(
				await executeRestaurantOrderRefund({
					orgId: org.id,
					refundId: named.refundId,
				}),
			).toMatchObject({ status: 'pending' })
			expect(await refundsOf(first.paymentId)).toHaveLength(1)
			expect(await refundsOf(second.paymentId)).toHaveLength(0)
		})

		it('a declined refund is reported failed by the webhook', async () => {
			const org = await createOrg('ksa', 'checkout')
			const order = await paidOrder(org, 'checkout')
			const intent = await book(order.orderId, { full: true })
			const result = (await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: intent.refundId,
			})) as { providerRefundId: string }
			await getPaymentsEmulator().testing.forceCheckoutRefundDecline(
				result.providerRefundId,
			)
			await getPaymentsEmulator().testing.settleCheckoutRefund(
				result.providerRefundId,
			)
			expect(fake.statuses.at(-1)).toMatchObject({
				refundId: intent.refundId,
				providerRefundId: result.providerRefundId,
				status: 'failed',
				failureCode: 'refund_declined',
			})
		})
	})

	describe('operator action POST /:orgSlug/orders/:orderId/refund', () => {
		it('Stripe: books, refunds and answers the refund (no PII)', async () => {
			const org = await createOrg('us', 'stripe')
			fake.auth.org = { id: org.id, dataRegion: 'us', hasProvisionedDb: true }
			const order = await paidOrder(org, 'connect')
			const response = await routeRequest(org, order.orderId, {
				amountCents: 1250,
				note: 'Cold food',
			})
			expect(response.status).toBe(200)
			expect(response.headers.get('Cache-Control')).toBe('private, no-store')
			const body = (await response.json()) as Json
			expect(body).toEqual({
				refund: {
					refundId: expect.any(String),
					orderId: order.orderId,
					amountCents: 1250,
					currency: 'USD',
					status: 'succeeded',
					failureCode: null,
				},
				replayed: false,
			})
			expect(fake.intents[0]).toEqual({
				dataRegion: 'us',
				orgId: org.id,
				orderId: order.orderId,
				amountCents: 1250,
				note: 'Cold food',
				idempotencyKey: 'idem_key_0001',
				actor: { origin: 'operator', actorId: 'user_1' },
			})

			// The same key replays the same refund; nothing more is refunded.
			const replay = await routeRequest(org, order.orderId, {
				amountCents: 1250,
				note: 'Cold food',
			})
			expect(((await replay.json()) as Json).refund.refundId).toBe(
				body.refund.refundId,
			)
			expect(await stripeRefunds(order.paymentId)).toHaveLength(1)
		})

		it('Checkout.com: a full refund answers pending until the provider settles', async () => {
			const org = await createOrg('ksa', 'checkout')
			fake.auth.org = { id: org.id, dataRegion: 'ksa', hasProvisionedDb: true }
			const order = await paidOrder(org, 'checkout')
			const response = await routeRequest(org, order.orderId, {
				full: true,
				note: 'Kitchen closed',
			})
			expect(response.status).toBe(200)
			expect(((await response.json()) as Json).refund).toMatchObject({
				amountCents: 4250,
				currency: 'SAR',
				status: 'pending',
			})
		})

		it('a failed refund can be retried with a new key, as a new refund', async () => {
			const org = await createOrg('us', 'stripe')
			fake.auth.org = { id: org.id, dataRegion: 'us', hasProvisionedDb: true }
			const order = await paidOrder(org, 'connect')
			const spy = vi
				.spyOn(getShopCommerce(), 'createReservationStripeRefund')
				.mockResolvedValueOnce({
					status: 'failed',
					refundRef: null,
					amountMinor: 4250,
					failureCode: 'charge_disputed',
				})
			const failed = (await (
				await routeRequest(org, order.orderId, {
					full: true,
					note: 'Duplicate',
				})
			).json()) as Json
			expect(failed.refund).toMatchObject({
				status: 'failed',
				failureCode: 'charge_disputed',
			})
			spy.mockRestore()
			const retried = (await (
				await routeRequest(
					org,
					order.orderId,
					{ full: true, note: 'Duplicate' },
					{ 'Idempotency-Key': 'idem_key_0002' },
				)
			).json()) as Json
			expect(retried.refund).toMatchObject({ status: 'succeeded' })
			expect(retried.refund.refundId).not.toBe(failed.refund.refundId)
		})

		it('a transient provider failure answers 202 with the refund still pending', async () => {
			const org = await createOrg('us', 'stripe')
			fake.auth.org = { id: org.id, dataRegion: 'us', hasProvisionedDb: true }
			const order = await paidOrder(org, 'connect')
			const spy = vi
				.spyOn(getShopCommerce(), 'createReservationStripeRefund')
				.mockRejectedValueOnce(
					new Stripe.errors.StripeAPIError({ message: 'down' } as never),
				)
			const response = await routeRequest(org, order.orderId, {
				full: true,
				note: 'Guest asked',
			})
			expect(response.status).toBe(202)
			expect(await response.json()).toMatchObject({
				refund: { status: 'pending' },
				delayed: true,
			})
			spy.mockRestore()
		})

		it('passes the region’s refusals through with their codes', async () => {
			const org = await createOrg('us', 'stripe')
			fake.auth.org = { id: org.id, dataRegion: 'us', hasProvisionedDb: true }
			const order = await paidOrder(org, 'connect')
			const over = await routeRequest(org, order.orderId, {
				amountCents: 9999,
				note: 'Too much',
			})
			expect(over.status).toBe(409)
			expect(await over.json()).toEqual({
				error: 'refund_exceeds_payment',
				refundableCents: 4250,
			})

			const regional = await import('./regional-order-api.server.ts')
			for (const [code, status] of [
				['refund_pending', 409],
				['payment_disputed', 409],
				['order_not_refundable', 409],
				['idempotency_conflict', 409],
			] as const) {
				fake.intentError = new regional.RegionalOrderApiError(code, status)
				const response = await routeRequest(org, order.orderId, {
					full: true,
					note: 'Guest asked',
				})
				expect(response.status).toBe(status)
				expect(await response.json()).toEqual({ error: code })
			}
			fake.intentError = new regional.RegionalOrderApiError(
				'order_not_found',
				404,
			)
			expect(
				(await routeRequest(org, 'ord_x', { full: true, note: 'abc' })).status,
			).toBe(404)
			fake.intentError = new regional.RegionalOrderApiError(
				'regional_unreachable',
				503,
			)
			const down = await routeRequest(org, order.orderId, {
				full: true,
				note: 'abc',
			})
			expect(down.status).toBe(503)
			expect(await down.json()).toEqual({
				error: 'regional_unavailable',
				retryable: true,
			})
			expect(await stripeRefunds(order.paymentId)).toHaveLength(0)
		})
	})

	describe('internal route POST /resources/orders/refund-execute', () => {
		function execute(body: unknown, authorized = true) {
			const url = 'http://localhost:3001/resources/orders/refund-execute'
			return executeAction({
				request: new Request(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(authorized
							? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
							: { Authorization: 'Bearer wrong-token-wrong-token' }),
					},
					body: JSON.stringify(body),
				}),
				params: {},
				context: {},
			} as never) as Promise<Response>
		}

		it('needs the internal token and a strict ids-only body', async () => {
			const org = await createOrg('us', 'stripe')
			expect(
				(await execute({ orgId: org.id, refundId: 'rf_1' }, false)).status,
			).toBe(401)
			expect(
				(await execute({ orgId: org.id, refundId: 'rf_1', amountCents: 1 }))
					.status,
			).toBe(400)
			expect(fake.pendingReads).toEqual([])
		})

		it('executes a refund the region booked; a repeated kick refunds nothing more', async () => {
			const org = await createOrg('us', 'stripe')
			const order = await paidOrder(org, 'connect')
			const intent = await book(order.orderId, { full: true })
			const first = await execute({ orgId: org.id, refundId: intent.refundId })
			expect(first.status).toBe(200)
			expect(await first.json()).toEqual({
				refundId: intent.refundId,
				status: 'succeeded',
			})
			const again = await execute({ orgId: org.id, refundId: intent.refundId })
			expect(await again.json()).toEqual({
				refundId: intent.refundId,
				status: 'not_pending',
			})
			expect(await stripeRefunds(order.paymentId)).toHaveLength(1)
		})

		it('answers 503 retryable when the region cannot be read', async () => {
			const org = await createOrg('us', 'stripe')
			const regional = await import('./regional-order-api.server.ts')
			fake.pendingError = new regional.RegionalOrderApiError(
				'regional_unreachable',
				503,
			)
			const response = await execute({ orgId: org.id, refundId: 'rf_1' })
			expect(response.status).toBe(503)
			expect(await response.json()).toEqual({
				error: 'regional_unavailable',
				retryable: true,
			})
		})
	})

	describe('reconcile', () => {
		it('executes unsent refunds and reads back stale sent ones; fresh ones wait', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const unsent = await paidOrder(org, 'connect')
			const unsentIntent = await book(unsent.orderId, { full: true })
			const fresh = await paidOrder(org, 'connect')
			const freshIntent = await book(fresh.orderId, { full: true })
			const slow = await paidOrder(org, 'connect', { card: '4000000000007726' })
			const slowIntent = await book(slow.orderId, { full: true })
			const sent = await executeRestaurantOrderRefund({
				orgId: org.id,
				refundId: slowIntent.refundId,
			})
			expect(sent).toMatchObject({ status: 'pending' })
			await getPaymentsEmulator().testing.settleRefund(
				(sent as { providerRefundId: string }).providerRefundId,
				'succeeded',
			)
			// Manual webhooks: nobody told the region.
			expect(fake.refunds.get(slowIntent.refundId)?.status).toBe('pending')

			const now = Date.now()
			fake.refunds.get(unsentIntent.refundId)!.updatedAt = new Date(
				now - 5 * 60_000,
			).toISOString()
			fake.refunds.get(slowIntent.refundId)!.updatedAt = new Date(
				now - 20 * 60_000,
			).toISOString()

			const summary = await reconcileRestaurantOrderRefunds(now)
			expect(summary).toMatchObject({
				refundsChecked: 2,
				refundsExecuted: 1,
				refundsReported: 2,
				skipped: 0,
				failedOrganizations: 0,
			})
			expect(fake.refunds.get(unsentIntent.refundId)?.status).toBe('succeeded')
			expect(fake.refunds.get(slowIntent.refundId)?.status).toBe('succeeded')
			expect(fake.refunds.get(freshIntent.refundId)?.status).toBe('pending')
			expect(await stripeRefunds(fresh.paymentId)).toHaveLength(0)
			expect(await stripeRefunds(slow.paymentId)).toHaveLength(1)
		})

		it('a region without the route (404) is skipped, not failed', async () => {
			await createOrg('us', 'stripe')
			const regional = await import('./regional-order-api.server.ts')
			fake.pendingError = new regional.RegionalOrderApiError('http_404', 404)
			const summary = await reconcileRestaurantOrderRefunds()
			expect(summary.failedOrganizations).toBe(0)
		})
	})
})
