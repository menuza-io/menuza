import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	reservationPaymentQuoteSchema,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	rsvAuditLog,
	rsvBlocks,
	rsvHolds,
	rsvLocationSettings,
	rsvMessages,
	rsvOutbox,
	rsvPayments,
	rsvPolicies,
	rsvReservations,
	rsvTableOccupancies,
} from '@repo/tenant-db'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { resetPublicRateLimits } from '../lib/reservations-public-auth.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import {
	createExperience,
	createExperienceSchedule,
	publishExperience,
} from '../services/rsv-experience-service.ts'
import { guestCancelReservation } from '../services/rsv-public-booking-service.ts'
import { transitionReservationStatus } from '../services/rsv-booking-service.ts'
import {
	resetReservationsTickLocks,
	runReservationsTickForOrg,
} from '../services/rsv-tick-service.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { reservationsPaymentsInternalRoutes } from './reservations-payments-internal.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
	US_ORIGIN,
} from './reservations-public-fixture.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

const ORG = 'org_pay_us'
const ORG_B = 'org_pay_other'
const OPERATOR_SECRET = 'test-public-operator-secret-key-32-chars-minimum!!'
const INTERNAL_TOKEN = 'test-internal-token-very-long-and-secure-12345'
const OPERATOR_ID = 'usr_pay_operator'
const DAY = dateAhead(10)

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForPublicOrigin: vi.fn(async (origin?: string) =>
		origin === 'http://acme.menuza.test:3008'
			? (orgs.get('org_pay_us') ?? null)
			: null,
	),
}))

let tempDir: string
const app = new Hono()
app.route('/reservations', reservationsPublicRoutes)
app.route('/operator/reservations', reservationsOperatorRoutes)
app.route('/api/reservations/payments', reservationsPaymentsInternalRoutes)

let counter = 0
const key = () =>
	`pay-key-${++counter}-${Math.random().toString(36).slice(2, 8)}`

async function publicCall(
	method: string,
	urlPath: string,
	options: {
		body?: unknown
		token?: string
		headers?: Record<string, string>
	} = {},
) {
	const headers: Record<string, string> = {
		Origin: US_ORIGIN,
		...options.headers,
	}
	if (options.token) headers['X-Reservation-Token'] = options.token
	if (options.body !== undefined) headers['Content-Type'] = 'application/json'
	const res = await app.request(urlPath, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	})
	const text = await res.text()
	return { status: res.status, body: text ? JSON.parse(text) : null, res }
}

async function internal(
	pathName: string,
	body: Record<string, unknown>,
	token: string | null = INTERNAL_TOKEN,
) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'x-forwarded-for': `10.9.0.${++counter % 250}`,
	}
	if (token) headers.Authorization = `Bearer ${token}`
	const res = await app.request(`/api/reservations/payments${pathName}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ orgId: ORG, ...body }),
	})
	const text = await res.text()
	return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function operatorToken(
	grants: string[],
	scope = 'payments',
	extra: Record<string, unknown> = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope,
		grants,
		locationIds: null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: false,
			payments: true,
			voice: false,
		},
		impersonated: false,
		...extra,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject(OPERATOR_ID)
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

const PAYMENT_GRANTS = [
	RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
	RESERVATIONS_PERMISSIONS.READ_RESERVATION,
]

async function operatorCall(
	method: string,
	urlPath: string,
	body?: unknown,
	token?: string,
) {
	const res = await app.request(`/operator/reservations${urlPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${token ?? (await operatorToken(PAYMENT_GRANTS))}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function seedPolicy(over: Partial<typeof rsvPolicies.$inferInsert> = {}) {
	const db = await getTenantDb(ORG)
	await db.insert(rsvPolicies).values({
		id: 'pol_dep',
		locationId: PUBLIC_LOC,
		name: 'Deposit',
		kind: 'deposit',
		amountMinor: 2500,
		perCover: true,
		currency: 'USD',
		freeCancelUntilMin: 1440,
		lateCancelFeeMinor: 5000,
		noShowFeeMinor: 2500,
		feePerCover: true,
		feeCapMinor: 10_000,
		refundRule: 'full_before_window',
		termsI18n: { en: 'Deposit terms' },
		termsVersion: 2,
		...over,
	})
	await db
		.update(rsvLocationSettings)
		.set({ defaultPolicyId: over.id ?? 'pol_dep' })
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
}

function useProcessor(
	processor: 'connect' | 'checkout' | null = 'connect',
	flags: { deposit?: boolean; guarantee?: boolean } = {},
) {
	seedReservationsContextForTest(
		ORG,
		publicContext(ORG, {
			payments: {
				processor,
				deposit: flags.deposit ?? processor !== null,
				guarantee: flags.guarantee ?? processor !== null,
			},
		}),
	)
}

async function holdAndBook(
	localMin: number,
	n: number,
	partySize = 4,
	extra: Record<string, unknown> = {},
) {
	const hold = await publicCall('POST', '/reservations/holds', {
		body: {
			locationId: PUBLIC_LOC,
			slot: { date: DAY, localMin, partySize },
		},
	})
	expect(hold.status).toBe(201)
	const booked = await publicCall('POST', '/reservations', {
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: hold.body.holdToken,
			guest: {
				firstName: `Pat${n}`,
				lastName: 'Guest',
				phone: `+1415555${String(2000 + n)}`,
				email: `pat${n}@example.com`,
			},
			locale: 'en',
			smsOptIn: false,
			website: '',
			policyAccepted: { termsVersion: '2' },
			...extra,
		},
	})
	return { hold: hold.body, booked }
}

async function bookDeposit(n = 1, partySize = 4) {
	const { booked } = await holdAndBook(19 * 60, n, partySize)
	expect(booked.status).toBe(201)
	return booked.body as {
		reservation: { id: string; status: string; paymentStatus: string }
		manageToken: string
		payment: {
			paymentToken: string
			purpose: string
			amountMinor: number
			currency: string
			expiresAt: string
			payUrl: string
		}
	}
}

async function paymentRows(reservationId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(rsvPayments)
		.where(eq(rsvPayments.reservationId, reservationId))
}

async function reservationRow(id: string) {
	const db = await getTenantDb(ORG)
	return (await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, id))
		.get())!
}

async function messageKinds(reservationId: string) {
	const db = await getTenantDb(ORG)
	return (
		await db
			.select({ kind: rsvMessages.kind })
			.from(rsvMessages)
			.where(eq(rsvMessages.reservationId, reservationId))
	).map((row) => row.kind)
}

/** Quote, bind and report success for the booking's deposit session. */
async function payDeposit(
	booking: Awaited<ReturnType<typeof bookDeposit>>,
	over: { sessionId?: string; bp?: number; amount?: number } = {},
) {
	const quote = await internal('/quote', {
		reservationId: booking.reservation.id,
		paymentToken: booking.payment.paymentToken,
		purpose: booking.payment.purpose,
	})
	expect(quote.status).toBe(200)
	const sessionId = over.sessionId ?? `cs_test_${booking.reservation.id}`
	const bp = over.bp ?? 250
	const amount = over.amount ?? quote.body.amountMinor
	const bind = await internal('/bind', {
		reservationId: booking.reservation.id,
		purpose: booking.payment.purpose,
		sessionId,
		processor: 'stripe',
		platformFeeBp: bp,
		platformFeeMinor: Math.floor((amount * bp) / 10_000),
	})
	expect(bind.status).toBe(204)
	const status = await internal('/status', {
		reservationId: booking.reservation.id,
		purpose: booking.payment.purpose,
		sessionId,
		processor: 'stripe',
		status: 'paid',
		amountMinor: amount,
		currency: 'USD',
		paymentRef: `pi_${booking.reservation.id}`,
	})
	return { quote: quote.body, status, sessionId }
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-pay-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.INTERNAL_COMMAND_TOKEN = INTERNAL_TOKEN
	process.env.JWT_SECRET = 'test-public-customer-jwt-secret-123456'
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	resetPublicRateLimits()
	resetRateLimits()
	resetReservationsTickLocks()
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id === ORG ? 'acme' : 'other',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme Bistro',
		})
	}
	await seedPublicOrg(ORG)
	useProcessor('connect')
	await seedPolicy()
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('booking with a payment policy', () => {
	it('parks the booking in pending_payment, keeps its capacity and returns the payment block (VAL-PAY-019, 020)', async () => {
		const booking = await bookDeposit(1, 4)
		expect(booking.reservation).toMatchObject({
			status: 'pending_payment',
			paymentStatus: 'pending',
		})
		expect(booking.payment).toMatchObject({
			purpose: 'deposit',
			amountMinor: 10_000,
			currency: 'USD',
		})
		expect(booking.payment.payUrl).toBe(
			`https://acme.menuza.test/reserve/pay#r=${booking.reservation.id}&t=${booking.payment.paymentToken}`,
		)
		const row = await reservationRow(booking.reservation.id)
		expect(row.paymentExpiresAt! - row.createdAt).toBe(20 * 60_000)
		expect(row.policySnapshot).toMatchObject({
			policyId: 'pol_dep',
			termsVersion: 2,
			totalAmountMinor: 10_000,
		})
		expect(row.policyAcceptedAt).not.toBeNull()
		expect(row.policyTextHash).toMatch(/^[0-9a-f]{64}$/)
		const rows = await paymentRows(row.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'deposit_charge',
			provider: 'stripe',
			amountMinor: 10_000,
			status: 'created',
		})
		const db = await getTenantDb(ORG)
		const hold = await db
			.select()
			.from(rsvHolds)
			.where(eq(rsvHolds.id, row.holdId!))
			.get()
		expect(hold).toMatchObject({
			extendedForPayment: true,
			expiresAt: row.paymentExpiresAt,
		})
		const occ = await db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.reservationId, row.id),
					eq(rsvTableOccupancies.active, true),
				),
			)
		expect(occ.length).toBeGreaterThan(0)
		// No confirmation yet: payment confirms the booking.
		expect(await messageKinds(row.id)).toEqual([])
	})

	it('requires the guest to accept the terms', async () => {
		const { booked } = await holdAndBook(19 * 60, 2, 4, {
			policyAccepted: null,
		})
		expect(booked.status).toBe(400)
		expect(booked.body.error).toBe('policy_required')
	})

	it('scopes a policy with applies_party_min (VAL-PAY-018)', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvPolicies)
			.set({ appliesPartyMin: 6 })
			.where(eq(rsvPolicies.id, 'pol_dep'))
		const small = await holdAndBook(19 * 60, 3, 4, { policyAccepted: null })
		expect(small.booked.status).toBe(201)
		expect(small.booked.body.reservation.status).toBe('booked')
		expect(small.booked.body.payment).toBeUndefined()
	})

	it('fails closed with policy_unavailable and holds nothing (VAL-PAY-015)', async () => {
		useProcessor(null)
		const hold = await publicCall('POST', '/reservations/holds', {
			body: {
				locationId: PUBLIC_LOC,
				slot: { date: DAY, localMin: 19 * 60, partySize: 4 },
			},
		})
		expect(hold.status).toBe(409)
		expect(hold.body.error).toBe('policy_unavailable')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvHolds)).toHaveLength(0)
		expect(await db.select().from(rsvReservations)).toHaveLength(0)
	})

	it('ignores money policies while the payments feature is off', async () => {
		seedReservationsContextForTest(ORG, publicContext(ORG))
		const { booked } = await holdAndBook(19 * 60, 4, 4, {
			policyAccepted: null,
		})
		expect(booked.status).toBe(201)
		expect(booked.body.reservation.status).toBe('booked')
	})

	it('shows the policy with the hold', async () => {
		const hold = await publicCall('POST', '/reservations/holds', {
			body: {
				locationId: PUBLIC_LOC,
				slot: { date: DAY, localMin: 19 * 60, partySize: 4 },
			},
		})
		expect(hold.body.requiresPayment).toBe(true)
		expect(hold.body.policy).toMatchObject({
			kind: 'deposit',
			terms: 'Deposit terms',
			termsVersion: 2,
			totalAmountMinor: 10_000,
		})
	})
})

describe('quote, bind and status', () => {
	it('quotes the authoritative amount in the contract shape and refuses a bad token', async () => {
		const booking = await bookDeposit()
		const quote = await internal('/quote', {
			reservationId: booking.reservation.id,
			paymentToken: booking.payment.paymentToken,
			purpose: 'deposit',
		})
		expect(quote.status).toBe(200)
		expect(() => reservationPaymentQuoteSchema.parse(quote.body)).not.toThrow()
		expect(quote.body).toMatchObject({
			mode: 'payment',
			amountMinor: 10_000,
			quantity: 4,
			unitAmountMinor: 2500,
			currency: 'USD',
		})
		const bad = await internal('/quote', {
			reservationId: booking.reservation.id,
			paymentToken: `${booking.payment.paymentToken}x`,
			purpose: 'deposit',
		})
		expect(bad.status).toBe(404)
		expect(bad.body.error).toBe('invalid_payment_token')
	})

	it('confirms the booking on payment success exactly once (VAL-PAY-021, 031)', async () => {
		const booking = await bookDeposit()
		const paid = await payDeposit(booking)
		expect(paid.status.status).toBe(200)
		expect(paid.status.body.outcome).toBe('recorded')
		const row = await reservationRow(booking.reservation.id)
		expect(row).toMatchObject({
			status: 'booked',
			paymentStatus: 'paid',
			paymentExpiresAt: null,
		})
		const [payment] = await paymentRows(row.id)
		expect(payment).toMatchObject({
			status: 'succeeded',
			platformFeeBp: 250,
			platformFeeMinor: 250,
			providerRef: `pi_${row.id}`,
		})
		const version = row.version
		const again = await internal('/status', {
			reservationId: row.id,
			purpose: 'deposit',
			sessionId: paid.sessionId,
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
			paymentRef: `pi_${row.id}`,
		})
		expect(again.body.outcome).toBe('duplicate')
		expect((await reservationRow(row.id)).version).toBe(version)
		expect(
			(await messageKinds(row.id)).filter((k) => k === 'payment_received'),
		).toHaveLength(1)
	})

	it('rejects a tampered amount, session, processor or currency without changing state (VAL-PAY-031)', async () => {
		const booking = await bookDeposit()
		await internal('/bind', {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_real',
			processor: 'stripe',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		const base = {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_real',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
		}
		for (const patch of [
			{ amountMinor: 9_999 },
			{ sessionId: 'cs_other' },
			{ processor: 'checkout' },
			{ currency: 'SAR' },
		]) {
			const res = await internal('/status', { ...base, ...patch })
			expect(res.status).toBe(409)
			expect(res.body.error).toBe('status_mismatch')
		}
		expect((await reservationRow(booking.reservation.id)).status).toBe(
			'pending_payment',
		)
	})

	it('binds once per session', async () => {
		const booking = await bookDeposit()
		const body = {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			processor: 'stripe',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		}
		expect(
			(await internal('/bind', { ...body, sessionId: 'cs_a' })).status,
		).toBe(204)
		expect(
			(await internal('/bind', { ...body, sessionId: 'cs_a' })).status,
		).toBe(204)
		const second = await internal('/bind', { ...body, sessionId: 'cs_b' })
		expect(second.status).toBe(409)
		expect(second.body.error).toBe('already_bound')
	})

	it('lets an expired provider session be replaced while the hold lives, and keeps a decline retryable (VAL-PAY-024)', async () => {
		const booking = await bookDeposit()
		const body = {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			processor: 'stripe',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		}
		await internal('/bind', { ...body, sessionId: 'cs_a' })
		const {
			platformFeeBp: ignoredBp,
			platformFeeMinor: ignoredMinor,
			...ids
		} = body
		void ignoredBp
		void ignoredMinor
		const failed = await internal('/status', {
			...ids,
			sessionId: 'cs_a',
			status: 'failed',
			amountMinor: 10_000,
			currency: 'USD',
		})
		expect(failed.body.outcome).toBe('recorded')
		expect((await reservationRow(booking.reservation.id)).status).toBe(
			'pending_payment',
		)
		await internal('/status', {
			...ids,
			sessionId: 'cs_a',
			status: 'expired',
			amountMinor: 10_000,
			currency: 'USD',
		})
		const rebind = await internal('/bind', { ...body, sessionId: 'cs_b' })
		expect(rebind.status).toBe(204)
	})

	it('reports payment status to the guest poll with the manage or payment token (VAL-PAY-021)', async () => {
		const booking = await bookDeposit()
		const before = await publicCall('GET', '/reservations/manage/payment', {
			token: booking.payment.paymentToken,
		})
		expect(before.body).toMatchObject({
			paymentStatus: 'pending',
			reservationStatus: 'pending_payment',
		})
		await payDeposit(booking)
		const after = await publicCall('GET', '/reservations/manage/payment', {
			token: booking.manageToken,
		})
		expect(after.body).toMatchObject({
			paymentStatus: 'paid',
			reservationStatus: 'booked',
		})
		const bad = await publicCall('GET', '/reservations/manage/payment', {
			token: 'rsv_p_nope.nope',
		})
		expect(bad.status).toBe(404)
	})
})

describe('expiry and late payments', () => {
	async function expireBooking(
		booking: Awaited<ReturnType<typeof bookDeposit>>,
	) {
		const db = await getTenantDb(ORG)
		await internal('/bind', {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_late',
			processor: 'stripe',
			platformFeeBp: 1000,
			platformFeeMinor: 1000,
		})
		await db
			.update(rsvReservations)
			.set({ paymentExpiresAt: Date.now() - 1000 })
			.where(eq(rsvReservations.id, booking.reservation.id))
		const result = await runReservationsTickForOrg(ORG, {
			deps: {
				getContext: async () => publicContext(ORG),
				paymentPost: async () => ({ status: 'delivered' }),
			},
		})
		expect(result.status).toBe('ran')
	}

	it('releases the booking, its capacity and its session when the hold lapses (VAL-PAY-026)', async () => {
		const booking = await bookDeposit()
		await expireBooking(booking)
		const row = await reservationRow(booking.reservation.id)
		expect(row.status).toBe('expired')
		expect(row.paymentStatus).toBe('none')
		const db = await getTenantDb(ORG)
		const active = await db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.reservationId, row.id),
					eq(rsvTableOccupancies.active, true),
				),
			)
		expect(active).toHaveLength(0)
		const outbox = await db
			.select()
			.from(rsvOutbox)
			.where(eq(rsvOutbox.kind, 'checkout_expire'))
		expect(outbox).toHaveLength(1)
		expect(outbox[0]!.payload).toMatchObject({
			kind: 'checkout_expire',
			orgId: ORG,
			sessionId: 'cs_late',
			processor: 'stripe',
		})
		expect(outbox[0]!.status).toBe('sent')
		const [payment] = await paymentRows(row.id)
		expect(payment!.status).toBe('expired')
	})

	it('keeps a lapsed session visible to polls and the reconcile feed so a late payment is found', async () => {
		const booking = await bookDeposit()
		await expireBooking(booking)
		const quote = await internal('/quote', {
			reservationId: booking.reservation.id,
			paymentToken: booking.payment.paymentToken,
			purpose: 'deposit',
		})
		expect(quote.body.boundSession).toEqual({
			sessionId: 'cs_late',
			processor: 'stripe',
		})
		expect(quote.body.reservationStatus).toBe('expired')
		const pending = await internal('/pending', {})
		expect(
			pending.body.sessions.map((x: { sessionId: string }) => x.sessionId),
		).toContain('cs_late')
	})

	it('confirms a late payment when the slot is still free (VAL-PAY-027)', async () => {
		const booking = await bookDeposit()
		await expireBooking(booking)
		const late = await internal('/status', {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_late',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
			paymentRef: 'pi_late',
		})
		expect(late.body.outcome).toBe('confirmed')
		const row = await reservationRow(booking.reservation.id)
		expect(row).toMatchObject({ status: 'booked', paymentStatus: 'paid' })
		const db = await getTenantDb(ORG)
		const active = await db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.reservationId, row.id),
					eq(rsvTableOccupancies.active, true),
				),
			)
		expect(active.length).toBeGreaterThan(0)
		expect(await messageKinds(row.id)).toContain('payment_received')
	})

	async function takeEverySlot() {
		const db = await getTenantDb(ORG)
		const start = Date.parse(`${DAY}T19:00:00Z`)
		await db.insert(rsvBlocks).values({
			id: 'blk_all',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_main',
			businessDate: DAY,
			startAt: start - 60 * 60_000,
			endAt: start + 4 * 60 * 60_000,
			reason: 'private event',
		})
		for (const tableId of ['tbl_pub_2', 'tbl_pub_4', 'tbl_pub_12']) {
			await db.insert(rsvTableOccupancies).values({
				id: `occ_block_${tableId}`,
				locationId: PUBLIC_LOC,
				tableId,
				kind: 'block',
				blockId: 'blk_all',
				startAt: start - 60 * 60_000,
				endAt: start + 4 * 60 * 60_000,
				active: true,
				overbook: false,
				createdAt: Date.now(),
			})
		}
	}

	it('refunds in full at once when the slot is gone and settles the refund (VAL-PAY-028)', async () => {
		const booking = await bookDeposit()
		await expireBooking(booking)
		await takeEverySlot()
		const late = await internal('/status', {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_late',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
			paymentRef: 'pi_late',
		})
		expect(late.body.outcome).toBe('refund_required')
		expect(late.body.refund).toMatchObject({
			paymentRef: 'pi_late',
			amountMinor: 10_000,
			paymentAmountMinor: 10_000,
			platformFeeMinor: 1000,
			feeReversalMinor: 1000,
		})
		expect((await reservationRow(booking.reservation.id)).status).toBe(
			'expired',
		)
		const done = await internal('/refund-result', {
			reservationId: booking.reservation.id,
			paymentRef: 'pi_late',
			reason: 'late_payment',
			refundRef: 're_late',
			amountMinor: 10_000,
			status: 'succeeded',
		})
		expect(done.status).toBe(204)
		const row = await reservationRow(booking.reservation.id)
		expect(row).toMatchObject({ status: 'expired', paymentStatus: 'refunded' })
		expect(await messageKinds(row.id)).toContain('late_payment_refunded')
	})

	it('moves the payment to review and alerts managers when the late refund fails (VAL-PAY-029)', async () => {
		const booking = await bookDeposit()
		await expireBooking(booking)
		await takeEverySlot()
		await internal('/status', {
			reservationId: booking.reservation.id,
			purpose: 'deposit',
			sessionId: 'cs_late',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
			paymentRef: 'pi_late',
		})
		const failed = await internal('/refund-result', {
			reservationId: booking.reservation.id,
			paymentRef: 'pi_late',
			reason: 'late_payment',
			amountMinor: 10_000,
			status: 'failed',
		})
		expect(failed.status).toBe(204)
		const row = await reservationRow(booking.reservation.id)
		expect(row.paymentStatus).toBe('review')
		const db = await getTenantDb(ORG)
		const alerts = await db
			.select()
			.from(rsvOutbox)
			.where(eq(rsvOutbox.kind, 'manager_alert'))
		expect(
			alerts.some(
				(a) => (a.payload as { kind?: string }).kind === 'payment_review',
			),
		).toBe(true)
		const rows = await paymentRows(row.id)
		expect(rows.find((r) => r.kind === 'deposit_charge')!.status).toBe('review')
		// The failure is idempotent.
		expect(
			(
				await internal('/refund-result', {
					reservationId: booking.reservation.id,
					paymentRef: 'pi_late',
					reason: 'late_payment',
					amountMinor: 10_000,
					status: 'failed',
				})
			).status,
		).toBe(204)
	})
})

describe('refunds', () => {
	it('refunds a free guest cancellation in full, reverses the fee and records it (VAL-PAY-041)', async () => {
		const booking = await bookDeposit()
		await payDeposit(booking, { bp: 1000 })
		await guestCancelReservation({
			orgId: ORG,
			reservationId: booking.reservation.id,
		})
		const row = await reservationRow(booking.reservation.id)
		expect(row).toMatchObject({
			status: 'cancelled',
			cancelledBy: 'guest',
			lateCancel: false,
			paymentStatus: 'refund_pending',
		})
		const db = await getTenantDb(ORG)
		const outbox = await db
			.select()
			.from(rsvOutbox)
			.where(eq(rsvOutbox.kind, 'refund_request'))
		expect(outbox).toHaveLength(1)
		const refundId = (outbox[0]!.payload as { refundRequestId: string })
			.refundRequestId
		const claim = await internal('/refund-claim', { refundRequestId: refundId })
		expect(claim.status).toBe(200)
		expect(claim.body.refunds[0]).toMatchObject({
			refundRequestId: refundId,
			paymentRef: `pi_${row.id}`,
			amountMinor: 10_000,
			paymentAmountMinor: 10_000,
			platformFeeMinor: 1000,
			feeReversalMinor: 1000,
		})
		// A second claim while the first is in flight is refused.
		expect(
			(await internal('/refund-claim', { refundRequestId: refundId })).status,
		).toBe(409)
		await internal('/refund-result', {
			refundRequestId: refundId,
			refundRef: 're_1',
			amountMinor: 10_000,
			status: 'succeeded',
		})
		expect((await reservationRow(row.id)).paymentStatus).toBe('refunded')
		const [parent] = (await paymentRows(row.id)).filter(
			(r) => r.kind === 'deposit_charge',
		)
		expect(parent).toMatchObject({ status: 'refunded', refundedMinor: 10_000 })
		expect(await messageKinds(row.id)).toContain('refund_issued')
		// Reporting the same result again is inert.
		await internal('/refund-result', {
			refundRequestId: refundId,
			refundRef: 're_1',
			amountMinor: 10_000,
			status: 'succeeded',
		})
		expect(
			(await messageKinds(row.id)).filter((k) => k === 'refund_issued'),
		).toHaveLength(1)
	})

	async function lateGuestCancel(
		policy: Partial<typeof rsvPolicies.$inferInsert>,
		n: number,
	) {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvPolicies)
			.set(policy)
			.where(eq(rsvPolicies.id, 'pol_dep'))
		const booking = await bookDeposit(n, 4)
		await payDeposit(booking, { sessionId: `cs_${n}` })
		// A policy window wider than the booking's lead time makes the cancel late.
		await db
			.update(rsvReservations)
			.set({
				policySnapshot: {
					...((await reservationRow(booking.reservation.id))
						.policySnapshot as object),
					cancelCutoffMin: 60 * 24 * 30,
				},
			})
			.where(eq(rsvReservations.id, booking.reservation.id))
		await guestCancelReservation({
			orgId: ORG,
			reservationId: booking.reservation.id,
		})
		return booking.reservation.id
	}

	it('refunds nothing inside the window under rule none and half under partial (VAL-PAY-042)', async () => {
		const none = await lateGuestCancel({ refundRule: 'none' }, 1)
		expect(
			(await paymentRows(none)).filter((r) => r.kind === 'refund'),
		).toHaveLength(0)
		expect((await reservationRow(none)).lateCancel).toBe(true)
		const partial = await lateGuestCancel(
			{ refundRule: 'partial', partialRefundBp: 5000 },
			2,
		)
		const refunds = (await paymentRows(partial)).filter(
			(r) => r.kind === 'refund',
		)
		expect(refunds).toHaveLength(1)
		expect(refunds[0]!.amountMinor).toBe(5000)
	})

	it('always refunds a restaurant cancellation in full (VAL-PAY-043)', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvPolicies)
			.set({ refundRule: 'none' })
			.where(eq(rsvPolicies.id, 'pol_dep'))
		const booking = await bookDeposit()
		await payDeposit(booking)
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: booking.reservation.id,
			actorId: OPERATOR_ID,
			input: { status: 'cancelled', cancelReason: 'closed' },
		})
		const refunds = (await paymentRows(booking.reservation.id)).filter(
			(r) => r.kind === 'refund',
		)
		expect(refunds).toHaveLength(1)
		expect(refunds[0]).toMatchObject({
			amountMinor: 10_000,
			status: 'requested',
		})
	})

	it('cannot undo a cancellation once a refund was requested', async () => {
		const booking = await bookDeposit()
		await payDeposit(booking)
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: booking.reservation.id,
			actorId: OPERATOR_ID,
			input: { status: 'cancelled' },
		})
		const { undoReservationTransition } =
			await import('../services/rsv-booking-service.ts')
		await expect(
			undoReservationTransition({
				orgId: ORG,
				reservationId: booking.reservation.id,
				actorId: OPERATOR_ID,
			}),
		).rejects.toMatchObject({ code: 'cannot_undo' })
	})

	it('accumulates operator partial refunds, refuses over-refunds and sums fee reversals (VAL-PAY-044, 009)', async () => {
		await seedPolicy({ id: 'pol_flat', amountMinor: 3333, perCover: false })
		const booking = await bookDeposit(1, 2)
		await payDeposit(booking, { bp: 1000 })
		const first = await operatorCall(
			'POST',
			`/payments/reservations/${booking.reservation.id}/refund`,
			{ amountMinor: 1667, reason: 'goodwill' },
		)
		expect(first.status).toBe(201)
		const tooMuch = await operatorCall(
			'POST',
			`/payments/reservations/${booking.reservation.id}/refund`,
			{ amountMinor: 1667, reason: 'too much' },
		)
		expect(tooMuch.status).toBe(409)
		expect(tooMuch.body.error).toBe('refund_exceeds_paid')
		const second = await operatorCall(
			'POST',
			`/payments/reservations/${booking.reservation.id}/refund`,
			{ amountMinor: 1666, reason: 'rest' },
		)
		expect(second.status).toBe(201)
		const claim = await internal('/refund-claim', {})
		const reversals = claim.body.refunds.map(
			(r: { feeReversalMinor: number }) => r.feeReversalMinor,
		)
		expect(reversals).toEqual([167, 166])
		expect(reversals.reduce((a: number, b: number) => a + b, 0)).toBe(333)
		const db = await getTenantDb(ORG)
		const audit = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.action, 'payment.refund_requested'))
		expect(audit).toHaveLength(2)
	})

	it('shows a pending refund and settles it later (VAL-PAY-045)', async () => {
		const booking = await bookDeposit()
		await payDeposit(booking)
		const requested = await operatorCall(
			'POST',
			`/payments/reservations/${booking.reservation.id}/refund`,
			{ reason: 'full' },
		)
		const refundId = requested.body.refundId
		await internal('/refund-claim', { refundRequestId: refundId })
		await internal('/refund-result', {
			refundRequestId: refundId,
			refundRef: 're_async',
			amountMinor: 10_000,
			status: 'pending',
		})
		expect((await reservationRow(booking.reservation.id)).paymentStatus).toBe(
			'refund_pending',
		)
		const pending = await internal('/pending', {})
		expect(pending.body.refunds[0]).toMatchObject({
			refundRequestId: refundId,
			refundRef: 're_async',
		})
		await internal('/refund-result', {
			refundRequestId: refundId,
			refundRef: 're_async',
			amountMinor: 10_000,
			status: 'succeeded',
		})
		expect((await reservationRow(booking.reservation.id)).paymentStatus).toBe(
			'refunded',
		)
	})
})

describe('card guarantee and staff fees', () => {
	async function guaranteedBooking(n = 1) {
		await seedPolicy({ id: 'pol_guar', kind: 'card_guarantee' })
		const booking = await bookDeposit(n, 4)
		expect(booking.payment).toMatchObject({
			purpose: 'guarantee',
			amountMinor: 0,
		})
		const sessionId = `cs_setup_${n}`
		const quote = await internal('/quote', {
			reservationId: booking.reservation.id,
			paymentToken: booking.payment.paymentToken,
			purpose: 'guarantee',
		})
		expect(quote.body).toMatchObject({ mode: 'setup', amountMinor: 0 })
		expect(quote.body.consent.noShowFeeMinor).toBe(10_000)
		await internal('/bind', {
			reservationId: booking.reservation.id,
			purpose: 'guarantee',
			sessionId,
			processor: 'stripe',
			providerCustomerRef: 'cus_1',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		const done = await internal('/status', {
			reservationId: booking.reservation.id,
			purpose: 'guarantee',
			sessionId,
			processor: 'stripe',
			status: 'setup_succeeded',
			amountMinor: 0,
			currency: 'USD',
			paymentMethodRef: 'pm_1',
			providerCustomerRef: 'cus_1',
			card: { brand: 'visa', last4: '3155', expMonth: 12, expYear: 2031 },
		})
		expect(done.status).toBe(200)
		return booking
	}

	async function markNoShow(reservationId: string) {
		await transitionReservationStatus({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR_ID,
			input: { status: 'no_show' },
		})
	}

	it('stores only card display facts and marks the booking guaranteed (VAL-PAY-032)', async () => {
		const booking = await guaranteedBooking()
		const row = await reservationRow(booking.reservation.id)
		expect(row).toMatchObject({ status: 'booked', paymentStatus: 'guaranteed' })
		const [setup] = await paymentRows(row.id)
		expect(setup).toMatchObject({
			kind: 'card_setup',
			status: 'succeeded',
			customerRef: 'cus_1',
			paymentMethodRef: 'pm_1',
			cardBrand: 'visa',
			cardLast4: '3155',
			cardExpMonth: 12,
			cardExpYear: 2031,
		})
		expect(await messageKinds(row.id)).toContain('confirmation')
	})

	it('charges the no-show fee only on a staff request, with the exact amount (VAL-PAY-034, 035)', async () => {
		const booking = await guaranteedBooking()
		const id = booking.reservation.id
		await markNoShow(id)
		// Marking no-show charges nothing.
		expect(
			(await paymentRows(id)).filter((r) => r.kind === 'no_show_fee_charge'),
		).toHaveLength(0)
		const version = (await reservationRow(id)).version
		const fee = await operatorCall('POST', `/payments/reservations/${id}/fee`, {
			kind: 'no_show_fee',
			expectedVersion: version,
		})
		expect(fee.status).toBe(201)
		expect(fee.body).toMatchObject({ amountMinor: 10_000, attempt: 1 })
		const claim = await internal('/fee-claim', {
			reservationId: id,
			feeId: fee.body.feeId,
		})
		expect(claim.body).toMatchObject({
			amountMinor: 10_000,
			attempt: 1,
			providerCustomerRef: 'cus_1',
			paymentMethodRef: 'pm_1',
			kind: 'no_show_fee',
		})
		expect(
			(
				await internal('/fee-claim', {
					reservationId: id,
					feeId: fee.body.feeId,
				})
			).status,
		).toBe(409)
		await internal('/fee-result', {
			reservationId: id,
			feeId: fee.body.feeId,
			attempt: 1,
			paymentRef: 'pi_fee',
			status: 'succeeded',
			platformFeeBp: 1000,
			platformFeeMinor: 1000,
		})
		expect((await reservationRow(id)).paymentStatus).toBe('fee_charged')
		const [feeRow] = (await paymentRows(id)).filter(
			(r) => r.kind === 'no_show_fee_charge',
		)
		expect(feeRow).toMatchObject({
			status: 'succeeded',
			amountMinor: 10_000,
			platformFeeBp: 1000,
			platformFeeMinor: 1000,
		})
		expect(await messageKinds(id)).toContain('fee_charged')
		const db = await getTenantDb(ORG)
		expect(
			await db
				.select()
				.from(rsvAuditLog)
				.where(eq(rsvAuditLog.action, 'payment.fee_requested')),
		).toHaveLength(1)
	})

	it('validates fee requests (VAL-PAY-040)', async () => {
		const booking = await guaranteedBooking(8)
		const id = booking.reservation.id
		// Not no-show yet.
		let version = (await reservationRow(id)).version
		const early = await operatorCall(
			'POST',
			`/payments/reservations/${id}/fee`,
			{ kind: 'no_show_fee', expectedVersion: version },
		)
		expect(early.status).toBe(409)
		expect(early.body.error).toBe('fee_not_allowed')
		await markNoShow(id)
		version = (await reservationRow(id)).version
		for (const [body, code] of [
			[
				{ kind: 'no_show_fee', amountMinor: 10_001, expectedVersion: version },
				'fee_not_allowed',
			],
			[
				{ kind: 'no_show_fee', amountMinor: 49, expectedVersion: version },
				'fee_not_allowed',
			],
			[{ kind: 'no_show_fee', expectedVersion: version + 5 }, 'stale_version'],
		] as const) {
			const res = await operatorCall(
				'POST',
				`/payments/reservations/${id}/fee`,
				body,
			)
			expect(res.status).toBe(409)
			expect(res.body.error).toBe(code)
		}
		expect(
			(await paymentRows(id)).filter((r) => r.kind === 'no_show_fee_charge'),
		).toHaveLength(0)
		const lowered = await operatorCall(
			'POST',
			`/payments/reservations/${id}/fee`,
			{ kind: 'no_show_fee', amountMinor: 8000, expectedVersion: version },
		)
		expect(lowered.status).toBe(201)
		expect(lowered.body.amountMinor).toBe(8000)
		// One in flight at a time.
		const duplicate = await operatorCall(
			'POST',
			`/payments/reservations/${id}/fee`,
			{
				kind: 'no_show_fee',
				expectedVersion: (await reservationRow(id)).version,
			},
		)
		expect(duplicate.status).toBe(409)
	})

	it('allows exactly one retry after a decline (VAL-PAY-037)', async () => {
		const booking = await guaranteedBooking()
		const id = booking.reservation.id
		await markNoShow(id)
		const request = async () =>
			operatorCall('POST', `/payments/reservations/${id}/fee`, {
				kind: 'no_show_fee',
				expectedVersion: (await reservationRow(id)).version,
			})
		const first = await request()
		await internal('/fee-claim', { reservationId: id, feeId: first.body.feeId })
		await internal('/fee-result', {
			reservationId: id,
			feeId: first.body.feeId,
			attempt: 1,
			status: 'failed',
			declineCode: 'generic_decline',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		expect((await reservationRow(id)).paymentStatus).toBe('fee_failed')
		const retry = await request()
		expect(retry.status).toBe(201)
		expect(retry.body.attempt).toBe(2)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(rsvPayments)
			.where(eq(rsvPayments.reservationId, id))
		expect(
			rows
				.filter((r) => r.kind === 'no_show_fee_charge')
				.map((r) => [r.attempt, r.status, r.declineCode, r.idempotencyKey]),
		).toEqual([
			[1, 'failed', 'generic_decline', `rsv:${id}:no_show_fee:1`],
			[2, 'pending', null, `rsv:${id}:no_show_fee:2`],
		])
		await internal('/fee-claim', { reservationId: id, feeId: retry.body.feeId })
		await internal('/fee-result', {
			reservationId: id,
			feeId: retry.body.feeId,
			attempt: 2,
			status: 'failed',
			declineCode: 'generic_decline',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		const third = await request()
		expect(third.status).toBe(409)
		expect(third.body.reason).toBe('retry_limit')
	})

	it('recovers authentication_required through a pay link (VAL-PAY-038)', async () => {
		const booking = await guaranteedBooking()
		const id = booking.reservation.id
		await markNoShow(id)
		const fee = await operatorCall('POST', `/payments/reservations/${id}/fee`, {
			kind: 'no_show_fee',
			expectedVersion: (await reservationRow(id)).version,
		})
		await internal('/fee-claim', { reservationId: id, feeId: fee.body.feeId })
		await internal('/fee-result', {
			reservationId: id,
			feeId: fee.body.feeId,
			attempt: 1,
			status: 'requires_action',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		const [row] = (await paymentRows(id)).filter(
			(r) => r.kind === 'no_show_fee_charge',
		)
		expect(row!.status).toBe('requires_action')
		expect(await messageKinds(id)).toContain('fee_action_required')
		// The pay link's token quotes the fee, a bad one does not.
		const { deriveFeePayToken } =
			await import('../lib/reservations-public-auth.ts')
		const token = deriveFeePayToken(ORG, fee.body.feeId)
		const quote = await internal('/quote', {
			feeId: fee.body.feeId,
			paymentToken: token,
			purpose: 'fee',
		})
		expect(quote.status).toBe(200)
		expect(quote.body).toMatchObject({
			purpose: 'fee',
			feeKind: 'no_show_fee',
			amountMinor: 10_000,
		})
		expect(
			(
				await internal('/quote', {
					feeId: fee.body.feeId,
					paymentToken: `${token}x`,
					purpose: 'fee',
				})
			).status,
		).toBe(404)
		await internal('/bind', {
			reservationId: id,
			feeId: fee.body.feeId,
			purpose: 'fee',
			sessionId: 'cs_fee',
			processor: 'stripe',
			platformFeeBp: 500,
			platformFeeMinor: 500,
		})
		const paid = await internal('/status', {
			reservationId: id,
			feeId: fee.body.feeId,
			purpose: 'fee',
			sessionId: 'cs_fee',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 10_000,
			currency: 'USD',
			paymentRef: 'pi_fee_link',
		})
		expect(paid.body.outcome).toBe('recorded')
		expect((await reservationRow(id)).paymentStatus).toBe('fee_charged')
		expect(await messageKinds(id)).toContain('fee_charged')
	})

	it('charges a late-cancel fee after a late guest cancellation (VAL-PAY-036)', async () => {
		const booking = await guaranteedBooking()
		const id = booking.reservation.id
		const db = await getTenantDb(ORG)
		await db
			.update(rsvReservations)
			.set({
				policySnapshot: {
					...((await reservationRow(id)).policySnapshot as object),
					cancelCutoffMin: 60 * 24 * 30,
				},
			})
			.where(eq(rsvReservations.id, id))
		await guestCancelReservation({ orgId: ORG, reservationId: id })
		const row = await reservationRow(id)
		expect(row).toMatchObject({
			status: 'cancelled',
			lateCancel: true,
			cancelledBy: 'guest',
			// The card stays on file for the late-cancel fee.
			paymentStatus: 'guaranteed',
		})
		const fee = await operatorCall('POST', `/payments/reservations/${id}/fee`, {
			kind: 'late_cancel_fee',
			expectedVersion: row.version,
		})
		expect(fee.status).toBe(201)
		// Flat $50.00 late-cancel fee; policy is per-cover so 4 covers cap at $100.
		expect(fee.body.amountMinor).toBe(10_000)
	})

	it('never charges a fee automatically: an auto no-show creates no fee row (VAL-PAY-035)', async () => {
		const booking = await guaranteedBooking()
		const id = booking.reservation.id
		const db = await getTenantDb(ORG)
		const start = Date.now() - 60 * 60_000
		await db
			.update(rsvReservations)
			.set({ startAt: start, endAt: start + 90 * 60_000 })
			.where(eq(rsvReservations.id, id))
		await db
			.update(rsvLocationSettings)
			.set({ autoNoShowAfterMin: 15 })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		await runReservationsTickForOrg(ORG, {
			deps: {
				getContext: async () => publicContext(ORG),
				paymentPost: async () => ({ status: 'delivered' }),
			},
		})
		expect((await reservationRow(id)).status).toBe('no_show')
		expect(
			(await paymentRows(id)).filter((r) => r.kind !== 'card_setup'),
		).toHaveLength(0)
		// The staff action afterwards works.
		const fee = await operatorCall('POST', `/payments/reservations/${id}/fee`, {
			kind: 'no_show_fee',
			expectedVersion: (await reservationRow(id)).version,
		})
		expect(fee.status).toBe(201)
	})

	it('counts a guaranteed booking as unsettled until the guarantee is released (VAL-PAY-050)', async () => {
		const { getRegionalReservationSummary } =
			await import('../services/rsv-day-feed-service.ts')
		const db = await getTenantDb(ORG)
		const booking = await guaranteedBooking()
		expect((await getRegionalReservationSummary(db)).unsettledPayments).toBe(1)
		await guestCancelReservation({
			orgId: ORG,
			reservationId: booking.reservation.id,
		})
		expect((await getRegionalReservationSummary(db)).unsettledPayments).toBe(0)
	})

	it('releases a guarantee when a free cancellation happens', async () => {
		const booking = await guaranteedBooking()
		await guestCancelReservation({
			orgId: ORG,
			reservationId: booking.reservation.id,
		})
		expect((await reservationRow(booking.reservation.id)).paymentStatus).toBe(
			'none',
		)
	})
})

describe('operator payment routes and access', () => {
	it('lists payment rows with display facts only (VAL-PAY-049)', async () => {
		const booking = await bookDeposit()
		await payDeposit(booking)
		const res = await operatorCall(
			'GET',
			`/payments/reservations/${booking.reservation.id}`,
		)
		expect(res.status).toBe(200)
		expect(res.body.payments[0]).toMatchObject({
			kind: 'deposit_charge',
			status: 'succeeded',
			amountMinor: 10_000,
		})
		expect(JSON.stringify(res.body)).not.toMatch(/pi_|cs_test|providerRef/)
	})

	it('refuses grantless, wrong-scope and impersonated tokens (VAL-PAY-039)', async () => {
		const booking = await bookDeposit()
		const id = booking.reservation.id
		const body = { kind: 'no_show_fee', expectedVersion: 1 }
		const noPaymentGrant = await operatorToken([
			RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
		])
		expect(
			[401, 403].includes(
				(
					await operatorCall(
						'POST',
						`/payments/reservations/${id}/fee`,
						body,
						noPaymentGrant,
					)
				).status,
			),
		).toBe(true)
		const wrongScope = await operatorToken(PAYMENT_GRANTS, 'book')
		const impersonated = await operatorToken(PAYMENT_GRANTS, 'payments', {
			impersonated: true,
		})
		for (const token of [wrongScope, impersonated]) {
			const res = await operatorCall(
				'POST',
				`/payments/reservations/${id}/fee`,
				body,
				token,
			)
			expect([401, 403]).toContain(res.status)
		}
		// Nothing was written by any refused call.
		expect(
			(await paymentRows(id)).filter((r) => r.kind === 'no_show_fee_charge'),
		).toHaveLength(0)
	})

	it('refuses a reservation outside the token locations', async () => {
		const booking = await bookDeposit()
		const scoped = await operatorToken(PAYMENT_GRANTS, 'payments', {
			locationIds: ['loc_elsewhere'],
		})
		const res = await operatorCall(
			'GET',
			`/payments/reservations/${booking.reservation.id}`,
			undefined,
			scoped,
		)
		expect([403, 404]).toContain(res.status)
	})
})

describe('internal route security', () => {
	it('needs the internal command token on every endpoint', async () => {
		for (const route of [
			'/quote',
			'/bind',
			'/status',
			'/fee-claim',
			'/fee-result',
			'/refund-claim',
			'/refund-result',
			'/dispute',
			'/pending',
		]) {
			expect((await internal(route, {}, null)).status).toBe(401)
			expect(
				(await internal(route, {}, 'wrong-token-wrong-token-1234')).status,
			).toBe(401)
		}
	})

	it('refuses an unknown organization and never echoes rejected values', async () => {
		const res = await app.request('/api/reservations/payments/pending', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${INTERNAL_TOKEN}`,
				'Content-Type': 'application/json',
				'x-forwarded-for': '10.9.9.9',
			},
			body: JSON.stringify({ orgId: 'org_nobody' }),
		})
		expect(res.status).toBeGreaterThanOrEqual(400)
		const bad = await internal('/bind', {
			reservationId: 'x',
			secret: 'leak-me',
		})
		expect(bad.status).toBe(400)
		expect(JSON.stringify(bad.body)).not.toContain('leak-me')
	})

	it('cannot cross organizations: another org never sees this reservation', async () => {
		const booking = await bookDeposit()
		const res = await app.request('/api/reservations/payments/quote', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${INTERNAL_TOKEN}`,
				'Content-Type': 'application/json',
				'x-forwarded-for': '10.9.9.8',
			},
			body: JSON.stringify({
				orgId: ORG_B,
				reservationId: booking.reservation.id,
				paymentToken: booking.payment.paymentToken,
				purpose: 'deposit',
			}),
		})
		expect([404, 500]).toContain(res.status)
	})
})

describe('disputes and the region guard', () => {
	it('records a dispute by payment reference and alerts managers (VAL-PAY-046)', async () => {
		const booking = await bookDeposit()
		await payDeposit(booking)
		const res = await internal('/dispute', {
			paymentRef: `pi_${booking.reservation.id}`,
			disputeRef: 'dp_1',
			status: 'opened',
		})
		expect(res.status).toBe(204)
		expect((await reservationRow(booking.reservation.id)).paymentStatus).toBe(
			'disputed',
		)
		const db = await getTenantDb(ORG)
		const alerts = await db
			.select()
			.from(rsvOutbox)
			.where(eq(rsvOutbox.kind, 'manager_alert'))
		expect(
			alerts.some(
				(a) => (a.payload as { kind?: string }).kind === 'dispute_opened',
			),
		).toBe(true)
		// A repeat changes nothing.
		await internal('/dispute', {
			paymentRef: `pi_${booking.reservation.id}`,
			disputeRef: 'dp_1',
			status: 'opened',
		})
		const [parent] = await paymentRows(booking.reservation.id)
		expect(parent!.disputeStatus).toBe('opened')
	})

	it('counts guaranteed and in-flight payments as unsettled (VAL-PAY-050)', async () => {
		const { getRegionalReservationSummary } =
			await import('../services/rsv-day-feed-service.ts')
		const db = await getTenantDb(ORG)
		expect((await getRegionalReservationSummary(db)).unsettledPayments).toBe(0)
		const booking = await bookDeposit()
		// A booking awaiting payment is unsettled (money may be in flight).
		expect((await getRegionalReservationSummary(db)).unsettledPayments).toBe(1)
		await payDeposit(booking)
		expect((await getRegionalReservationSummary(db)).unsettledPayments).toBe(0)
		void inArray
	})
})

describe('experience bookings and payments', () => {
	async function publishedExperience(
		slug: string,
		policyId: string | null,
		over: { priceMinor?: number | null } = {},
	) {
		const db = await getTenantDb(ORG)
		const base = { orgId: ORG, actorId: 'usr_exp', locationId: PUBLIC_LOC }
		const experience = await createExperience(db, {
			...base,
			input: {
				slug,
				kind: 'ticketed' as const,
				nameI18n: { en: `Chef ${slug}` },
				priceMinor: over.priceMinor === undefined ? 7500 : over.priceMinor,
				pricePerCover: true,
				policyId,
				partyMin: 1,
				partyMax: 6,
				usesTables: false,
				exclusive: false,
				sort: 0,
			},
		})
		await createExperienceSchedule(db, {
			...base,
			experienceId: experience.id,
			input: {
				fromDate: DAY,
				toDate: DAY,
				daysMask: 127,
				seatingMins: [19 * 60],
				turnMin: 90,
				coversCapPerSeating: 8,
				areaIds: null,
				serviceId: null,
			},
		})
		await publishExperience(db, { ...base, experienceId: experience.id })
		return experience.id
	}

	function withExperiences() {
		seedReservationsContextForTest(
			ORG,
			publicContext(ORG, {
				experiences: true,
				payments: { processor: 'connect', deposit: true, guarantee: true },
			}),
		)
	}

	async function bookExperience(
		experienceId: string,
		n: number,
		partySize = 2,
	) {
		const hold = await publicCall('POST', '/reservations/holds', {
			body: {
				locationId: PUBLIC_LOC,
				experienceId,
				slot: { date: DAY, localMin: 19 * 60, partySize },
			},
		})
		expect(hold.status).toBe(201)
		const booked = await publicCall('POST', '/reservations', {
			headers: { 'Idempotency-Key': key() },
			body: {
				holdToken: hold.body.holdToken,
				guest: {
					firstName: `Exp${n}`,
					lastName: 'Guest',
					phone: `+1415555${String(3000 + n)}`,
					email: `exp${n}@example.com`,
				},
				locale: 'en',
				smsOptIn: false,
				website: '',
				policyAccepted: { termsVersion: '1' },
			},
		})
		return { hold, booked }
	}

	it('charges the ticket price per cover through the same checkout (VAL-EXP-010)', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_prepay',
			locationId: PUBLIC_LOC,
			name: 'Prepay',
			kind: 'prepay',
			amountMinor: 1,
			currency: 'USD',
			freeCancelUntilMin: 1440,
			refundRule: 'full_before_window',
			termsI18n: { en: 'Prepay terms' },
		})
		withExperiences()
		const experienceId = await publishedExperience('chefs', 'pol_prepay')
		const { booked } = await bookExperience(experienceId, 1, 2)
		expect(booked.status).toBe(201)
		expect(booked.body.reservation.status).toBe('pending_payment')
		expect(booked.body.payment).toMatchObject({
			purpose: 'experience',
			amountMinor: 15_000,
			currency: 'USD',
		})
		const quote = await internal('/quote', {
			reservationId: booked.body.reservation.id,
			paymentToken: booked.body.payment.paymentToken,
			purpose: 'experience',
		})
		expect(quote.body).toMatchObject({
			quantity: 2,
			unitAmountMinor: 7500,
			productLabel: 'Chef chefs',
		})
		const row = await reservationRow(booked.body.reservation.id)
		expect(row.experienceId).toBe(experienceId)
		// Table-less: no occupancy rows for the unpaid ticket.
		const occ = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, row.id))
		expect(occ).toHaveLength(0)
		const paid = await internal('/bind', {
			reservationId: row.id,
			purpose: 'experience',
			sessionId: 'cs_exp',
			processor: 'stripe',
			platformFeeBp: 250,
			platformFeeMinor: 375,
		})
		expect(paid.status).toBe(204)
		const status = await internal('/status', {
			reservationId: row.id,
			purpose: 'experience',
			sessionId: 'cs_exp',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 15_000,
			currency: 'USD',
			paymentRef: 'pi_exp',
		})
		expect(status.body.outcome).toBe('recorded')
		expect(await reservationRow(row.id)).toMatchObject({
			status: 'booked',
			paymentStatus: 'paid',
		})
		expect(await messageKinds(row.id)).toContain('payment_received')
	})

	it('books straight through when there is no payment policy (VAL-EXP-011)', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvLocationSettings)
			.set({ defaultPolicyId: null })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		withExperiences()
		const experienceId = await publishedExperience('prix', null)
		const { booked } = await bookExperience(experienceId, 2, 2)
		expect(booked.status).toBe(201)
		expect(booked.body.reservation.status).toBe('booked')
		expect(booked.body.payment).toBeUndefined()
		expect(await paymentRows(booked.body.reservation.id)).toHaveLength(0)
		expect(await messageKinds(booked.body.reservation.id)).toContain(
			'confirmation',
		)
	})

	it('refuses to bring a late-paid pool booking back and refunds instead', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_prepay',
			locationId: PUBLIC_LOC,
			name: 'Prepay',
			kind: 'prepay',
			amountMinor: 1,
			currency: 'USD',
			freeCancelUntilMin: 0,
			termsI18n: { en: 'x' },
		})
		withExperiences()
		const experienceId = await publishedExperience('late', 'pol_prepay')
		const { booked } = await bookExperience(experienceId, 3, 2)
		const id = booked.body.reservation.id
		await internal('/bind', {
			reservationId: id,
			purpose: 'experience',
			sessionId: 'cs_exp_late',
			processor: 'stripe',
			platformFeeBp: 0,
			platformFeeMinor: 0,
		})
		await db
			.update(rsvReservations)
			.set({ paymentExpiresAt: Date.now() - 1000 })
			.where(eq(rsvReservations.id, id))
		await runReservationsTickForOrg(ORG, {
			deps: {
				getContext: async () => publicContext(ORG),
				paymentPost: async () => ({ status: 'delivered' }),
			},
		})
		expect((await reservationRow(id)).status).toBe('expired')
		const late = await internal('/status', {
			reservationId: id,
			purpose: 'experience',
			sessionId: 'cs_exp_late',
			processor: 'stripe',
			status: 'paid',
			amountMinor: 15_000,
			currency: 'USD',
			paymentRef: 'pi_exp_late',
		})
		expect(late.body.outcome).toBe('refund_required')
	})
})
