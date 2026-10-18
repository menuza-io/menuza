import { db, eq, Organization } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { mockOnboardOrganization } from '#app/utils/payments-mock/onboard.server.ts'
import { configureShopCommerceForTests } from '#app/utils/shop.server.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { reconcileReservationPayments } from './payments-reconcile.server.ts'
import {
	chargeReservationFee,
	createReservationHostedCheckout,
	executeReservationPaymentCommand,
	getReservationPaymentStatus,
	handleLateRefund,
	ReservationPaymentError,
	resolveReservationOnlinePayment,
} from './payments.server.ts'
import type * as RegionalApi from './regional-payments-api.server.ts'

type Json = Record<string, any>

// A stateful fake of the regional payment endpoints. The real SDKs run against
// the in-process emulator; only the region is faked.
const fake = vi.hoisted(() => {
	const state = {
		quote: {} as Json,
		/** One-shot quotes returned before the live one (a stale read). */
		quoteQueue: [] as Json[],
		binds: [] as Json[],
		statuses: [] as Json[],
		feeResults: [] as Json[],
		refundResults: [] as Json[],
		disputes: [] as Json[],
		quoteError: null as unknown,
		bindError: null as unknown,
		statusError: null as unknown,
		statusResponse: null as null | ((input: Json) => Json),
		claim: null as null | Json,
		claimError: null as unknown,
		feeResultFailures: 0,
		refundClaims: [] as Json[],
		pending: new Map<string, Json | Error>(),
		flagOn: true,
		platformFeeBp: 150,
	}
	return state
})

vi.mock(
	'#app/utils/reservations/regional-payments-api.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof RegionalApi>()
		return {
			...actual,
			fetchReservationPaymentQuote: vi.fn(async () => {
				if (fake.quoteError) throw fake.quoteError
				const queued = fake.quoteQueue.shift()
				return structuredClone(queued ?? fake.quote)
			}),
			bindReservationPaymentSession: vi.fn(async (input: Json) => {
				if (fake.bindError) throw fake.bindError
				if (fake.quote.boundSession) {
					throw new actual.RegionalPaymentsApiError('already_bound', 409)
				}
				fake.binds.push(input)
				fake.quote.boundSession = {
					sessionId: input.sessionId,
					processor: input.processor,
				}
			}),
			notifyReservationPaymentStatus: vi.fn(async (input: Json) => {
				if (fake.statusError) throw fake.statusError
				const duplicate = fake.statuses.some(
					(entry) =>
						entry.sessionId === input.sessionId &&
						entry.status === input.status,
				)
				fake.statuses.push(input)
				if (fake.statusResponse) return fake.statusResponse(input)
				if (input.status === 'paid') fake.quote.paymentStatus = 'paid'
				if (input.status === 'setup_succeeded') {
					fake.quote.paymentStatus = 'guaranteed'
				}
				return { outcome: duplicate ? 'duplicate' : 'recorded' }
			}),
			claimReservationFee: vi.fn(async () => {
				if (fake.claimError) throw fake.claimError
				return structuredClone(fake.claim)
			}),
			reportReservationFeeResult: vi.fn(async (input: Json) => {
				if (fake.feeResultFailures > 0) {
					fake.feeResultFailures -= 1
					throw new actual.RegionalPaymentsApiError('regional_unreachable', 503)
				}
				fake.feeResults.push(input)
			}),
			claimReservationRefunds: vi.fn(async (input: Json) =>
				structuredClone(
					fake.refundClaims.filter(
						(claim) =>
							!input.refundRequestId ||
							claim.refundRequestId === input.refundRequestId,
					),
				),
			),
			reportReservationRefundResult: vi.fn(async (input: Json) => {
				fake.refundResults.push(input)
			}),
			reportReservationDispute: vi.fn(async (input: Json) => {
				fake.disputes.push(input)
			}),
			fetchPendingReservationPayments: vi.fn(async (input: Json) => {
				const entry = fake.pending.get(input.orgId)
				if (entry instanceof Error) throw entry
				return entry ?? { sessions: [], refunds: [] }
			}),
		}
	},
)

vi.mock('#app/utils/reservations/platform-fee.server.ts', () => ({
	resolveReservationPlatformFeeBp: vi.fn(async () => fake.platformFeeBp),
}))

vi.mock('#app/utils/reservations/access.server.ts', () => ({
	isReservationsFeatureEnabled: vi.fn(async () => fake.flagOn),
	notifyReservationsContextChanged: vi.fn(async () => undefined),
}))

const { RegionalPaymentsApiError } =
	await import('./regional-payments-api.server.ts')

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
	const slug = `rsv-pay-${Date.now().toString(36)}-${slugCounter}`
	const [org] = await db
		.insert(Organization)
		.values({
			name: 'Acme Grill & Bar',
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

function iso(offsetMs: number) {
	return new Date(Date.now() + offsetMs).toISOString()
}

function setQuote(orgOverrides: Json = {}, overrides: Json = {}) {
	fake.quote = {
		purpose: 'deposit',
		mode: 'payment',
		reservationId: 'rsv_1',
		locationId: 'loc_1',
		feeId: null,
		feeKind: null,
		amountMinor: 3333,
		currency: 'USD',
		quantity: 1,
		unitAmountMinor: null,
		expiresAt: iso(20 * 60_000),
		now: iso(0),
		reservationStatus: 'pending_payment',
		paymentStatus: 'pending',
		locale: 'en',
		boundSession: null,
		providerCustomerRef: null,
		guestRef: 'guest_ref_abcdef',
		productLabel: null,
		policy: {
			kind: 'deposit',
			unitMinor: 3333,
			partySize: 2,
			capMinor: null,
			freeCancelUntilMin: 1440,
			termsVersion: 1,
		},
		consent: null,
		...orgOverrides,
		...overrides,
	}
}

const GUARANTEE_QUOTE = {
	purpose: 'guarantee',
	mode: 'setup',
	amountMinor: 0,
	consent: {
		capMinor: 5000,
		noShowFeeMinor: 2500,
		lateCancelFeeMinor: 1500,
		freeCancelUntilMin: 1440,
		timeZone: 'America/New_York',
		startAtIso: '2026-10-20T23:00:00.000Z',
	},
}

function request(
	org: { slug: string },
	overrides: Json = {},
): Parameters<typeof createReservationHostedCheckout>[0] {
	return {
		slug: org.slug,
		reservationId: 'rsv_1',
		paymentToken: 'tok_single_use_secret',
		purpose: 'deposit',
		...overrides,
	}
}

async function bodyOf(thrown: unknown) {
	expect(thrown).toBeInstanceOf(Response)
	const response = thrown as Response
	return { status: response.status, ...((await response.json()) as Json) }
}

async function failure(promise: Promise<unknown>) {
	return bodyOf(await promise.catch((error) => error))
}

describe('reservation payments bridge on the payment emulators', () => {
	beforeEach(async () => {
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
		vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', '')
		consoleError.mockImplementation(() => {})
		fake.binds = []
		fake.statuses = []
		fake.feeResults = []
		fake.refundResults = []
		fake.disputes = []
		fake.quoteError = null
		fake.quoteQueue = []
		fake.bindError = null
		fake.statusError = null
		fake.statusResponse = null
		fake.claim = null
		fake.claimError = null
		fake.feeResultFailures = 0
		fake.refundClaims = []
		fake.pending = new Map()
		fake.flagOn = true
		fake.platformFeeBp = 150
		configureShopCommerceForTests(process.env)
		await getPaymentsEmulator().reset()
		setQuote()
	})
	afterEach(() => vi.unstubAllEnvs())

	describe('online payment gate (VAL-PAY-005)', () => {
		const base = {
			dataRegion: 'us',
			shopPaymentProvider: 'stripe',
			stripeConnectAccountId: 'acct_1',
			stripeConnectChargesEnabled: true,
			checkoutSubEntityId: null,
			checkoutChargesEnabled: false,
		}

		it('Connect deposits and guarantees need a charges-enabled account and a Stripe currency', () => {
			expect(resolveReservationOnlinePayment(base, 'USD')).toMatchObject({
				enabled: true,
				processor: 'connect',
				regionalProcessor: 'stripe',
				deposit: true,
				guarantee: true,
			})
			expect(resolveReservationOnlinePayment(base, 'CAD').deposit).toBe(true)
			// SAR is never sent to Stripe.
			expect(resolveReservationOnlinePayment(base, 'SAR')).toMatchObject({
				enabled: true,
				currencySupported: false,
				deposit: false,
				guarantee: false,
			})
			expect(
				resolveReservationOnlinePayment(
					{ ...base, stripeConnectChargesEnabled: false },
					'USD',
				),
			).toMatchObject({ enabled: false, processor: null, deposit: false })
			// Connect fails closed outside the US.
			expect(
				resolveReservationOnlinePayment({ ...base, dataRegion: 'ksa' }, 'USD')
					.enabled,
			).toBe(false)
		})

		it('Checkout.com needs an enabled sub-entity; guarantees follow the configured processor', () => {
			const ksa = {
				dataRegion: 'ksa',
				shopPaymentProvider: 'checkout',
				stripeConnectAccountId: null,
				stripeConnectChargesEnabled: false,
				checkoutSubEntityId: 'ent_1',
				checkoutChargesEnabled: true,
			}
			expect(resolveReservationOnlinePayment(ksa, 'SAR')).toMatchObject({
				enabled: true,
				processor: 'checkout',
				regionalProcessor: 'checkout',
				deposit: true,
				guarantee: true,
			})
			expect(
				resolveReservationOnlinePayment(ksa, 'SAR', {
					isProcessorConfigured: () => false,
				}),
			).toMatchObject({ deposit: true, guarantee: false })
			expect(
				resolveReservationOnlinePayment(
					{ ...ksa, checkoutChargesEnabled: false },
					'SAR',
				).enabled,
			).toBe(false)
			expect(resolveReservationOnlinePayment(ksa, 'CAD').deposit).toBe(false)
		})
	})

	describe('Stripe deposit checkout (VAL-PAY-005..007)', () => {
		it('creates the destination charge from the quote, then binds once with the fee snapshot', async () => {
			const org = await createOrg('us', 'stripe')
			setQuote({}, { quantity: 1 })
			const result = await createReservationHostedCheckout(request(org))

			expect(result).toMatchObject({
				processor: 'connect',
				purpose: 'deposit',
				mode: 'payment',
			})
			expect(result.checkoutUrl).toContain(
				'/mock-payments/stripe/checkout/cs_test_',
			)
			// Quote -> create -> bind: one bind, the Stripe session id, the fee
			// floor(3333 * 150 / 10000) = 49 and the bp that produced it.
			expect(fake.binds).toEqual([
				{
					dataRegion: 'us',
					orgId: org.id,
					reservationId: 'rsv_1',
					purpose: 'deposit',
					sessionId: result.sessionId,
					processor: 'stripe',
					platformFeeBp: 150,
					platformFeeMinor: 49,
				},
			])

			const session = await getPaymentsEmulator().pages.stripe.describeSession(
				result.sessionId,
			)
			expect(JSON.stringify(session)).not.toContain('tok_single_use_secret')
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const stored = await commerce.retrieveReservationStripeSession(
				result.sessionId,
			)
			expect(stored.metadata).toEqual({
				type: 'reservation_payment',
				orgId: org.id,
				reservationId: 'rsv_1',
				purpose: 'deposit',
			})
			expect(stored.amount_total).toBe(3333)
			expect(stored.success_url).toContain(
				'/reserve/pay/done?r=rsv_1&purpose=deposit',
			)
			expect(stored.cancel_url).toContain('/reserve/pay#r=rsv_1')
			expect(stored.success_url).not.toContain('tok_')
			expect(stored.customer_email ?? null).toBeNull()
		})

		it('paying delivers a signed webhook to the real route: status paid with the intent, and the ledger holds the fee (VAL-PAY-006)', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			const emulator = getPaymentsEmulator()
			expect(
				(await emulator.testing.completeCheckout(result.sessionId)).status,
			).toBe('paid')
			expect(fake.statuses).toHaveLength(1)
			expect(fake.statuses[0]).toMatchObject({
				orgId: org.id,
				reservationId: 'rsv_1',
				purpose: 'deposit',
				sessionId: result.sessionId,
				processor: 'stripe',
				status: 'paid',
				amountMinor: 3333,
				currency: 'USD',
				paymentRef: expect.stringMatching(/^pi_/),
			})
			const ledger = await emulator.pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			expect(ledger.applicationFees[0]).toMatchObject({ amount: 49 })
			expect(ledger.transfers[0]).toMatchObject({ amount: 3333 - 49 })
			// No guest data in anything reported.
			expect(JSON.stringify(fake.statuses)).not.toMatch(
				/email|name|phone|tok_single/i,
			)
		})

		it('at 0 bp no application fee is sent; a per-cover quote prices by covers', async () => {
			fake.platformFeeBp = 0
			const org = await createOrg('us', 'stripe')
			setQuote({}, { amountMinor: 6000, quantity: 4, unitAmountMinor: 1500 })
			const result = await createReservationHostedCheckout(request(org))
			expect(fake.binds[0]).toMatchObject({
				platformFeeBp: 0,
				platformFeeMinor: 0,
			})
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId)
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			expect(ledger.applicationFees).toHaveLength(0)
			expect(ledger.transfers[0]).toMatchObject({ amount: 6000 })
		})

		it('a replay of a bound open session serves the same URL and creates nothing new (VAL-PAY-007)', async () => {
			const org = await createOrg('us', 'stripe')
			const first = await createReservationHostedCheckout(request(org))
			const again = await createReservationHostedCheckout(request(org))
			expect(again).toMatchObject({
				checkoutUrl: first.checkoutUrl,
				sessionId: first.sessionId,
			})
			expect(fake.binds).toHaveLength(1)
		})

		it('a lost bind race keeps a shared session that won, so the winner is never expired', async () => {
			const org = await createOrg('us', 'stripe')
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const first = await createReservationHostedCheckout(request(org))
			// A concurrent request read the quote before the bind and derives the
			// same deterministic key, so it holds the same session.
			fake.quoteQueue = [{ ...structuredClone(fake.quote), boundSession: null }]
			const second = await createReservationHostedCheckout(request(org))
			expect(second.sessionId).toBe(first.sessionId)
			expect(
				(await commerce.retrieveReservationStripeSession(first.sessionId))
					.status,
			).toBe('open')
			expect(fake.binds).toHaveLength(1)
		})

		it('a lost bind race expires the unbound session and serves the winner', async () => {
			const org = await createOrg('us', 'stripe')
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const first = await createReservationHostedCheckout(request(org))
			const created: Array<{ id: string }> = []
			const original = commerce.createReservationStripeSession.bind(commerce)
			const spy = vi
				.spyOn(commerce, 'createReservationStripeSession')
				.mockImplementation(async (options) => {
					const session = await original(options)
					created.push(session)
					return session
				})
			// A different hold deadline gives this request a session of its own.
			fake.quoteQueue = [
				{
					...structuredClone(fake.quote),
					boundSession: null,
					expiresAt: iso(25 * 60_000),
				},
			]
			const second = await createReservationHostedCheckout(request(org))
			spy.mockRestore()
			expect(created).toHaveLength(1)
			expect(created[0]!.id).not.toBe(first.sessionId)
			expect(second.sessionId).toBe(first.sessionId)
			expect(
				(await commerce.retrieveReservationStripeSession(created[0]!.id))
					.status,
			).toBe('expired')
			expect(
				(await commerce.retrieveReservationStripeSession(first.sessionId))
					.status,
			).toBe('open')
		})

		it('a bind refused as hold_expired or payment_terminal closes the session and answers clearly', async () => {
			const org = await createOrg('us', 'stripe')
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const created: Array<{ id: string }> = []
			const original = commerce.createReservationStripeSession.bind(commerce)
			const spy = vi
				.spyOn(commerce, 'createReservationStripeSession')
				.mockImplementation(async (options) => {
					const session = await original(options)
					created.push(session)
					return session
				})
			fake.bindError = new RegionalPaymentsApiError('hold_expired', 409)
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 409,
				error: 'hold_expired',
			})
			fake.bindError = new RegionalPaymentsApiError('payment_terminal', 409)
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 409,
				error: 'already_paid',
			})
			spy.mockRestore()
			// Nothing stays payable: every unbound session was expired.
			expect(created.length).toBeGreaterThanOrEqual(1)
			for (const session of created) {
				expect(
					(await commerce.retrieveReservationStripeSession(session.id)).status,
				).toBe('expired')
			}
		})

		it('rejects what is not payable without calling the provider', async () => {
			const org = await createOrg('us', 'stripe')
			const eventsBefore = (
				await getPaymentsEmulator().events.list({ provider: 'stripe' })
			).length
			const cases: Array<[Json, string, number]> = [
				[{ paymentStatus: 'paid' }, 'already_paid', 409],
				[{ paymentStatus: 'guaranteed' }, 'already_paid', 409],
				[{ paymentStatus: 'refunded' }, 'payment_not_payable', 409],
				[{ reservationStatus: 'cancelled' }, 'reservation_not_payable', 409],
				[{ expiresAt: iso(-1000), now: iso(0) }, 'hold_expired', 409],
				[{ purpose: 'prepay' }, 'purpose_mismatch', 409],
			]
			for (const [overrides, error, status] of cases) {
				setQuote({}, overrides)
				expect(
					await failure(createReservationHostedCheckout(request(org))),
				).toMatchObject({
					status,
					error,
				})
			}
			expect(fake.binds).toHaveLength(0)
			expect(
				await getPaymentsEmulator().events.list({ provider: 'stripe' }),
			).toHaveLength(eventsBefore)
		})

		it('gates on the payments flag, the processor account and the quote currency', async () => {
			const org = await createOrg('us', 'stripe')
			fake.flagOn = false
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				error: 'online_payment_unavailable',
			})
			fake.flagOn = true
			setQuote({}, { currency: 'SAR' })
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				error: 'online_payment_unavailable',
			})
			setQuote()
			await db
				.update(Organization)
				.set({ stripeConnectChargesEnabled: false })
				.where(eq(Organization.id, org.id))
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				error: 'online_payment_unavailable',
			})
			expect(
				await failure(
					createReservationHostedCheckout(request({ slug: 'no-such-org' })),
				),
			).toMatchObject({ status: 404, error: 'organization_not_found' })
		})

		it('maps regional quote failures to stable codes (a bad token never reaches a provider)', async () => {
			const org = await createOrg('us', 'stripe')
			const eventsBefore = (
				await getPaymentsEmulator().events.list({ provider: 'stripe' })
			).length
			fake.quoteError = new RegionalPaymentsApiError(
				'invalid_payment_token',
				404,
			)
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 404,
				error: 'payment_not_found',
			})
			fake.quoteError = new RegionalPaymentsApiError(
				'regional_unreachable',
				503,
			)
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 503,
				error: 'regional_unavailable',
				retryable: true,
			})
			fake.quoteError = new RegionalPaymentsApiError('org_mismatch', 409)
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 409,
				error: 'payment_not_payable',
			})
			expect(
				await getPaymentsEmulator().events.list({ provider: 'stripe' }),
			).toHaveLength(eventsBefore)
		})

		it('return URLs carry the locale path and opaque ids only', async () => {
			const org = await createOrg('us', 'stripe')
			await db
				.update(Organization)
				.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
				.where(eq(Organization.id, org.id))
			const result = await createReservationHostedCheckout(
				request(org, { locale: 'ar' }),
			)
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const session = await commerce.retrieveReservationStripeSession(
				result.sessionId,
			)
			expect(session.success_url).toContain('/ar/reserve/pay/done?r=rsv_1')
			expect(session.cancel_url).toContain('/ar/reserve/pay#r=rsv_1')
		})
	})

	describe('Stripe card guarantee (VAL-PAY-008)', () => {
		beforeEach(() => setQuote({}, GUARANTEE_QUOTE))

		it('creates a setup session for a PII-free Customer and binds the customer ref', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			expect(result).toMatchObject({ purpose: 'guarantee', mode: 'setup' })
			expect(fake.binds[0]).toMatchObject({
				purpose: 'guarantee',
				processor: 'stripe',
				providerCustomerRef: expect.stringMatching(/^cus_/),
				platformFeeMinor: 0,
			})
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const session = await commerce.retrieveReservationStripeSession(
				result.sessionId,
			)
			expect(session.mode).toBe('setup')
			expect(session.customer).toBe(fake.binds[0]!.providerCustomerRef)
			expect(session.custom_text?.submit?.message).toContain('$25.00')
			const stripe = await getPaymentsEmulator().pages.stripe.describeSession(
				result.sessionId,
			)
			expect(stripe).toBeTruthy()
		})

		it('3155 passes 3DS and the webhook reports setup_succeeded with the saved card facts', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			const done = await getPaymentsEmulator().testing.completeCheckout(
				result.sessionId,
				{ card: '4000002500003155' },
			)
			expect(done.status).toBe('saved')
			expect(fake.statuses.at(-1)).toMatchObject({
				purpose: 'guarantee',
				status: 'setup_succeeded',
				amountMinor: 0,
				currency: 'USD',
				providerCustomerRef: fake.binds[0]!.providerCustomerRef,
				paymentMethodRef: expect.stringMatching(/^pm_/),
				card: { brand: 'visa', last4: '3155' },
			})
		})

		it('9995 fails the setup: nothing is reported', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			const done = await getPaymentsEmulator().testing.completeCheckout(
				result.sessionId,
				{ card: '4000000000009995' },
			)
			expect(done.status).toBe('declined')
			expect(fake.statuses).toHaveLength(0)
		})
	})

	describe('status poll, webhooks and late payments (VAL-PAY-006, VAL-PAY-015)', () => {
		it('manual webhooks: the poll does the trusted lookup and pushes; the late webhook is a duplicate', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId)
			expect(fake.statuses).toHaveLength(0)

			const status = await getReservationPaymentStatus(request(org))
			expect(status).toMatchObject({
				paymentStatus: 'paid',
				processor: 'connect',
				purpose: 'deposit',
			})
			expect(fake.statuses).toHaveLength(1)
			const flush = await getPaymentsEmulator().events.flush()
			expect(flush.delivered).toBeGreaterThan(0)
			// The webhook repeats the same status; the region answers duplicate.
			expect(
				fake.statuses.filter((entry) => entry.status === 'paid'),
			).toHaveLength(2)
		})

		it('a pending session pushes nothing; an expired one reports expired', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			expect(await getReservationPaymentStatus(request(org))).toMatchObject({
				paymentStatus: 'pending',
			})
			expect(fake.statuses).toHaveLength(0)
			await getPaymentsEmulator().testing.expireSession(result.sessionId)
			await getReservationPaymentStatus(request(org))
			expect(fake.statuses.at(-1)).toMatchObject({ status: 'expired' })
		})

		it('a transient provider or regional failure keeps the last state and never throws terminal', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId)
			fake.statusError = new RegionalPaymentsApiError(
				'regional_unreachable',
				503,
			)
			const status = await getReservationPaymentStatus(request(org))
			expect(status.paymentStatus).toBe('pending')
		})

		it('the poll refuses a session whose metadata names another payment', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId)
			// The region now binds this session to a different reservation.
			fake.quote.reservationId = 'rsv_other'
			await getReservationPaymentStatus(
				request(org, { reservationId: 'rsv_other' }),
			)
			expect(fake.statuses).toHaveLength(0)
		})

		it('a late payment that no longer fits is refunded in full at once and reported (VAL-PAY-015)', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId)
			fake.statusResponse = (input) => ({
				outcome: 'refund_required',
				refund: {
					reservationId: input.reservationId,
					paymentRef: input.paymentRef,
					processor: 'stripe',
					amountMinor: input.amountMinor,
					currency: input.currency,
					paymentAmountMinor: input.amountMinor,
					platformFeeMinor: 49,
					refundedBeforeMinor: 0,
					feeReversedBeforeMinor: 0,
					feeReversalMinor: 49,
				},
			})
			await getReservationPaymentStatus(request(org))
			const paymentRef = fake.statuses[0]!.paymentRef
			expect(fake.refundResults).toEqual([
				{
					dataRegion: 'us',
					orgId: org.id,
					reservationId: 'rsv_1',
					paymentRef,
					reason: 'late_payment',
					refundRef: expect.stringMatching(/^re_/),
					amountMinor: 3333,
					status: 'succeeded',
				},
			])
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			expect(ledger.charges[0]).toMatchObject({
				amount_refunded: 3333,
				refunded: true,
			})
			expect(ledger.applicationFees[0]).toMatchObject({ amount_refunded: 49 })
			// The same key replays the same refund, no second one.
			const replay = await handleLateRefund({
				orgId: org.id,
				dataRegion: 'us',
				directive: fake.statusResponse(fake.statuses[0]!).refund,
			})
			expect(replay.refundRef).toBe(fake.refundResults[0]!.refundRef)
		})

		it('when the late refund cannot be made, failed is reported so the region can review', async () => {
			const org = await createOrg('us', 'stripe')
			const execution = await handleLateRefund({
				orgId: org.id,
				dataRegion: 'us',
				directive: {
					reservationId: 'rsv_1',
					paymentRef: 'pi_missing',
					processor: 'stripe',
					amountMinor: 3333,
					currency: 'USD',
					paymentAmountMinor: 3333,
					platformFeeMinor: 0,
					refundedBeforeMinor: 0,
					feeReversedBeforeMinor: 0,
					feeReversalMinor: 0,
				},
			})
			expect(execution.status).toBe('failed')
			expect(fake.refundResults[0]).toMatchObject({
				reason: 'late_payment',
				paymentRef: 'pi_missing',
				status: 'failed',
			})
		})

		it('a regional outage on the webhook path answers 5xx so Stripe retries; a permanent rejection is acknowledged', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			fake.statusError = new RegionalPaymentsApiError(
				'regional_unreachable',
				503,
			)
			const emulator = getPaymentsEmulator()
			await emulator.testing.completeCheckout(result.sessionId)
			const events = await emulator.events.list({
				provider: 'stripe',
				type: 'checkout.session.completed',
			})
			expect(events[0]).toMatchObject({ lastStatus: 500 })
			fake.statusError = new RegionalPaymentsApiError('payment_not_found', 404)
			await emulator.events.flush({ provider: 'stripe' })
			const after = await emulator.events.list({
				provider: 'stripe',
				type: 'checkout.session.completed',
			})
			expect(after[0]).toMatchObject({ lastStatus: 200 })
		})
	})

	describe('Checkout.com (KSA) deposits and guarantees (VAL-PAY-021..025)', () => {
		const sarQuote = { currency: 'SAR', amountMinor: 12_000 }

		it('creates a hosted page bound by merchant reference with the commission allocation', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, sarQuote)
			const result = await createReservationHostedCheckout(
				request(org, { locale: 'ar' }),
			)
			expect(result.processor).toBe('checkout')
			expect(result.checkoutUrl).toContain(
				'/mock-payments/checkout-com/hpp/hpp_',
			)
			expect(fake.binds[0]).toMatchObject({
				processor: 'checkout',
				platformFeeBp: 150,
				platformFeeMinor: 180,
				sessionId: expect.stringMatching(/^rsv_deposit_[0-9a-f]{32}$/),
			})
			expect(fake.binds[0]!.sessionId.length).toBeLessThanOrEqual(50)
		})

		it('paying confirms through the webhook and through the poll with the reference as the session id', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, sarQuote)
			const result = await createReservationHostedCheckout(request(org))
			const emulator = getPaymentsEmulator()
			await emulator.testing.completeHostedPayment(result.sessionId)
			expect(fake.statuses.at(-1)).toMatchObject({
				processor: 'checkout',
				status: 'paid',
				amountMinor: 12_000,
				currency: 'SAR',
				sessionId: fake.binds[0]!.sessionId,
				paymentRef: expect.stringMatching(/^pay_/),
			})
			const payment = (await emulator.object(
				'checkout',
				fake.statuses.at(-1)!.paymentRef,
			)) as Json
			expect(payment.amount_allocations[0]).toMatchObject({
				amount: 12_000,
				commission: { amount: 180 },
			})
		})

		it('manual webhooks: the poll finds the payment by reference; a decline reports failed', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, sarQuote)
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeHostedPayment(
				result.sessionId,
			)
			expect(fake.statuses).toHaveLength(0)
			expect(await getReservationPaymentStatus(request(org))).toMatchObject({
				paymentStatus: 'paid',
				processor: 'checkout',
			})

			const decliningOrg = await createOrg('ksa', 'checkout')
			setQuote({}, { currency: 'SAR', amountMinor: 1005 })
			const declined = await createReservationHostedCheckout(
				request(decliningOrg),
			)
			fake.statuses = []
			await getPaymentsEmulator().testing.completeHostedPayment(
				declined.sessionId,
			)
			await getReservationPaymentStatus(request(decliningOrg))
			expect(fake.statuses.at(-1)).toMatchObject({ status: 'failed' })
		})

		it('a replay of an open hosted page answers session_in_progress and never serves a second page', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, sarQuote)
			await createReservationHostedCheckout(request(org))
			expect(
				await failure(createReservationHostedCheckout(request(org))),
			).toMatchObject({
				status: 409,
				error: 'session_in_progress',
				retryable: true,
			})
			expect(fake.binds).toHaveLength(1)
		})

		it('a guarantee stores the card, reports src_ cus_ and the CIT id, and gives the verification charge back', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, { ...GUARANTEE_QUOTE, currency: 'SAR' })
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			expect(result).toMatchObject({ mode: 'setup', processor: 'checkout' })
			await getPaymentsEmulator().testing.completeHostedPayment(
				result.sessionId,
			)
			const event = fake.statuses.at(-1)!
			expect(event).toMatchObject({
				purpose: 'guarantee',
				status: 'setup_succeeded',
				amountMinor: 0,
				currency: 'SAR',
				paymentMethodRef: expect.stringMatching(/^src_/),
				providerCustomerRef: expect.stringMatching(/^cus_/),
				previousPaymentRef: event.paymentRef,
				card: { brand: 'visa', last4: '4242' },
			})
			const actions = (await (
				await import('#app/utils/shop.server.ts')
			)
				.getShopCommerce()
				.listReservationCheckoutPaymentActions(event.paymentRef)) as Json[]
			expect(actions.find((action) => action.type === 'Refund')).toMatchObject({
				amountMinor: 100,
				reference: `rsv_verify_${event.paymentRef}`,
			})
		})
	})

	describe('staff-charged fees (VAL-PAY-009, VAL-PAY-010, VAL-PAY-014)', () => {
		async function savedStripeCard(card: string) {
			const org = await createOrg('us', 'stripe')
			setQuote({}, GUARANTEE_QUOTE)
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId, {
				card,
			})
			const saved = fake.statuses.at(-1)!
			fake.claim = {
				feeId: 'fee_1',
				reservationId: 'rsv_1',
				locationId: 'loc_1',
				kind: 'no_show_fee',
				attempt: 1,
				amountMinor: 2500,
				currency: 'USD',
				processor: 'stripe',
				providerCustomerRef: saved.providerCustomerRef,
				paymentMethodRef: saved.paymentMethodRef,
				previousPaymentRef: null,
			}
			return org
		}

		const feeInput = (org: { id: string }) => ({
			orgId: org.id,
			reservationId: 'rsv_1',
			feeId: 'fee_1',
		})

		it('charges the saved card off-session with the platform fee and reports success', async () => {
			const org = await savedStripeCard('4000002500003155')
			const result = await chargeReservationFee(feeInput(org))
			expect(result).toEqual({
				feeId: 'fee_1',
				attempt: 1,
				status: 'succeeded',
				declineCode: null,
			})
			// floor(2500 * 150 / 10000) = 37
			expect(fake.feeResults).toEqual([
				{
					dataRegion: 'us',
					orgId: org.id,
					reservationId: 'rsv_1',
					feeId: 'fee_1',
					attempt: 1,
					paymentRef: expect.stringMatching(/^pi_/),
					status: 'succeeded',
					platformFeeBp: 150,
					platformFeeMinor: 37,
				},
			])
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			expect(ledger.applicationFees.at(-1)).toMatchObject({ amount: 37 })
		})

		it('3184: authentication_required reports requires_action and cancels the dangling intent', async () => {
			const org = await savedStripeCard('4000002760003184')
			const result = await chargeReservationFee(feeInput(org))
			expect(result.status).toBe('requires_action')
			expect(fake.feeResults[0]).toMatchObject({ status: 'requires_action' })
			const pi = fake.feeResults[0]!.paymentRef
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			expect(pi).toMatch(/^pi_/)
			expect((await commerce.retrieveReservationPaymentIntent(pi)).status).toBe(
				'canceled',
			)
		})

		it('0341: the decline carries its decline code', async () => {
			const org = await savedStripeCard('4000000000000341')
			const result = await chargeReservationFee(feeInput(org))
			expect(result).toMatchObject({
				status: 'failed',
				declineCode: 'generic_decline',
			})
			expect(fake.feeResults[0]).toMatchObject({
				status: 'failed',
				declineCode: 'generic_decline',
			})
		})

		it('a second claim is a typed 409 and nothing is charged', async () => {
			const org = await savedStripeCard('4242424242424242')
			fake.claimError = new RegionalPaymentsApiError('fee_not_pending', 409)
			const error = await chargeReservationFee(feeInput(org)).catch((e) => e)
			expect(error).toBeInstanceOf(ReservationPaymentError)
			expect(error).toMatchObject({
				code: 'fee_not_claimable',
				httpStatus: 409,
			})
			expect(fake.feeResults).toHaveLength(0)
		})

		it('retries the result report on a transient regional failure, with the same outcome', async () => {
			const org = await savedStripeCard('4242424242424242')
			fake.feeResultFailures = 2
			const result = await chargeReservationFee(feeInput(org))
			expect(result.status).toBe('succeeded')
			expect(fake.feeResults).toHaveLength(1)
		})

		it('a missing saved card is reported as a failed charge, never a provider call', async () => {
			const org = await savedStripeCard('4242424242424242')
			fake.claim = { ...fake.claim, paymentMethodRef: null }
			const result = await chargeReservationFee(feeInput(org))
			expect(result).toMatchObject({
				status: 'failed',
				declineCode: 'no_saved_card',
			})
		})

		it('a claim for another fee or reservation is refused', async () => {
			const org = await savedStripeCard('4242424242424242')
			fake.claim = { ...fake.claim, feeId: 'fee_other' }
			await expect(chargeReservationFee(feeInput(org))).rejects.toMatchObject({
				code: 'fee_mismatch',
			})
		})

		it('Checkout.com: an MIT with the stored source charges; a 05 decline reports the response code', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, { ...GUARANTEE_QUOTE, currency: 'SAR' })
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			await getPaymentsEmulator().testing.completeHostedPayment(
				result.sessionId,
			)
			const saved = fake.statuses.at(-1)!
			fake.claim = {
				feeId: 'fee_1',
				reservationId: 'rsv_1',
				locationId: 'loc_1',
				kind: 'no_show_fee',
				attempt: 1,
				amountMinor: 5000,
				currency: 'SAR',
				processor: 'checkout',
				providerCustomerRef: saved.providerCustomerRef,
				paymentMethodRef: saved.paymentMethodRef,
				previousPaymentRef: saved.previousPaymentRef,
			}
			const ok = await chargeReservationFee(feeInput(org))
			expect(ok.status).toBe('succeeded')
			expect(fake.feeResults[0]).toMatchObject({
				status: 'succeeded',
				platformFeeMinor: 75,
				paymentRef: expect.stringMatching(/^pay_/),
			})
			fake.claim = { ...fake.claim, amountMinor: 5005, attempt: 2 }
			const declined = await chargeReservationFee(feeInput(org))
			expect(declined).toMatchObject({ status: 'failed', declineCode: '20005' })
		})

		it('Checkout.com: the mock mada card approves the guarantee and declines the MIT (20046)', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, { ...GUARANTEE_QUOTE, currency: 'SAR' })
			const result = await createReservationHostedCheckout(
				request(org, { purpose: 'guarantee' }),
			)
			await getPaymentsEmulator().testing.completeHostedPayment(
				result.sessionId,
				{
					card: '5297412542005689',
				},
			)
			const saved = fake.statuses.at(-1)!
			fake.claim = {
				feeId: 'fee_1',
				reservationId: 'rsv_1',
				locationId: 'loc_1',
				kind: 'late_cancel_fee',
				attempt: 1,
				amountMinor: 4000,
				currency: 'SAR',
				processor: 'checkout',
				providerCustomerRef: saved.providerCustomerRef,
				paymentMethodRef: saved.paymentMethodRef,
				previousPaymentRef: saved.previousPaymentRef,
			}
			expect(await chargeReservationFee(feeInput(org))).toMatchObject({
				status: 'failed',
				declineCode: '20046',
			})
		})
	})

	describe('refund execution and outbox commands (VAL-PAY-011, VAL-PAY-026, VAL-PAY-027, VAL-PAY-041..045)', () => {
		async function paidStripe(card = '4242424242424242') {
			const org = await createOrg('us', 'stripe')
			setQuote()
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId, {
				card,
			})
			return {
				org,
				paymentRef: fake.statuses.at(-1)!.paymentRef as string,
				result,
			}
		}

		function claim(overrides: Json = {}) {
			return {
				refundRequestId: 'rr_1',
				reservationId: 'rsv_1',
				paymentRef: 'pi_x',
				processor: 'stripe',
				amountMinor: 1000,
				currency: 'USD',
				paymentAmountMinor: 3333,
				platformFeeMinor: 49,
				refundedBeforeMinor: 0,
				feeReversedBeforeMinor: 0,
				feeReversalMinor: 15,
				...overrides,
			}
		}

		it('refund_request: claims, refunds with reverse_transfer and the fee refund, reports succeeded', async () => {
			const { org, paymentRef } = await paidStripe()
			fake.refundClaims = [
				claim({ paymentRef, amountMinor: 3333, feeReversalMinor: 49 }),
			]
			const result = await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			})
			expect(result).toEqual({
				kind: 'refund_request',
				refunds: 1,
				pending: 0,
				failed: 0,
			})
			expect(fake.refundResults).toEqual([
				{
					dataRegion: 'us',
					orgId: org.id,
					refundRequestId: 'rr_1',
					refundRef: expect.stringMatching(/^re_/),
					amountMinor: 3333,
					status: 'succeeded',
				},
			])
			const ledger = await getPaymentsEmulator().pages.stripe.ledger(
				org.stripeConnectAccountId!,
			)
			expect(ledger.reversals[0]).toMatchObject({ amount: 3333 - 49 })
			expect(ledger.feeRefunds[0]).toMatchObject({ amount: 49 })
			// A replayed delivery uses the same key: still one refund object.
			await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			})
			expect(fake.refundResults[1]!.refundRef).toBe(
				fake.refundResults[0]!.refundRef,
			)
		})

		it('7726: pending stays pending, then the refund webhook settles it with the request id read back (VAL-PAY-011)', async () => {
			const { org, paymentRef } = await paidStripe('4000000000007726')
			fake.refundClaims = [claim({ paymentRef, amountMinor: 3333 })]
			const result = await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			})
			expect(result).toMatchObject({ pending: 1, failed: 0 })
			expect(fake.refundResults[0]).toMatchObject({ status: 'pending' })
			fake.refundResults = []
			await getPaymentsEmulator().testing.settleRefund(
				fake.refundClaims.length ? await latestRefundId(org) : '',
				'succeeded',
			)
			// Delivered inline to the real Stripe route: refund.updated -> /refund-result.
			expect(fake.refundResults.at(-1)).toMatchObject({
				orgId: org.id,
				refundRequestId: 'rr_1',
				status: 'succeeded',
				amountMinor: 3333,
			})
		})

		it('5126: pending then failed is reported failed by the webhook', async () => {
			const { org, paymentRef } = await paidStripe('4000000000005126')
			fake.refundClaims = [claim({ paymentRef, amountMinor: 3333 })]
			await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			})
			fake.refundResults = []
			await getPaymentsEmulator().testing.settleRefund(
				await latestRefundId(org),
			)
			expect(fake.refundResults.at(-1)).toMatchObject({
				refundRequestId: 'rr_1',
				status: 'failed',
			})
		})

		it('a definitive provider rejection is reported failed; a transient failure is retried and never reported', async () => {
			const { org, paymentRef } = await paidStripe()
			fake.refundClaims = [claim({ paymentRef, amountMinor: 999_999 })]
			expect(
				await executeReservationPaymentCommand({
					kind: 'refund_request',
					orgId: org.id,
					refundRequestId: 'rr_1',
				}),
			).toMatchObject({ failed: 1 })
			expect(fake.refundResults[0]).toMatchObject({ status: 'failed' })

			fake.refundResults = []
			const { getShopCommerce } = await import('#app/utils/shop.server.ts')
			const spy = vi
				.spyOn(getShopCommerce(), 'createReservationStripeRefund')
				.mockRejectedValue(new TypeError('network down'))
			fake.refundClaims = [claim({ paymentRef, amountMinor: 100 })]
			const error = await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			}).catch((e) => e)
			spy.mockRestore()
			expect(error).toMatchObject({
				code: 'provider_unavailable',
				httpStatus: 503,
				retryable: true,
			})
			expect(fake.refundResults).toHaveLength(0)
		})

		it('nothing to claim is an idempotent success', async () => {
			const org = await createOrg('us', 'stripe')
			expect(
				await executeReservationPaymentCommand({
					kind: 'refund_request',
					orgId: org.id,
					refundRequestId: 'rr_gone',
				}),
			).toEqual({ kind: 'refund_request', refunds: 0, pending: 0, failed: 0 })
		})

		it('Checkout.com: the refund is pending with the action id; the directive fee reverses; the webhook settles it by reference', async () => {
			const org = await createOrg('ksa', 'checkout')
			setQuote({}, { currency: 'SAR', amountMinor: 10_000 })
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeHostedPayment(
				result.sessionId,
			)
			const paymentRef = fake.statuses.at(-1)!.paymentRef as string
			fake.refundClaims = [
				claim({
					processor: 'checkout',
					paymentRef,
					currency: 'SAR',
					amountMinor: 4000,
					paymentAmountMinor: 10_000,
					platformFeeMinor: 150,
					feeReversalMinor: 60,
				}),
			]
			const outcome = await executeReservationPaymentCommand({
				kind: 'refund_request',
				orgId: org.id,
				refundRequestId: 'rr_1',
			})
			expect(outcome).toMatchObject({ pending: 1 })
			expect(fake.refundResults[0]).toMatchObject({
				status: 'pending',
				refundRef: expect.stringMatching(/^act_/),
				amountMinor: 4000,
			})
			fake.refundResults = []
			await getPaymentsEmulator().testing.advanceClock(5)
			expect(fake.refundResults.at(-1)).toMatchObject({
				refundRequestId: 'rr_1',
				status: 'succeeded',
				amountMinor: 4000,
			})
			const events = await getPaymentsEmulator().events.list({
				provider: 'checkout',
				type: 'payment_refunded',
			})
			expect(events[0]).toMatchObject({ lastStatus: 200 })
			const payment = (await getPaymentsEmulator().object(
				'checkout',
				paymentRef,
			)) as Json
			expect(payment.balances.total_refunded).toBe(4000)
		})

		it('checkout_expire closes the Stripe session; a closed one is success; Checkout.com does nothing', async () => {
			const org = await createOrg('us', 'stripe')
			const result = await createReservationHostedCheckout(request(org))
			expect(
				await executeReservationPaymentCommand({
					kind: 'checkout_expire',
					orgId: org.id,
					reservationId: 'rsv_1',
					sessionId: result.sessionId,
					processor: 'stripe',
				}),
			).toEqual({ kind: 'checkout_expire', expired: true })
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			expect(
				(await commerce.retrieveReservationStripeSession(result.sessionId))
					.status,
			).toBe('expired')
			// Already expired: still success.
			expect(
				await executeReservationPaymentCommand({
					kind: 'checkout_expire',
					orgId: org.id,
					reservationId: 'rsv_1',
					sessionId: result.sessionId,
					processor: 'stripe',
				}),
			).toMatchObject({ kind: 'checkout_expire' })
			expect(
				await executeReservationPaymentCommand({
					kind: 'checkout_expire',
					orgId: org.id,
					reservationId: 'rsv_1',
					sessionId: 'rsv_deposit_x',
					processor: 'checkout',
				}),
			).toEqual({ kind: 'checkout_expire', expired: false })
		})

		it('an unknown organization is a typed 404', async () => {
			await expect(
				executeReservationPaymentCommand({
					kind: 'refund_request',
					orgId: 'org_missing',
					refundRequestId: 'rr_1',
				}),
			).rejects.toMatchObject({ code: 'org_not_found', httpStatus: 404 })
		})
	})

	describe('disputes (VAL-PAY-037)', () => {
		it('a Stripe dispute is mapped through the payment intent metadata and reported', async () => {
			const org = await createOrg('us', 'stripe')
			setQuote()
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId, {
				card: '4000000000000259',
			})
			expect(fake.disputes[0]).toMatchObject({
				orgId: org.id,
				reservationId: 'rsv_1',
				paymentRef: fake.statuses.at(-1)!.paymentRef,
				disputeRef: expect.stringMatching(/^dp_/),
				status: 'opened',
			})
			const disputeId = fake.disputes[0]!.disputeRef as string
			fake.disputes = []
			await getPaymentsEmulator().testing.closeDispute(disputeId, 'lost')
			expect(fake.disputes.at(-1)).toMatchObject({ status: 'lost' })
		})
	})

	describe('reconcile job (VAL-PAY-033, VAL-PAY-034)', () => {
		it('pushes terminal sessions and settles pending refunds; one failing org does not stop the rest', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const paidOrg = await createOrg('us', 'stripe')
			setQuote()
			const paid = await createReservationHostedCheckout(request(paidOrg))
			await getPaymentsEmulator().testing.completeCheckout(paid.sessionId)
			const brokenOrg = await createOrg('us', 'stripe')
			fake.pending.set(
				brokenOrg.id,
				new RegionalPaymentsApiError('regional_unreachable', 503),
			)
			fake.pending.set(paidOrg.id, {
				sessions: [
					{
						reservationId: 'rsv_1',
						feeId: null,
						purpose: 'deposit',
						sessionId: paid.sessionId,
						processor: 'stripe',
						amountMinor: 3333,
						currency: 'USD',
					},
				],
				refunds: [],
			})
			const summary = await reconcileReservationPayments()
			expect(summary.failedOrganizations).toBeGreaterThanOrEqual(1)
			expect(summary.sessionsPushed).toBe(1)
			expect(
				fake.statuses.filter((entry) => entry.sessionId === paid.sessionId),
			).toHaveLength(1)
			expect(fake.statuses.at(-1)).toMatchObject({ status: 'paid' })
		})

		it('skips orgs whose reservations are off, leaves open sessions, and skips transient provider failures', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			setQuote()
			const open = await createReservationHostedCheckout(request(org))
			fake.pending.set(org.id, {
				sessions: [
					{
						reservationId: 'rsv_1',
						feeId: null,
						purpose: 'deposit',
						sessionId: open.sessionId,
						processor: 'stripe',
						amountMinor: 3333,
						currency: 'USD',
					},
				],
				refunds: [],
			})
			let summary = await reconcileReservationPayments()
			expect(summary.sessionsChecked).toBeGreaterThanOrEqual(1)
			expect(fake.statuses).toHaveLength(0)

			const { getShopCommerce } = await import('#app/utils/shop.server.ts')
			const spy = vi
				.spyOn(getShopCommerce(), 'retrieveReservationStripeSession')
				.mockRejectedValue(new TypeError('network down'))
			summary = await reconcileReservationPayments()
			spy.mockRestore()
			expect(summary.skipped).toBeGreaterThanOrEqual(1)
			expect(fake.statuses).toHaveLength(0)

			fake.flagOn = false
			summary = await reconcileReservationPayments()
			expect(summary.organizations).toBe(0)
		})

		it('issues a claimed-but-never-issued refund with the deterministic key and settles an issued one', async () => {
			vi.stubEnv('PAYMENTS_MOCK_WEBHOOKS', 'manual')
			const org = await createOrg('us', 'stripe')
			setQuote()
			const result = await createReservationHostedCheckout(request(org))
			await getPaymentsEmulator().testing.completeCheckout(result.sessionId, {
				card: '4000000000007726',
			})
			const commerce = (
				await import('#app/utils/shop.server.ts')
			).getShopCommerce()
			const paymentIntent = (
				await commerce.retrieveReservationStripeSession(result.sessionId)
			).payment_intent as string
			fake.pending.set(org.id, {
				sessions: [],
				refunds: [
					{
						refundRequestId: 'rr_9',
						reservationId: 'rsv_1',
						paymentRef: paymentIntent,
						processor: 'stripe',
						refundRef: null,
						amountMinor: 1000,
						currency: 'USD',
						paymentAmountMinor: 3333,
						platformFeeMinor: 49,
						feeReversalMinor: 15,
					},
				],
			})
			await reconcileReservationPayments()
			expect(fake.refundResults.at(-1)).toMatchObject({
				refundRequestId: 'rr_9',
				status: 'pending',
				refundRef: expect.stringMatching(/^re_/),
			})
			const refundRef = fake.refundResults.at(-1)!.refundRef as string
			await getPaymentsEmulator().testing.settleRefund(refundRef, 'succeeded')
			fake.refundResults = []
			fake.pending.set(org.id, {
				sessions: [],
				refunds: [
					{
						refundRequestId: 'rr_9',
						reservationId: 'rsv_1',
						paymentRef: paymentIntent,
						processor: 'stripe',
						refundRef,
						amountMinor: 1000,
						currency: 'USD',
						paymentAmountMinor: 3333,
						platformFeeMinor: 49,
						feeReversalMinor: 15,
					},
				],
			})
			await reconcileReservationPayments()
			expect(fake.refundResults.at(-1)).toMatchObject({
				refundRequestId: 'rr_9',
				refundRef,
				status: 'succeeded',
			})
		})
	})
})

async function latestRefundId(org: { id: string }) {
	const events = await getPaymentsEmulator().events.list({ provider: 'stripe' })
	const created = events.find((event) => event.type === 'refund.created')
	expect(created, `refund event for ${org.id}`).toBeTruthy()
	const payload = JSON.parse(
		String((created as Json).payload ?? (created as Json).body),
	) as Json
	return String(payload.data.object.id)
}
