import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	publicAvailabilityResponseSchema,
	publicBookingResponseSchema,
	publicCalendarResponseSchema,
	publicConfigResponseSchema,
	publicErrorResponseSchema,
	publicHoldResponseSchema,
	publicJoinWaitlistResponseSchema,
	publicManageViewSchema,
	publicMineResponseSchema,
	publicPaymentStatusResponseSchema,
	publicWaitlistStatusResponseSchema,
} from '@repo/reservations'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	rsvLocationSettings,
	rsvPolicies,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { brand } from '@repo/config/brand'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ZodTypeAny } from 'zod'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { resetPublicRateLimits } from '../lib/reservations-public-auth.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
	US_ORIGIN,
} from './reservations-public-fixture.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

/**
 * The public reservations contract, as the customer app (`apps/customer`) consumes it.
 *
 * The canonical fixtures live in `packages/reservations/contract-fixtures`.
 * This suite drives the real public routes in process with the same headers
 * the customer app sends (`Origin`, `X-Client`, customer Bearer token, no
 * Turnstile token) and
 *
 *   1. checks every canonical fixture parses with the public response schemas,
 *   2. checks the live responses have exactly the fixture's key structure, so
 *      a server change that adds, removes or retypes a field fails here until
 *      the fixtures are re-recorded,
 *   3. checks the customer app's tests import every canonical file (they
 *      read this folder directly; there are no copies).
 *
 * Re-record with `npm run fixtures:reservations -w tenant-api`. Recording uses
 * only the seeded demo data below and normalizes every volatile value
 * (timestamps, ids, tokens), so recording twice leaves `git status` clean.
 */

const ORG = 'org_contract_us'
const JWT_SECRET = 'test-public-customer-jwt-secret-123456'
const RECORD = process.env.RECORD_RESERVATIONS_FIXTURES === '1'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CANONICAL_DIR = path.join(
	REPO_ROOT,
	'packages/reservations/contract-fixtures',
)
const CUSTOMER_APP_FIXTURES = path.join(
	REPO_ROOT,
	'apps/customer/test/reservations/fixtures.ts',
)
/** Hand-written answers with values a newer region may send; never recorded. */
const FUTURE_DIR = path.join(REPO_ROOT, 'packages/reservations/future-fixtures')
const FUTURE_SCHEMAS: Record<string, ZodTypeAny> = {
	'availability-closed': publicAvailabilityResponseSchema,
	'availability-new-status': publicAvailabilityResponseSchema,
	calendar: publicCalendarResponseSchema,
}

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
	resolveOrganizationForPublicOrigin: vi.fn(async (origin?: string) =>
		origin === 'http://acme.menuza.test:3008'
			? (orgs.get('org_contract_us') ?? null)
			: null,
	),
}))

let tempDir: string
const app = new Hono()
app.route('/reservations', reservationsPublicRoutes)

let counter = 0
const key = () => `contract-key-${++counter}-fixture`

async function mintCustomerToken() {
	return new jose.SignJWT({
		customerId: 'cus_contract_1',
		orgId: ORG,
		orgSlug: 'acme',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(new TextEncoder().encode(JWT_SECRET))
}

type Reply = { status: number; body: any; text: string; res: Response }

async function native(
	method: string,
	urlPath: string,
	options: {
		body?: unknown
		token?: string
		customer?: string
		headers?: Record<string, string>
	} = {},
): Promise<Reply> {
	const headers: Record<string, string> = {
		Origin: US_ORIGIN,
		'X-Client': 'ios',
		...options.headers,
	}
	if (options.customer) headers.Authorization = `Bearer ${options.customer}`
	if (options.token) headers['X-Reservation-Token'] = options.token
	if (options.body !== undefined) headers['Content-Type'] = 'application/json'
	const res = await app.request(urlPath, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	})
	const text = await res.text()
	let body: any = null
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = null
	}
	return { status: res.status, body, text, res }
}

const DAY = dateAhead(10)
const guest = (n: number) => ({
	firstName: `Fixture${n}`,
	lastName: 'Guest',
	phone: `+1415555${String(3000 + n)}`,
	email: `fixture${n}@example.com`,
})

// ---------------------------------------------------------------------------
// Normalization: fixtures must not depend on the clock, random ids or tokens.
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.parse('2030-06-14T16:00:00.000Z')
const FIXED_DAY = '2030-06-24'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type Normalizer = (value: unknown, key: string) => unknown

function makeNormalizer(recordedNow: number): Normalizer {
	const ids = new Map<string, string>()
	const counters = new Map<string, number>()
	const alias = (prefix: string, value: string) => {
		const known = ids.get(value)
		if (known) return known
		const next = (counters.get(prefix) ?? 0) + 1
		counters.set(prefix, next)
		const fixed = `${prefix}${String(next).padStart(4, '0')}`
		ids.set(value, fixed)
		return fixed
	}
	const today = new Date(recordedNow)
	today.setUTCHours(0, 0, 0, 0)
	const dayOffset = (ms: number) =>
		Math.floor((ms - today.getTime()) / 86_400_000)
	const BUSINESS_TIME_KEYS = new Set(['startAt', 'endAt', 'cancelDeadline'])
	const walk: Normalizer = (value, key) => {
		if (typeof value === 'string') {
			if (ISO_RE.test(value)) {
				const ms = Date.parse(value)
				if (key === 'now') return new Date(FIXED_NOW).toISOString()
				if (BUSINESS_TIME_KEYS.has(key)) {
					// Anchored to a business date: keep the local time of day.
					const midnight = Date.UTC(
						new Date(ms).getUTCFullYear(),
						new Date(ms).getUTCMonth(),
						new Date(ms).getUTCDate(),
					)
					const offset = dayOffset(midnight) - 10
					const base = Date.parse(`${FIXED_DAY}T00:00:00Z`)
					return new Date(
						base + offset * 86_400_000 + (ms - midnight),
					).toISOString()
				}
				// Relative to the clock: whole minutes from the recording instant.
				const minutes = Math.round((ms - recordedNow) / 60_000)
				return new Date(FIXED_NOW + minutes * 60_000).toISOString()
			}
			if (DATE_RE.test(value)) {
				const offset = dayOffset(Date.parse(`${value}T00:00:00Z`)) - 10
				const base = Date.parse(`${FIXED_DAY}T00:00:00Z`)
				return new Date(base + offset * 86_400_000).toISOString().slice(0, 10)
			}
			if (key === 'holdToken' || key === 'replaceHoldToken') {
				return alias('hold_fixture_token_', value)
			}
			if (key === 'manageToken') return alias('rsv_m_fixture_', value)
			if (key === 'paymentToken') return alias('rsv_p_fixture_', value)
			if (key === 'statusToken') return alias('rsv_w_fixture_', value)
			if (key === 'cancelToken') return alias('rsv_n_fixture_', value)
			if (key === 'confirmationCode') return alias('FIXT', value)
			if (key === 'payUrl') {
				return value.replace(
					/#r=[^&]+&t=.+$/,
					'#r=rsv_fixture_0001&t=rsv_p_fixture_0001',
				)
			}
			if (
				(key === 'id' || key === 'reservationId') &&
				/^(rsv|wle|hld|rsvr|rsvw|[a-z]{2,5})_?[0-9a-f-]{8,}/i.test(value) &&
				!value.startsWith('loc_') &&
				!value.startsWith('tag_') &&
				!value.startsWith('area_') &&
				!value.startsWith('svc_') &&
				!value.startsWith('tbl_')
			) {
				return alias('rsv_fixture_', value)
			}
			return value
		}
		if (Array.isArray(value)) return value.map((v) => walk(v, key))
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([k, v]) => [
					k,
					walk(v, k),
				]),
			)
		}
		return value
	}
	return walk
}

/** The structure of a JSON value: keys and types, never the values. */
function shapeOf(value: unknown): unknown {
	if (value === null) return 'null'
	if (Array.isArray(value)) {
		const shapes = new Map<string, unknown>()
		for (const item of value) {
			const shape = shapeOf(item)
			shapes.set(JSON.stringify(shape), shape)
		}
		return { array: [...shapes.values()] }
	}
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, shapeOf(v)]),
		)
	}
	return typeof value
}

/**
 * Two shapes agree when every key matches and nullable fields may be `null` in
 * one and a concrete type in the other (a fixture records one sample).
 */
function sameKeys(a: unknown, b: unknown, trail = ''): string[] {
	if (a === 'null' || b === 'null') return []
	if (typeof a === 'string' || typeof b === 'string') {
		return a === b
			? []
			: [`${trail}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
	}
	const aObj = a as Record<string, unknown>
	const bObj = b as Record<string, unknown>
	if ('array' in aObj || 'array' in bObj) {
		const aItems = ((aObj.array as unknown[]) ?? []).filter(
			(s) => s !== undefined,
		)
		const bItems = ((bObj.array as unknown[]) ?? []).filter(
			(s) => s !== undefined,
		)
		if (aItems.length === 0 || bItems.length === 0) return []
		return sameKeys(aItems[0], bItems[0], `${trail}[]`)
	}
	const problems: string[] = []
	for (const k of new Set([...Object.keys(aObj), ...Object.keys(bObj)])) {
		if (!(k in aObj)) problems.push(`${trail}.${k}: missing in fixture`)
		else if (!(k in bObj)) problems.push(`${trail}.${k}: missing in live`)
		else problems.push(...sameKeys(aObj[k], bObj[k], `${trail}.${k}`))
	}
	return problems
}

// ---------------------------------------------------------------------------
// The scenario: seeded acme demo data, driven like the customer app does.
// ---------------------------------------------------------------------------

type Recorded = { name: string; schema: ZodTypeAny; value: unknown }

async function runScenario(): Promise<Recorded[]> {
	const recordedNow = Date.now()
	const out: Recorded[] = []
	const customer = await mintCustomerToken()
	const add = (
		name: string,
		schema: ZodTypeAny,
		reply: Reply,
		status = 200,
	) => {
		expect(reply.status, `${name}: ${reply.text}`).toBe(status)
		out.push({ name, schema, value: reply.body })
	}
	const dbs = await getTenantDb(ORG)
	await dbs.insert(customers).values({
		id: 'cus_contract_1',
		name: 'Fixture Customer',
		phone: '+14155553001',
		phoneVerified: true,
	})

	await dbs
		.update(rsvLocationSettings)
		.set({ waitlistEnabled: true, waitlistOnline: true, notifyMeEnabled: true })
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))

	add(
		'config',
		publicConfigResponseSchema,
		await native('GET', '/reservations/config'),
	)
	add(
		'availability',
		publicAvailabilityResponseSchema,
		await native(
			'GET',
			`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2&localMin=${19 * 60}`,
		),
	)
	add(
		'calendar',
		publicCalendarResponseSchema,
		await native(
			'GET',
			`/reservations/calendar?locationId=${PUBLIC_LOC}&partySize=2&from=${DAY}&to=${dateAhead(13)}`,
		),
	)

	const hold = await native('POST', '/reservations/holds', {
		customer,
		body: {
			locationId: PUBLIC_LOC,
			slot: { date: DAY, localMin: 19 * 60, partySize: 2 },
		},
	})
	add('hold', publicHoldResponseSchema, hold, 201)

	const booked = await native('POST', '/reservations', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: hold.body.holdToken,
			guest: guest(1),
			locale: 'en',
			smsOptIn: false,
			website: '',
		},
	})
	add('booking', publicBookingResponseSchema, booked, 201)
	const manageToken: string = booked.body.manageToken

	add(
		'manage',
		publicManageViewSchema,
		await native('GET', '/reservations/manage', { token: manageToken }),
	)
	add(
		'payment-status-none',
		publicPaymentStatusResponseSchema,
		await native('GET', '/reservations/manage/payment', { token: manageToken }),
	)
	add(
		'mine',
		publicMineResponseSchema,
		await native('GET', '/reservations/mine', { customer }),
	)

	// Large party request (above the online maximum of 4).
	add(
		'request',
		publicBookingResponseSchema,
		await native('POST', '/reservations/requests', {
			customer,
			headers: { 'Idempotency-Key': key() },
			body: {
				locationId: PUBLIC_LOC,
				slot: { date: DAY, localMin: 17 * 60, partySize: 8 },
				guest: guest(2),
				locale: 'en',
				smsOptIn: false,
				website: '',
			},
		}),
		201,
	)

	// Waitlist.
	const joined = await native('POST', '/reservations/waitlist/join', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			locationId: PUBLIC_LOC,
			name: 'Fixture Waiter',
			partySize: 2,
			phone: '+14155553003',
			smsOptIn: false,
			locale: 'en',
		},
	})
	add('waitlist-join', publicJoinWaitlistResponseSchema, joined, 201)
	add(
		'waitlist-status',
		publicWaitlistStatusResponseSchema,
		await native('GET', '/reservations/waitlist/status', {
			token: joined.body.statusToken,
		}),
	)

	// Errors the apps map to messages.
	const gone = await native('POST', '/reservations', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: 'hold_unknown_token_value_0000',
			guest: guest(3),
			locale: 'en',
			smsOptIn: false,
			website: '',
		},
	})
	expect([404, 410]).toContain(gone.status)
	out.push({
		name: `error-hold-${gone.status === 410 ? 'expired' : 'not-found'}`,
		schema: publicErrorResponseSchema,
		value: gone.body,
	})

	const missingKey = await native('POST', '/reservations', {
		customer,
		body: {
			holdToken: hold.body.holdToken,
			guest: guest(4),
			locale: 'en',
			smsOptIn: false,
			website: '',
		},
	})
	expect(missingKey.status).toBe(400)
	out.push({
		name: 'error-invalid',
		schema: publicErrorResponseSchema,
		value: missingKey.body,
	})

	// Deposit booking: payment block, then the pending poll.
	const database = await getTenantDb(ORG)
	await database.insert(rsvPolicies).values({
		id: 'pol_contract_dep',
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
	})
	await database
		.update(rsvLocationSettings)
		.set({ defaultPolicyId: 'pol_contract_dep', onlinePartyMax: 6 })
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
	seedReservationsContextForTest(
		ORG,
		publicContext(ORG, {
			payments: { processor: 'connect', deposit: true, guarantee: true },
		}),
	)
	// A policy that needs consent: booking without it is refused.
	const unconsented = await native('POST', '/reservations/holds', {
		customer,
		body: {
			locationId: PUBLIC_LOC,
			slot: { date: dateAhead(12), localMin: 19 * 60, partySize: 2 },
		},
	})
	expect(unconsented.status).toBe(201)
	const noConsent = await native('POST', '/reservations', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: unconsented.body.holdToken,
			guest: guest(6),
			locale: 'en',
			smsOptIn: false,
			website: '',
		},
	})
	expect(noConsent.status, noConsent.text).toBe(400)
	out.push({
		name: 'error-policy-required',
		schema: publicErrorResponseSchema,
		value: noConsent.body,
	})

	const depositHold = await native('POST', '/reservations/holds', {
		customer,
		body: {
			locationId: PUBLIC_LOC,
			slot: { date: dateAhead(11), localMin: 18 * 60, partySize: 4 },
		},
	})
	add('hold-requires-payment', publicHoldResponseSchema, depositHold, 201)
	const deposit = await native('POST', '/reservations', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: depositHold.body.holdToken,
			guest: guest(5),
			locale: 'en',
			smsOptIn: false,
			website: '',
			policyAccepted: { termsVersion: '2' },
		},
	})
	add('booking-pending-payment', publicBookingResponseSchema, deposit, 201)
	// Too many active bookings for one phone: 429 with a reason.
	const limited = await native('POST', '/reservations', {
		customer,
		headers: { 'Idempotency-Key': key() },
		body: {
			holdToken: unconsented.body.holdToken,
			guest: guest(6),
			locale: 'en',
			smsOptIn: false,
			website: '',
			policyAccepted: { termsVersion: '2' },
		},
	})
	expect(limited.status, limited.text).toBe(429)
	out.push({
		name: 'error-rate-limited',
		schema: publicErrorResponseSchema,
		value: limited.body,
	})

	add(
		'payment-status-pending',
		publicPaymentStatusResponseSchema,
		await native('GET', '/reservations/manage/payment', {
			token: deposit.body.payment.paymentToken,
		}),
	)

	// The same 4-top again: slot_unavailable carries alternatives.
	const taken = await native('POST', '/reservations/holds', {
		customer,
		body: {
			locationId: PUBLIC_LOC,
			slot: { date: dateAhead(11), localMin: 18 * 60, partySize: 4 },
		},
	})
	expect(taken.status).toBe(409)
	out.push({
		name: 'error-slot-unavailable',
		schema: publicErrorResponseSchema,
		value: taken.body,
	})

	// Alternatives: the 18:00 4-top is held, ask again for it.
	const alt = await native(
		'GET',
		`/reservations/availability?locationId=${PUBLIC_LOC}&date=${dateAhead(11)}&partySize=4&localMin=${18 * 60}`,
	)
	out.push({
		name: 'availability-preferred-taken',
		schema: publicAvailabilityResponseSchema,
		value: alt.body,
	})
	expect(alt.status).toBe(200)

	const normalize = makeNormalizer(recordedNow)
	return out.map((r) => ({ ...r, value: normalize(r.value, '') }))
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-contract-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN =
		'test-public-operator-secret-key-32-chars-minimum!!'
	process.env.JWT_SECRET = JWT_SECRET
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	// A verified customer token stands in for Turnstile, so the secret may be
	// configured and the native calls still pass.
	process.env.TURNSTILE_SECRET_KEY = 'contract-turnstile-secret-key-not-real'
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	resetPublicRateLimits()
	orgs.set(ORG, {
		id: ORG,
		slug: 'acme',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	await seedPublicOrg(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
	delete process.env.TURNSTILE_SECRET_KEY
})

function listJson(dir: string) {
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('.json'))
				.sort()
		: []
}

describe('reservations contract fixtures', () => {
	it.runIf(RECORD)('records the canonical fixtures', async () => {
		const recorded = await runScenario()
		fs.rmSync(CANONICAL_DIR, { recursive: true, force: true })
		fs.mkdirSync(CANONICAL_DIR, { recursive: true })
		for (const { name, value } of recorded) {
			const text = `${JSON.stringify(value, null, '\t')}\n`
			fs.writeFileSync(path.join(CANONICAL_DIR, `${name}.json`), text)
		}
	})

	it.skipIf(RECORD)(
		'parses every canonical fixture with the public response schemas',
		async () => {
			const recorded = await runScenario()
			const files = listJson(CANONICAL_DIR)
			expect(files.length).toBeGreaterThanOrEqual(15)
			for (const { name, schema } of recorded) {
				const file = path.join(CANONICAL_DIR, `${name}.json`)
				expect(fs.existsSync(file), `${name}.json is missing`).toBe(true)
				const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
				const parsed = schema.safeParse(fixture)
				expect(
					parsed.success,
					`${name}: ${JSON.stringify(parsed.error?.issues)}`,
				).toBe(true)
			}
			expect(new Set(files)).toEqual(
				new Set(recorded.map((r) => `${r.name}.json`)),
			)
		},
	)

	it.skipIf(RECORD)(
		'matches the live route responses key for key (drift fails here)',
		async () => {
			const recorded = await runScenario()
			for (const { name, value, schema } of recorded) {
				const fixture = JSON.parse(
					fs.readFileSync(path.join(CANONICAL_DIR, `${name}.json`), 'utf8'),
				)
				expect(schema.safeParse(value).success, `${name} live`).toBe(true)
				expect(sameKeys(shapeOf(fixture), shapeOf(value), name), name).toEqual(
					[],
				)
			}
		},
	)

	it.skipIf(RECORD)('is read file by file by the customer app tests', () => {
		const canonical = listJson(CANONICAL_DIR)
		expect(canonical.length).toBeGreaterThan(0)
		const source = fs.readFileSync(CUSTOMER_APP_FIXTURES, 'utf8')
		const imported = [
			...source.matchAll(
				/from '(?:\.\.\/)+packages\/reservations\/contract-fixtures\/([^']+\.json)'/g,
			),
		]
			.map((match) => match[1])
			.sort()
		expect(imported).toEqual(canonical)
	})

	it.skipIf(RECORD)(
		'decodes the future-value fixtures, which recording never deletes',
		() => {
			expect(path.relative(CANONICAL_DIR, FUTURE_DIR).startsWith('..')).toBe(
				true,
			)
			expect(listJson(FUTURE_DIR)).toEqual(
				Object.keys(FUTURE_SCHEMAS)
					.map((name) => `${name}.json`)
					.sort(),
			)
			for (const [name, schema] of Object.entries(FUTURE_SCHEMAS)) {
				const fixture = JSON.parse(
					fs.readFileSync(path.join(FUTURE_DIR, `${name}.json`), 'utf8'),
				)
				const parsed = schema.safeParse(fixture)
				expect(
					parsed.success,
					`${name}: ${JSON.stringify(parsed.error?.issues)}`,
				).toBe(true)
			}
		},
	)

	it.skipIf(RECORD)(
		'lets a verified customer token replace Turnstile with the secret set',
		async () => {
			const customer = await mintCustomerToken()
			await (await getTenantDb(ORG)).insert(customers).values({
				id: 'cus_contract_1',
				name: 'Fixture Customer',
				phone: '+14155553001',
				phoneVerified: true,
			})
			const slot = { date: DAY, localMin: 19 * 60, partySize: 2 }
			const withToken = await native('POST', '/reservations/holds', {
				customer,
				body: { locationId: PUBLIC_LOC, slot },
			})
			expect(withToken.status).toBe(201)
			const without = await native('POST', '/reservations/holds', {
				body: { locationId: PUBLIC_LOC, slot },
			})
			expect(without.status).toBe(403)
			expect(without.body).toEqual({ error: 'verification_failed' })
		},
	)
})
