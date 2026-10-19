import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
} from '@repo/reservations'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	rsvAreas,
	rsvGuests,
	rsvMessages,
	rsvHolds,
	rsvLocationSettings,
	rsvRateCounters,
	rsvReservations,
	rsvServiceAvailability,
	rsvSpecialDays,
	rsvTableOccupancies,
	rsvTables,
} from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { resetPublicRateLimits } from '../lib/reservations-public-auth.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import {
	dateAhead,
	KSA_ORIGIN,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
	UNKNOWN_ORIGIN,
	US_ORIGIN,
} from './reservations-public-fixture.ts'
import { reservationsPublicRoutes } from './reservations-public.ts'

const ORG = 'org_pub_us'
const ORG_KSA = 'org_pub_ksa'
const OPERATOR_SECRET = 'test-public-operator-secret-key-32-chars-minimum!!'
const JWT_SECRET = 'test-public-customer-jwt-secret-123456'
const OPERATOR_ID = 'usr_pub_operator'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
const originToOrg = vi.hoisted(
	() =>
		new Map<string, string>([
			['http://acme.menuza.test:3008', 'org_pub_us'],
			['http://riyadh.menuza.test:3008', 'org_pub_ksa'],
		]),
)

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForPublicOrigin: vi.fn(async (origin?: string) => {
		const id = origin ? originToOrg.get(origin) : undefined
		return id ? (orgs.get(id) ?? null) : null
	}),
}))

let tempDir: string
const app = new Hono()
app.route('/reservations', reservationsPublicRoutes)
app.route('/operator/reservations', reservationsOperatorRoutes)

type CallOptions = {
	origin?: string | null
	headers?: Record<string, string>
	body?: unknown
	token?: string
}

async function call(
	method: string,
	urlPath: string,
	options: CallOptions = {},
) {
	const headers: Record<string, string> = { ...options.headers }
	if (options.origin !== null) headers.Origin = options.origin ?? US_ORIGIN
	if (options.token) headers['X-Reservation-Token'] = options.token
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	const res = await app.request(urlPath, { method, headers, body })
	const text = await res.text()
	let parsed: any = null
	try {
		parsed = text ? JSON.parse(text) : null
	} catch {
		parsed = null
	}
	return { res, status: res.status, body: parsed, text }
}

const DAY = dateAhead(10)
const guestFor = (n: number, extra: Record<string, unknown> = {}) => ({
	firstName: `Pat${n}`,
	lastName: `Guest${n}`,
	phone: `+1415555${String(1000 + n)}`,
	email: `pat${n}@example.com`,
	...extra,
})

let keyCounter = 0
function idemKey() {
	keyCounter += 1
	return `test-key-${keyCounter}-${Math.random().toString(36).slice(2, 10)}`
}

async function createHold(
	localMin: number,
	partySize = 2,
	extra: Record<string, unknown> = {},
	options: CallOptions = {},
	date = DAY,
) {
	return call('POST', '/reservations/holds', {
		...options,
		body: {
			locationId: PUBLIC_LOC,
			slot: { date, localMin, partySize },
			...extra,
		},
	})
}

async function book(
	holdToken: string,
	n: number,
	options: {
		key?: string
		headers?: Record<string, string>
		extra?: Record<string, unknown>
		guest?: Record<string, unknown>
	} = {},
) {
	return call('POST', '/reservations', {
		headers: {
			'Idempotency-Key': options.key ?? idemKey(),
			...options.headers,
		},
		body: {
			holdToken,
			guest: guestFor(n, options.guest),
			locale: 'en',
			smsOptIn: false,
			website: '',
			...options.extra,
		},
	})
}

async function holdAndBook(localMin: number, n: number, partySize = 2) {
	const hold = await createHold(localMin, partySize)
	expect(hold.status).toBe(201)
	const booked = await book(hold.body.holdToken, n)
	expect(booked.status).toBe(201)
	return { hold: hold.body, booked: booked.body }
}

function availability(
	partySize = 2,
	date = DAY,
	extra = '',
	options: CallOptions = {},
) {
	return call(
		'GET',
		`/reservations/availability?locationId=${PUBLIC_LOC}&date=${date}&partySize=${partySize}${extra}`,
		options,
	)
}

function slotTimes(body: { slots: Array<{ localMin: number }> }) {
	return body.slots.map((s) => s.localMin)
}

async function mintOperatorToken(
	scope = 'book',
	grants: string[] = [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
	],
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
			payments: false,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject(OPERATOR_ID)
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

async function mintCustomerToken(orgId = ORG, customerId = 'cus_pub_1') {
	return new jose.SignJWT({
		customerId,
		orgId,
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

async function operatorCall(method: string, urlPath: string, body?: unknown) {
	const token = await mintOperatorToken()
	const res = await app.request(`/operator/reservations${urlPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			'Idempotency-Key': idemKey(),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	return { status: res.status, body: (await res.json()) as any }
}

async function setSettings(
	patch: Partial<typeof rsvLocationSettings.$inferInsert>,
) {
	const db = await getTenantDb(ORG)
	await db
		.update(rsvLocationSettings)
		.set(patch)
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-public-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.JWT_SECRET = JWT_SECRET
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	delete process.env.TURNSTILE_SECRET_KEY
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
	orgs.set(ORG_KSA, {
		id: ORG_KSA,
		slug: 'riyadh',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'ksa',
		name: 'Riyadh Grill',
	})
	await seedPublicOrg(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
	process.env.RESERVATIONS_PUBLIC_ENABLED = 'true'
	delete process.env.TURNSTILE_SECRET_KEY
})

describe('GET /reservations/config', () => {
	it('describes the bookable restaurant without any guest data (VAL-ONLINE-001)', async () => {
		await holdAndBook(19 * 60, 1)
		const { res, status, body, text } = await call(
			'GET',
			'/reservations/config',
		)
		expect(status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(body.organization.name).toBe('Acme Bistro')
		expect(body.locations).toHaveLength(1)
		expect(body.locations[0]).toMatchObject({
			id: PUBLIC_LOC,
			name: 'Acme Downtown',
			timeZone: 'UTC',
			partySize: { min: 1, max: 4 },
			horizonDays: 60,
			largeParty: { mode: 'request' },
		})
		expect(body.locations[0].address.formattedAddress).toContain('Main St')
		expect(body.occasions.map((o: { id: string }) => o.id)).toContain(
			'tag_pub_birthday',
		)
		expect(body.dietary.map((o: { id: string }) => o.id)).toContain(
			'tag_pub_nuts',
		)
		expect(text).not.toContain('Pat1')
		expect(text).not.toContain('+1415555')
		expect(text).not.toContain('example.com')
	})

	it('omits locations that are not online-enabled', async () => {
		await setSettings({ onlineEnabled: false })
		const { status, body } = await call('GET', '/reservations/config')
		expect(status).toBe(200)
		expect(body.locations).toEqual([])
	})
})

describe('GET /reservations/availability', () => {
	it('returns grid slots with dayVersion, now and an ETag that changes after a booking (VAL-ONLINE-002)', async () => {
		const first = await availability()
		expect(first.status).toBe(200)
		expect(first.body.timeZone).toBe('UTC')
		expect(Date.parse(first.body.now)).toBeGreaterThan(0)
		expect(typeof first.body.dayVersion).toBe('number')
		const times = slotTimes(first.body)
		expect(times.length).toBeGreaterThan(0)
		for (const t of times) {
			expect(t % 15).toBe(0)
			expect(t).toBeGreaterThanOrEqual(17 * 60)
			expect(t).toBeLessThanOrEqual(21 * 60 + 30)
		}
		const etag = first.res.headers.get('ETag')!
		expect(etag).toBe(
			`"${first.body.dayVersion}.${first.body.settingsVersion}.11"`,
		)
		expect(first.res.headers.get('Cache-Control')).toBe('private, max-age=0')

		const cached = await availability(2, DAY, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(cached.status).toBe(304)
		expect(cached.text).toBe('')

		await holdAndBook(19 * 60, 2)
		const after = await availability(2, DAY, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(after.status).toBe(200)
		expect(after.res.headers.get('ETag')).not.toBe(etag)
	})

	it('changes the ETag on the very first write for a never-mutated date, so the old tag gets 200 (VAL-CROSS-007)', async () => {
		const holdDate = dateAhead(12)
		const first = await availability(2, holdDate)
		expect(first.body.dayVersion).toBe(0)
		const etag = first.res.headers.get('ETag')!
		expect(
			(
				await availability(2, holdDate, '', {
					headers: { 'If-None-Match': etag },
				})
			).status,
		).toBe(304)

		const hold = await createHold(19 * 60, 2, {}, {}, holdDate)
		expect(hold.status).toBe(201)

		const after = await availability(2, holdDate, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(after.status).toBe(200)
		expect(after.body.dayVersion).toBe(1)
		expect(after.res.headers.get('ETag')).not.toBe(etag)
	})

	it('changes the ETag on the first special-day write for a fresh date (VAL-CROSS-007)', async () => {
		const specialDate = dateAhead(14)
		const first = await availability(2, specialDate)
		expect(first.status).toBe(200)
		expect(first.body.dayVersion).toBe(0)
		const etag = first.res.headers.get('ETag')!
		expect(
			(
				await availability(2, specialDate, '', {
					headers: { 'If-None-Match': etag },
				})
			).status,
		).toBe(304)

		const token = await mintOperatorToken('setup', [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
		])
		const created = await app.request(
			`/operator/reservations/setup/locations/${PUBLIC_LOC}/special-days`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					locationId: PUBLIC_LOC,
					fromDate: specialDate,
					toDate: specialDate,
					kind: 'closed',
					name: 'Private event',
				}),
			},
		)
		expect(created.status).toBe(201)

		const after = await availability(2, specialDate, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(after.status).toBe(200)
		expect(after.body.status).toBe('closed')
		expect(after.res.headers.get('ETag')).not.toBe(etag)
	})

	it('changes the ETag on a never-mutated date after a pacing rule or service availability write', async () => {
		const date = dateAhead(16)
		const token = await mintOperatorToken('setup', [
			RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
			RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
		])
		const setup = (method: string, urlPath: string, body?: unknown) =>
			app.request(`/operator/reservations/setup${urlPath}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		const currentEtag = async () =>
			(await availability(2, date)).res.headers.get('ETag')!

		let etag = await currentEtag()
		const pacing = await setup(
			'POST',
			`/locations/${PUBLIC_LOC}/pacing-rules`,
			{ serviceId: 'svc_pub_dinner', bucketMin: 15, maxCovers: 4 },
		)
		expect(pacing.status).toBe(201)
		const afterPacing = await availability(2, date, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(afterPacing.status).toBe(200)
		expect(afterPacing.res.headers.get('ETag')).not.toBe(etag)

		etag = afterPacing.res.headers.get('ETag')!
		const sa = await setup('POST', '/service-availability', {
			serviceId: 'svc_pub_dinner',
			tableId: 'tbl_pub_4',
			mode: 'staff_only',
		})
		expect(sa.status).toBe(201)
		const afterSa = await availability(2, date, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(afterSa.status).toBe(200)
		expect(afterSa.res.headers.get('ETag')).not.toBe(etag)
	})

	it('changes the ETag when the waitlist or online flag changes, so a 304 cannot hide it', async () => {
		const first = await availability()
		const etag = first.res.headers.get('ETag')!
		expect(
			(await availability(2, DAY, '', { headers: { 'If-None-Match': etag } }))
				.status,
		).toBe(304)

		seedReservationsContextForTest(ORG, publicContext(ORG, { waitlist: false }))
		const flipped = await availability(2, DAY, '', {
			headers: { 'If-None-Match': etag },
		})
		expect(flipped.status).toBe(200)
		expect(flipped.res.headers.get('ETag')).not.toBe(etag)
		expect(flipped.body.notifyMe).toBe(false)
	})

	it('rejects party sizes outside 1..99 with party_size_invalid and signals large parties (VAL-ONLINE-006)', async () => {
		expect((await availability(0)).body).toEqual({
			error: 'party_size_invalid',
		})
		expect((await availability(500)).status).toBe(400)
		const okay = await availability(4)
		expect(okay.status).toBe(200)
		expect(okay.body.slots.length).toBeGreaterThan(0)
		const large = await availability(9)
		expect(large.status).toBe(200)
		expect(large.body.slots).toEqual([])
		expect(large.body.largeParty.mode).toBe('request')
		expect(large.body.largeParty.phone).toBe('+12125550100')
	})

	it('shows the contact phone in contact mode (VAL-ONLINE-039)', async () => {
		await setSettings({
			largePartyMode: 'contact',
			contactPhone: '+12125550199',
		})
		const large = await availability(12)
		expect(large.body.largeParty).toMatchObject({
			mode: 'contact',
			phone: '+12125550199',
		})
		const config = await call('GET', '/reservations/config')
		expect(config.body.locations[0].largeParty.mode).toBe('contact')
	})

	it('applies min notice, same-day cutoff, horizon and release time (VAL-ONLINE-005)', async () => {
		await setSettings({ horizonDays: 14 })
		const beyond = await availability(2, dateAhead(15))
		expect(beyond.body.slots).toEqual([])
		expect(beyond.body.status).toBe('beyond_horizon')

		const today = await availability(2, dateAhead(0))
		const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes()
		for (const t of slotTimes(today.body)) {
			expect(t).toBeGreaterThanOrEqual(nowMin + 60)
		}

		await setSettings({ minNoticeMin: 0, sameDayCutoffMin: 0 })
		const cutoff = await availability(2, dateAhead(0))
		expect(cutoff.body.slots).toEqual([])

		const now = new Date()
		const nextMinute = (now.getUTCHours() * 60 + now.getUTCMinutes() + 5) % 1440
		await setSettings({
			sameDayCutoffMin: null,
			releaseLocalMin: nextMinute > 5 ? nextMinute : null,
		})
		const edge = await availability(2, dateAhead(14))
		if (nextMinute > 5) expect(edge.body.slots).toEqual([])
	})

	it('shows closed and online-closed days differently (VAL-ONLINE-007)', async () => {
		const db = await getTenantDb(ORG)
		const closedDate = dateAhead(11)
		const onlineClosedDate = dateAhead(12)
		await db.insert(rsvSpecialDays).values([
			{
				locationId: PUBLIC_LOC,
				fromDate: closedDate,
				toDate: closedDate,
				kind: 'closed',
				name: 'Holiday',
				publicNoteI18n: { en: 'Closed for the holiday' },
			},
			{
				locationId: PUBLIC_LOC,
				fromDate: onlineClosedDate,
				toDate: onlineClosedDate,
				kind: 'online_closed',
				name: 'Private event',
			},
		])
		const closed = await availability(2, closedDate)
		expect(closed.body.slots).toEqual([])
		expect(closed.body.closed.note).toBe('Closed for the holiday')
		const onlineClosed = await availability(2, onlineClosedDate)
		expect(onlineClosed.body.slots).toEqual([])
		expect(onlineClosed.body.closed).toBeUndefined()
		expect(onlineClosed.body.status).toBe('online_closed')

		const operator = await operatorCall(
			'GET',
			`/book/availability?locationId=${PUBLIC_LOC}&date=${onlineClosedDate}&partySize=2`,
		)
		expect(operator.status).toBe(200)
	})

	it('never offers staff-only or walk-in-only tables online (VAL-ONLINE-008)', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvServiceAvailability).values({
			serviceId: 'svc_pub_dinner',
			tableId: 'tbl_pub_2',
			mode: 'staff_only',
		})
		const result = await availability(2)
		expect(result.body.slots).toEqual([])
		await db
			.delete(rsvServiceAvailability)
			.where(eq(rsvServiceAvailability.tableId, 'tbl_pub_2'))
		await db.insert(rsvServiceAvailability).values({
			serviceId: 'svc_pub_dinner',
			tableId: 'tbl_pub_2',
			mode: 'walk_in_only',
		})
		expect((await availability(2)).body.slots).toEqual([])
	})

	it('offers alternatives when the requested time is gone (VAL-ONLINE-004)', async () => {
		await holdAndBook(19 * 60, 3)
		const result = await availability(2, DAY, `&localMin=${19 * 60}`)
		expect(slotTimes(result.body)).not.toContain(19 * 60)
		expect(result.body.alternatives.sameDay.length).toBeGreaterThan(0)
	})
})

describe('GET /reservations/calendar', () => {
	it('summarises days, caps the span at 62 days and flags closed days (VAL-ONLINE-003)', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvSpecialDays).values({
			locationId: PUBLIC_LOC,
			fromDate: dateAhead(5),
			toDate: dateAhead(5),
			kind: 'closed',
			name: 'Holiday',
		})
		const ok = await call(
			'GET',
			`/reservations/calendar?locationId=${PUBLIC_LOC}&partySize=2&from=${dateAhead(1)}&to=${dateAhead(30)}`,
		)
		expect(ok.status).toBe(200)
		expect(ok.body.days).toHaveLength(30)
		const closed = ok.body.days.find(
			(d: { date: string }) => d.date === dateAhead(5),
		)
		expect(closed).toMatchObject({ hasAvailability: false, closed: true })
		const open = ok.body.days.find(
			(d: { date: string }) => d.date === dateAhead(7),
		)
		expect(open.hasAvailability).toBe(true)
		expect(open.firstLocalMin).toBe(17 * 60)

		const tooLong = await call(
			'GET',
			`/reservations/calendar?locationId=${PUBLIC_LOC}&partySize=2&from=${dateAhead(1)}&to=${dateAhead(64)}`,
		)
		expect(tooLong.status).toBe(400)
		const exactly62 = await call(
			'GET',
			`/reservations/calendar?locationId=${PUBLIC_LOC}&partySize=2&from=${dateAhead(1)}&to=${dateAhead(62)}`,
		)
		expect(exactly62.status).toBe(200)
		expect(exactly62.body.days).toHaveLength(62)
	})
})

describe('holds', () => {
	it('creates a hold with a hashed token and the configured lifetime (VAL-ONLINE-009)', async () => {
		const { status, body } = await createHold(19 * 60)
		expect(status).toBe(201)
		expect(body.holdToken).toMatch(/^rsv_h_[A-Za-z0-9_-]{16,}$/)
		expect(body.slot).toMatchObject({
			date: DAY,
			localMin: 19 * 60,
			partySize: 2,
		})
		const lifetime = Date.parse(body.expiresAt) - Date.parse(body.now)
		expect(lifetime).toBe(7 * 60_000)

		const db = await getTenantDb(ORG)
		const rows = await db.select().from(rsvHolds).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.tokenHash).toBe(
			createHash('sha256').update(body.holdToken).digest('hex'),
		)
		expect(JSON.stringify(rows[0])).not.toContain(body.holdToken)
	})

	it('consumes capacity until released (VAL-ONLINE-010)', async () => {
		const db = await getTenantDb(ORG)
		// A single 2-top: remove the 4-top so only T2 can serve a party of two.
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const hold = await createHold(19 * 60)
		expect(hold.status).toBe(201)
		expect(slotTimes((await availability()).body)).not.toContain(19 * 60)
		const second = await createHold(19 * 60)
		expect(second.status).toBe(409)
		expect(second.body.error).toBe('slot_unavailable')

		const release = await call('POST', '/reservations/holds/release', {
			body: { holdToken: hold.body.holdToken },
		})
		expect(release.status).toBe(200)
		expect(slotTimes((await availability()).body)).toContain(19 * 60)
	})

	it('an expired hold consumes nothing and cannot book (VAL-ONLINE-011, VAL-ONLINE-015)', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const hold = await createHold(19 * 60)
		await db.update(rsvHolds).set({ expiresAt: Date.now() - 1000 })
		expect(slotTimes((await availability()).body)).toContain(19 * 60)

		const other = await holdAndBook(19 * 60, 4)
		expect(other.booked.reservation.status).toBe('booked')
		const late = await book(hold.body.holdToken, 5)
		expect(late.status).toBe(410)
		expect(late.body.error).toBe('hold_expired')
		const rows = await db.select().from(rsvReservations).all()
		expect(rows).toHaveLength(1)
	})

	it('replaceHoldToken releases the previous hold (VAL-ONLINE-012)', async () => {
		const a = await createHold(19 * 60)
		const b = await createHold(20 * 60, 2, {
			replaceHoldToken: a.body.holdToken,
		})
		expect(b.status).toBe(201)
		const current = await call('GET', '/reservations/holds/current', {
			token: a.body.holdToken,
		})
		expect(current.status).toBe(404)
		const unknown = await call('GET', '/reservations/holds/current', {
			token: 'rsv_h_unknowntokenunknowntoken',
		})
		expect(unknown.status).toBe(404)
		expect(unknown.body).toEqual(current.body)
		const booked = await book(a.body.holdToken, 6)
		expect(booked.status).toBe(410)
		const db = await getTenantDb(ORG)
		const rows = await db.select().from(rsvHolds).all()
		expect(rows.find((r) => r.startAt === a.body.slot && false)).toBeUndefined()
		const statuses = rows.map((r) => r.status).sort()
		expect(statuses).toEqual(['active', 'released'])
		const live = await call('GET', '/reservations/holds/current', {
			token: b.body.holdToken,
		})
		expect(live.status).toBe(200)
		expect(live.body.slot.localMin).toBe(20 * 60)
	})
})

describe('POST /reservations (booking)', () => {
	it('converts a hold into a booked reservation with a code and manage token (VAL-ONLINE-013)', async () => {
		const hold = await createHold(19 * 60)
		const booked = await book(hold.body.holdToken, 7, {
			headers: { 'X-Client': 'web' },
		})
		expect(booked.status).toBe(201)
		expect(booked.body.reservation).toMatchObject({
			status: 'booked',
			channel: 'online',
		})
		expect(booked.body.reservation.confirmationCode).toMatch(
			/^[0-9A-HJKMNP-TV-Z]{8}$/,
		)
		expect(booked.body.manageToken).toMatch(/^rsv_m_/)
		const db = await getTenantDb(ORG)
		const row = await db.select().from(rsvReservations).get()
		expect(row).toMatchObject({
			confirmationCode: booked.body.reservation.confirmationCode,
			channel: 'online',
			client: 'web',
			status: 'booked',
		})
		const holdRow = await db.select().from(rsvHolds).get()
		expect(holdRow!.status).toBe('converted')
		expect(row!.holdId).toBe(holdRow!.id)
		const again = await book(hold.body.holdToken, 8)
		expect(again.status).toBeGreaterThanOrEqual(400)
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
	})

	it('replays an idempotent booking and rejects a changed body (VAL-ONLINE-014)', async () => {
		const hold = await createHold(19 * 60)
		const key = idemKey()
		const first = await book(hold.body.holdToken, 9, { key })
		const replay = await book(hold.body.holdToken, 9, { key })
		expect(replay.status).toBe(201)
		expect(replay.body.reservation.id).toBe(first.body.reservation.id)
		expect(replay.body.reservation.confirmationCode).toBe(
			first.body.reservation.confirmationCode,
		)
		const changed = await book(hold.body.holdToken, 9, {
			key,
			guest: { firstName: 'Different' },
		})
		expect(changed.status).toBe(409)
		expect(changed.body.error).toBe('idempotency_conflict')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
		const stored = await db.all(
			sql`select response_json from rsv_idempotency_keys`,
		)
		expect(JSON.stringify(stored)).not.toContain('rsv_m_')
		expect(JSON.stringify(stored)).not.toContain(hold.body.holdToken)
	})

	it('replays when only the single-use Turnstile token or honeypot changes, and conflicts on a different guest or slot', async () => {
		const hold = await createHold(19 * 60)
		const key = idemKey()
		const first = await book(hold.body.holdToken, 12, {
			key,
			extra: { turnstileToken: 'token-one' },
		})
		expect(first.status).toBe(201)
		const retry = await book(hold.body.holdToken, 12, {
			key,
			extra: { turnstileToken: 'token-two' },
		})
		expect(retry.status).toBe(201)
		expect(retry.body.reservation.id).toBe(first.body.reservation.id)

		const otherGuest = await book(hold.body.holdToken, 13, {
			key,
			extra: { turnstileToken: 'token-two' },
		})
		expect(otherGuest.status).toBe(409)
		expect(otherGuest.body.error).toBe('idempotency_conflict')
		const otherHold = await createHold(20 * 60 + 30)
		expect(otherHold.status).toBe(201)
		const otherSlot = await book(otherHold.body.holdToken, 12, { key })
		expect(otherSlot.status).toBe(409)
		expect(otherSlot.body.error).toBe('idempotency_conflict')
	})

	it('never edits a matched guest profile from a public request and keeps the typed contact on the booking', async () => {
		const db = await getTenantDb(ORG)
		const phone = '+14155551090'
		await db.insert(rsvGuests).values({
			id: 'gst_owner',
			firstName: 'Real',
			lastName: 'Owner',
			phoneE164: phone,
			emailNorm: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
		await db.insert(customers).values({
			id: 'cus_unverified',
			name: 'Mallory',
			phone: '+14155550000',
			phoneVerified: false,
		})
		const token = await mintCustomerToken(ORG, 'cus_unverified')
		const hold = await createHold(19 * 60)
		const booked = await book(hold.body.holdToken, 90, {
			headers: { Authorization: `Bearer ${token}` },
			guest: {
				firstName: 'Mallory',
				lastName: 'Typed',
				phone,
				email: 'mallory@example.com',
			},
		})
		expect(booked.status).toBe(201)

		const owner = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_owner'))
			.get()
		expect(owner).toMatchObject({
			firstName: 'Real',
			emailNorm: null,
			customerId: null,
		})
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, booked.body.reservation.id))
			.get()
		expect(reservation?.guestId).toBe('gst_owner')

		const view = await call('GET', '/reservations/manage', {
			token: booked.body.manageToken,
		})
		expect(view.body.firstName).toBe('Mallory')
		expect(view.text).not.toContain('Real')

		// The confirmation goes to the address typed for this booking.
		const messages = await db.select().from(rsvMessages).all()
		expect(
			messages.filter((m) => m.kind === 'confirmation').map((m) => m.channel),
		).toContain('email')
	})

	it('links a matched profile to a signed-in customer only for the customer’s verified phone', async () => {
		const db = await getTenantDb(ORG)
		const phone = '+14155551091'
		await db.insert(rsvGuests).values({
			id: 'gst_linkable',
			firstName: 'Lin',
			lastName: 'Kable',
			phoneE164: phone,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
		await db.insert(customers).values({
			id: 'cus_verified',
			name: 'Lin',
			phone,
			phoneVerified: true,
		})
		const token = await mintCustomerToken(ORG, 'cus_verified')
		const hold = await createHold(19 * 60)
		const booked = await book(hold.body.holdToken, 91, {
			headers: { Authorization: `Bearer ${token}` },
			guest: { phone },
		})
		expect(booked.status).toBe(201)
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_linkable'))
			.get()
		expect(guest?.customerId).toBe('cus_verified')
	})

	it('answers 409 slot_unavailable with alternatives when the last unit is gone (VAL-ONLINE-015)', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		await holdAndBook(19 * 60, 10)
		const hold = await createHold(19 * 60)
		expect(hold.status).toBe(409)
		expect(hold.body.alternatives).toBeDefined()
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
	})

	it('loses a valid hold only to an explicit staff overbook (VAL-ONLINE-016)', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const hold = await createHold(19 * 60)
		const staff = await operatorCall('POST', '/book/reservations', {
			locationId: PUBLIC_LOC,
			date: DAY,
			time: '19:00',
			partySize: 2,
			overbook: true,
			overbookReason: 'VIP walk-in',
			guest: { firstName: 'Staff', lastName: 'Booked', phone: '+14155559999' },
		})
		expect(staff.status).toBeLessThan(300)
		const converted = await book(hold.body.holdToken, 11)
		expect(converted.status).toBe(409)
		expect(converted.body.error).toBe('slot_unavailable')
		expect(converted.body.alternatives).toBeDefined()
		const holdRow = await db.select().from(rsvHolds).get()
		expect(holdRow!.status).not.toBe('converted')
	})

	it('enforces the per-phone active limit and frees it on cancel (VAL-ONLINE-017)', async () => {
		const tokens: string[] = []
		for (let i = 0; i < 3; i++) {
			const hold = await createHold(19 * 60, 2, {}, {}, dateAhead(10 + i))
			const booked = await book(hold.body.holdToken, 20 + i, {
				guest: { phone: '+14155550123' },
			})
			expect(booked.status).toBe(201)
			tokens.push(booked.body.manageToken)
		}
		const fourthHold = await createHold(19 * 60, 2, {}, {}, dateAhead(13))
		const fourth = await book(fourthHold.body.holdToken, 24, {
			guest: { phone: '+14155550123' },
		})
		expect(fourth.status).toBe(429)
		expect(fourth.body.error).toBe('rate_limited')
		const cancel = await call('POST', '/reservations/manage/cancel', {
			token: tokens[0],
			body: {},
		})
		expect(cancel.status).toBe(200)
		const retry = await book(fourthHold.body.holdToken, 24, {
			guest: { phone: '+14155550123' },
		})
		expect(retry.status).toBe(201)
	})

	it('names invalid fields without echoing values (VAL-ONLINE-018)', async () => {
		const hold = await createHold(19 * 60)
		const bad = await book(hold.body.holdToken, 1, {
			guest: { phone: 'zz-not-a-phone-zz', email: 'not-an-email' },
		})
		expect(bad.status).toBe(400)
		expect(bad.body.error).toBe('invalid')
		const paths = bad.body.issues.map((i: { path: string }) => i.path)
		expect(paths).toContain('guest.phone')
		expect(paths).toContain('guest.email')
		expect(bad.text).not.toContain('zz-not-a-phone-zz')
		expect(bad.text).not.toContain('not-an-email')
	})

	it('answers a honeypot like success and writes nothing (VAL-ONLINE-019)', async () => {
		const hold = await createHold(19 * 60)
		const spam = await book(hold.body.holdToken, 30, {
			extra: { website: 'https://spam.example' },
		})
		expect(spam.status).toBe(201)
		expect(spam.body.reservation.confirmationCode).toHaveLength(8)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvReservations).all()).toHaveLength(0)
		expect(await db.select().from(rsvGuests).all()).toHaveLength(0)
		const probe = await call('GET', '/reservations/manage', {
			token: spam.body.manageToken,
		})
		expect(probe.status).toBe(404)
		const stillLive = await call('GET', '/reservations/holds/current', {
			token: hold.body.holdToken,
		})
		expect(stillLive.status).toBe(200)
	})

	it('records X-Client as channel and client (VAL-ONLINE-040)', async () => {
		const results: Array<[string | undefined, string, string]> = [
			['ios', 'native', 'ios'],
			['android', 'native', 'android'],
			['web', 'online', 'web'],
			[undefined, 'online', 'web'],
		]
		const db = await getTenantDb(ORG)
		for (const [i, [client, channel, recorded]] of results.entries()) {
			const hold = await createHold(19 * 60, 2, {}, {}, dateAhead(10 + i))
			expect(hold.status, hold.text).toBe(201)
			const booked = await book(hold.body.holdToken, 40 + i, {
				headers: client ? { 'X-Client': client } : {},
			})
			expect(booked.status, booked.text).toBe(201)
			expect(booked.body.reservation.channel).toBe(channel)
			const row = await db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, booked.body.reservation.id))
				.get()
			expect(row).toMatchObject({ channel, client: recorded })
		}
	})

	it('requires an Idempotency-Key', async () => {
		const hold = await createHold(19 * 60)
		const res = await call('POST', '/reservations', {
			body: {
				holdToken: hold.body.holdToken,
				guest: guestFor(1),
				locale: 'en',
			},
		})
		expect(res.status).toBe(400)
		expect(res.body.issues[0].path).toBe('Idempotency-Key')
	})
})

describe('manage', () => {
	async function booked(localMin = 19 * 60, n = 50) {
		const { booked: b } = await holdAndBook(localMin, n)
		return b as {
			reservation: { id: string; confirmationCode: string }
			manageToken: string
		}
	}

	it('shows the booking with masked contact data (VAL-ONLINE-030)', async () => {
		const b = await booked()
		const view = await call('GET', '/reservations/manage', {
			token: b.manageToken,
		})
		expect(view.status).toBe(200)
		expect(view.body).toMatchObject({
			status: 'booked',
			firstName: 'Pat50',
			canModify: true,
			canCancel: true,
			paymentStatus: 'none',
		})
		expect(view.body.cancelDeadline).toBeTruthy()
		expect(view.text).not.toContain('+1415555')
		expect(view.text).not.toContain('pat50@example.com')
		expect(view.body.contact.phone).toContain('\u2022')
	})

	it('modifies to a new time and frees the old slot (VAL-ONLINE-031)', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const b = await booked(19 * 60)
		expect(slotTimes((await availability()).body)).not.toContain(19 * 60)
		const moved = await call('POST', '/reservations/manage/modify', {
			token: b.manageToken,
			body: { localMin: 17 * 60 + 30 },
		})
		expect(moved.status).toBe(200)
		expect(moved.body.reservation.localMin).toBe(17 * 60 + 30)
		const open = slotTimes((await availability()).body)
		expect(open).toContain(19 * 60)
		expect(open).not.toContain(17 * 60 + 30)

		await holdAndBook(20 * 60, 51)
		const refused = await call('POST', '/reservations/manage/modify', {
			token: b.manageToken,
			body: { localMin: 20 * 60 },
		})
		expect(refused.status).toBe(409)
		expect(refused.body.error).toBe('slot_unavailable')
		expect(refused.body.alternatives).toBeDefined()
		const view = await call('GET', '/reservations/manage', {
			token: b.manageToken,
		})
		expect(view.body.reservation.localMin).toBe(17 * 60 + 30)
	})

	it('closes modify and cancel inside the cutoff (VAL-ONLINE-032)', async () => {
		const b = await booked()
		await setSettings({ guestModifyCutoffMin: 100_000 })
		const modify = await call('POST', '/reservations/manage/modify', {
			token: b.manageToken,
			body: { localMin: 20 * 60 },
		})
		expect(modify.status).toBe(409)
		expect(modify.body.error).toBe('modify_closed')
		const cancel = await call('POST', '/reservations/manage/cancel', {
			token: b.manageToken,
			body: {},
		})
		expect(cancel.body.error).toBe('cancel_closed')
		const view = await call('GET', '/reservations/manage', {
			token: b.manageToken,
		})
		expect(view.body).toMatchObject({
			status: 'booked',
			canModify: false,
			canCancel: false,
		})
	})

	it('cancels as the guest, frees capacity and tolerates a second cancel (VAL-ONLINE-033)', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const b = await booked(19 * 60)
		const cancel = await call('POST', '/reservations/manage/cancel', {
			token: b.manageToken,
			body: {},
		})
		expect(cancel.status).toBe(200)
		expect(cancel.body.status).toBe('cancelled')
		const row = await db.select().from(rsvReservations).get()
		expect(row!.cancelledBy).toBe('guest')
		expect(slotTimes((await availability()).body)).toContain(19 * 60)
		const rebook = await holdAndBook(19 * 60, 52)
		expect(rebook.booked.reservation.status).toBe('booked')
		const second = await call('POST', '/reservations/manage/cancel', {
			token: b.manageToken,
			body: {},
		})
		expect(second.status).toBeLessThan(500)
		const view = await call('GET', '/reservations/manage', {
			token: b.manageToken,
		})
		expect(view.body.status).toBe('cancelled')
	})

	it('marks a guest cancel inside the booking policy cutoff as late and counts it', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const b = await booked(19 * 60)
		const before = await db.select().from(rsvReservations).get()
		// Policy cutoff is wider than the guest modify cutoff, so the guest can
		// still cancel but the cancellation is late.
		await db
			.update(rsvReservations)
			.set({ policySnapshot: { cancelCutoffMin: 100_000 } })
			.where(eq(rsvReservations.id, before!.id))
		const cancel = await call('POST', '/reservations/manage/cancel', {
			token: b.manageToken,
			body: {},
		})
		expect(cancel.status).toBe(200)
		const row = await db.select().from(rsvReservations).get()
		expect(row!.status).toBe('cancelled')
		expect(row!.cancelledBy).toBe('guest')
		expect(row!.lateCancel).toBe(true)
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, row!.guestId))
			.get()
		expect(guest!.cancels).toBe(1)
		expect(guest!.lateCancels).toBe(1)
	})

	it('does not mark a guest cancel outside the cutoff as late', async () => {
		const db = await getTenantDb(ORG)
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		const b = await booked(19 * 60)
		const cancel = await call('POST', '/reservations/manage/cancel', {
			token: b.manageToken,
			body: {},
		})
		expect(cancel.status).toBe(200)
		const row = await db.select().from(rsvReservations).get()
		expect(row!.cancelledBy).toBe('guest')
		expect(row!.lateCancel).toBe(false)
		const guest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, row!.guestId))
			.get()
		expect(guest!.cancels).toBe(1)
		expect(guest!.lateCancels).toBe(0)
	})

	it('confirms idempotently (VAL-ONLINE-034)', async () => {
		const b = await booked()
		for (let i = 0; i < 2; i++) {
			const res = await call('POST', '/reservations/manage/confirm', {
				token: b.manageToken,
				body: {},
			})
			expect(res.status).toBe(200)
			expect(res.body.status).toBe('confirmed')
		}
		const db = await getTenantDb(ORG)
		expect((await db.select().from(rsvReservations).get())!.status).toBe(
			'confirmed',
		)
	})

	it('records running late (VAL-ONLINE-035)', async () => {
		const b = await booked()
		const late = await call('POST', '/reservations/manage/late', {
			token: b.manageToken,
			body: { minutes: 20 },
		})
		expect(late.status).toBe(200)
		const alias = await call('POST', '/reservations/manage/running-late', {
			token: b.manageToken,
			body: { minutes: 20 },
		})
		expect(alias.status).toBe(200)
		const db = await getTenantDb(ORG)
		expect(
			(await db.select().from(rsvReservations).get())!.runningLateMin,
		).toBe(20)
	})

	it('serves an .ics for the booking and 404s unknown tokens (VAL-ONLINE-036)', async () => {
		const b = await booked()
		const header = await call('GET', '/reservations/manage/calendar.ics', {
			token: b.manageToken,
		})
		expect(header.status).toBe(200)
		expect(header.res.headers.get('Content-Type')).toContain('text/calendar')
		expect(header.text).toContain('BEGIN:VEVENT')
		expect(header.text).toContain('Acme')
		const db = await getTenantDb(ORG)
		const row = (await db.select().from(rsvReservations).get())!
		const stamp = (ms: number) =>
			new Date(ms)
				.toISOString()
				.replace(/[-:]/g, '')
				.replace(/\.\d{3}/, '')
		expect(header.text).toContain(`DTSTART:${stamp(row.startAt)}`)
		expect(header.text).toContain(`DTEND:${stamp(row.endAt)}`)
		const viaQuery = await call(
			'GET',
			`/reservations/manage/calendar.ics?t=${encodeURIComponent(b.manageToken)}`,
		)
		expect(viaQuery.status).toBe(200)
		const unknown = await call('GET', '/reservations/manage/calendar.ics', {
			token: 'rsv_m_nope.nope',
		})
		expect(unknown.status).toBe(404)
		expect(unknown.body).toEqual({ error: 'not_found' })
	})

	it('fails closed and uniformly on bad capability tokens (VAL-ONLINE-026)', async () => {
		const one = await booked(17 * 60, 53)
		const two = await booked(19 * 60, 54)
		const forged = `${one.manageToken.split('.')[0]}.AAAA`
		const swapped = `${one.manageToken.split('.')[0]}.${two.manageToken.split('.')[1]}`
		const attempts: Array<[string, string | undefined]> = [
			['missing', undefined],
			['garbage', 'garbage'],
			['forged', forged],
			['swapped', swapped],
		]
		for (const [, token] of attempts) {
			for (const [method, urlPath] of [
				['GET', '/reservations/manage'],
				['GET', '/reservations/manage/calendar.ics'],
				['POST', '/reservations/manage/cancel'],
			] as const) {
				const res = await call(method, urlPath, {
					token,
					body: method === 'POST' ? {} : undefined,
				})
				expect(res.status).toBe(404)
				expect(res.body).toEqual({ error: 'not_found' })
			}
		}
		const ksaNode = await call('GET', '/reservations/manage', {
			token: one.manageToken,
			origin: KSA_ORIGIN,
		})
		expect(ksaNode.status).toBe(404)
		const db = await getTenantDb(ORG)
		await db
			.update(rsvReservations)
			.set({ manageTokenVersion: 2 })
			.where(eq(rsvReservations.id, one.reservation.id))
		const rotated = await call('GET', '/reservations/manage', {
			token: one.manageToken,
		})
		expect(rotated.status).toBe(404)
		await db
			.update(rsvReservations)
			.set({
				manageTokenVersion: 1,
				startAt: Date.now() - 9 * 86_400_000,
				endAt: Date.now() - 8 * 86_400_000,
			})
			.where(eq(rsvReservations.id, one.reservation.id))
		const expired = await call('GET', '/reservations/manage', {
			token: one.manageToken,
		})
		expect(expired.status).toBe(404)
	})

	it('never mutates through GET or other methods (VAL-ONLINE-023)', async () => {
		const b = await booked()
		const db = await getTenantDb(ORG)
		for (const path of [
			'/reservations',
			'/reservations/holds',
			'/reservations/holds/release',
			'/reservations/requests',
			'/reservations/manage/modify',
			'/reservations/manage/cancel',
			'/reservations/manage/confirm',
			'/reservations/manage/late',
		]) {
			for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
				const res = await call(
					method,
					`${path}?t=${encodeURIComponent(b.manageToken)}`,
					{
						token: b.manageToken,
						body: method === 'GET' ? undefined : {},
					},
				)
				expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
			}
		}
		const row = await db.select().from(rsvReservations).get()
		expect(row!.status).toBe('booked')
	})
})

describe('large-party requests', () => {
	const requestBody = (n: number, localMin = 19 * 60, partySize = 12) => ({
		locationId: PUBLIC_LOC,
		slot: { date: DAY, localMin, partySize },
		guest: guestFor(n),
		locale: 'en',
		smsOptIn: false,
		website: '',
	})

	it('runs the request lifecycle through operator approve and decline (VAL-ONLINE-038)', async () => {
		const before = await availability(5)
		expect(before.status).toBe(200)
		const key = idemKey()
		const created = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': key },
			body: requestBody(60),
		})
		expect(created.status).toBe(201)
		expect(created.body.reservation.status).toBe('requested')
		const replay = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': key },
			body: requestBody(60),
		})
		expect(replay.body.reservation.id).toBe(created.body.reservation.id)

		const db = await getTenantDb(ORG)
		const row = await db.select().from(rsvReservations).get()
		expect(row!.status).toBe('pending_approval')

		const approved = await operatorCall(
			'POST',
			`/book/reservations/${created.body.reservation.id}/approve`,
			{},
		)
		expect(approved.status).toBe(200)
		const view = await call('GET', '/reservations/manage', {
			token: created.body.manageToken,
		})
		expect(view.body.status).toBe('booked')

		const second = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': idemKey() },
			body: requestBody(61, 20 * 60),
		})
		expect(second.status).toBe(201)
		const declined = await operatorCall(
			'POST',
			`/book/requests/${second.body.reservation.id}/decline`,
			{ reason: 'No room' },
		)
		expect(declined.status).toBe(200)
		const declinedView = await call('GET', '/reservations/manage', {
			token: second.body.manageToken,
		})
		expect(declinedView.body.status).toBe('declined')
		const again = await operatorCall(
			'POST',
			`/book/reservations/${second.body.reservation.id}/approve`,
			{},
		)
		expect(again.status).toBe(409)
	})

	it('holds capacity while pending and releases it on decline', async () => {
		const free = slotTimes((await availability(6)).body)
		void free
		const created = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': idemKey() },
			body: requestBody(62, 19 * 60, 12),
		})
		expect(created.status).toBe(201)
		const db = await getTenantDb(ORG)
		const occ = await db.all(
			sql`select count(*) as n from rsv_table_occupancies where active = 1`,
		)
		expect((occ[0] as { n: number }).n).toBeGreaterThan(0)
		await operatorCall(
			'POST',
			`/book/reservations/${created.body.reservation.id}/decline`,
			{},
		)
		const after = await db.all(
			sql`select count(*) as n from rsv_table_occupancies where active = 1`,
		)
		expect((after[0] as { n: number }).n).toBe(0)
	})

	it('never plans a table a pending request already holds and never leaks SQL text', async () => {
		const first = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': idemKey() },
			body: requestBody(64, 19 * 60, 12),
		})
		expect(first.status).toBe(201)
		const second = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': idemKey() },
			body: requestBody(65, 19 * 60, 12),
		})
		expect(second.status).toBe(201)

		const db = await getTenantDb(ORG)
		const rows = await db.all(
			sql`select table_id as tableId, count(*) as n from rsv_table_occupancies where active = 1 group by table_id`,
		)
		for (const row of rows as Array<{ n: number }>) expect(row.n).toBe(1)
		expect(JSON.stringify(second.body)).not.toMatch(/Failed query|insert into/i)
	})

	it('refuses requests when the location is in contact mode', async () => {
		await setSettings({ largePartyMode: 'contact' })
		const res = await call('POST', '/reservations/requests', {
			headers: { 'Idempotency-Key': idemKey() },
			body: requestBody(63),
		})
		expect(res.status).toBe(409)
	})
})

describe('/mine', () => {
	it('lists only the signed-in customer’s bookings with fresh manage tokens (VAL-ONLINE-037)', async () => {
		const tenantDb = await getTenantDb(ORG)
		await tenantDb
			.insert(customers)
			.values({ id: 'cus_pub_1', name: 'Signed In' })
		const customer = await mintCustomerToken()
		const hold = await createHold(19 * 60)
		const linked = await book(hold.body.holdToken, 70, {
			headers: { Authorization: `Bearer ${customer}` },
		})
		expect(linked.status).toBe(201)
		await holdAndBook(20 * 60 + 30, 71)

		const mine = await call('GET', '/reservations/mine', {
			headers: { Authorization: `Bearer ${customer}` },
		})
		expect(mine.status).toBe(200)
		expect(mine.body.upcoming).toHaveLength(1)
		expect(mine.body.upcoming[0].id).toBe(linked.body.reservation.id)
		const viaMine = await call('GET', '/reservations/manage', {
			token: mine.body.upcoming[0].manageToken,
		})
		expect(viaMine.status).toBe(200)

		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, linked.body.reservation.id))
			.get()
		expect(row!.customerId).toBe('cus_pub_1')

		for (const headers of [
			{},
			{ Authorization: 'Bearer garbage' },
			{ Authorization: `Bearer ${await mintCustomerToken(ORG_KSA)}` },
		] as Array<Record<string, string>>) {
			const refused = await call('GET', '/reservations/mine', { headers })
			expect(refused.status).toBeGreaterThanOrEqual(400)
			expect(refused.status).toBeLessThan(500)
		}
	})
})

describe('flags, region and kill switch', () => {
	it('serves 404 for no, unknown and wrong-region origins (VAL-ONLINE-024, VAL-ONLINE-025)', async () => {
		for (const origin of [null, UNKNOWN_ORIGIN, KSA_ORIGIN]) {
			const config = await call('GET', '/reservations/config', { origin })
			expect(config.status).toBe(404)
			expect(config.body).toEqual({ error: 'not_found' })
			const hold = await createHold(19 * 60, 2, {}, { origin })
			expect(hold.status).toBe(404)
			expect(hold.body).toEqual({ error: 'not_found' })
		}
		const byOrgId = await call('GET', `/reservations/config?orgId=${ORG}`, {
			origin: null,
		})
		expect(byOrgId.status).toBe(404)
	})

	it('stops booking but keeps manage links when online is off (VAL-ONLINE-027)', async () => {
		const { booked: b } = await holdAndBook(19 * 60, 80)
		resetReservationsContextCache()
		seedReservationsContextForTest(ORG, publicContext(ORG, { online: false }))
		for (const [method, urlPath] of [
			['GET', '/reservations/config'],
			[
				'GET',
				`/reservations/availability?locationId=${PUBLIC_LOC}&date=${DAY}&partySize=2`,
			],
			['POST', '/reservations/holds'],
			['POST', '/reservations'],
			['POST', '/reservations/requests'],
		] as const) {
			const res = await call(method, urlPath, {
				body: method === 'POST' ? {} : undefined,
			})
			expect(res.status, urlPath).toBe(404)
		}
		expect(
			(await call('GET', '/reservations/manage', { token: b.manageToken }))
				.status,
		).toBe(200)
		expect(
			(
				await call('POST', '/reservations/manage/confirm', {
					token: b.manageToken,
					body: {},
				})
			).status,
		).toBe(200)
		expect(
			(
				await call('POST', '/reservations/manage/late', {
					token: b.manageToken,
					body: { minutes: 5 },
				})
			).status,
		).toBe(200)
		expect(
			(
				await call('GET', '/reservations/manage/calendar.ics', {
					token: b.manageToken,
				})
			).status,
		).toBe(200)
	})

	it('hides every route when the master flag is off (VAL-ONLINE-028)', async () => {
		const { booked: b } = await holdAndBook(19 * 60, 81)
		resetReservationsContextCache()
		seedReservationsContextForTest(ORG, publicContext(ORG, { enabled: false }))
		for (const urlPath of [
			'/reservations/config',
			'/reservations/manage',
			'/reservations/manage/calendar.ics',
			'/reservations/mine',
		]) {
			const res = await call('GET', urlPath, { token: b.manageToken })
			expect(res.status, urlPath).toBe(404)
			expect(res.body).toEqual({ error: 'not_found' })
		}
	})

	it('answers 503 unavailable on public routes only when switched off (VAL-ONLINE-029)', async () => {
		process.env.RESERVATIONS_PUBLIC_ENABLED = 'false'
		for (const [method, urlPath] of [
			['GET', '/reservations/config'],
			['GET', '/reservations/manage'],
			['POST', '/reservations/holds'],
			['POST', '/reservations'],
		] as const) {
			const res = await call(method, urlPath, {
				body: method === 'POST' ? {} : undefined,
			})
			expect(res.status).toBe(503)
			expect(res.body).toEqual({ error: 'unavailable' })
		}
		const operator = await operatorCall(
			'GET',
			`/book/day?locationId=${PUBLIC_LOC}&date=${DAY}`,
		)
		expect(operator.status).toBe(200)
		const noToken = await app.request('/operator/reservations/book/day')
		expect(noToken.status).toBe(401)
	})
})

describe('rate limits', () => {
	it('limits availability to 60/min and calendar to 30/min (VAL-ONLINE-020)', async () => {
		let last = 0
		for (let i = 0; i < 61; i++) {
			last = (await availability()).status
		}
		expect(last).toBe(429)
		resetPublicRateLimits()
		const calendar = `/reservations/calendar?locationId=${PUBLIC_LOC}&partySize=2&from=${dateAhead(1)}&to=${dateAhead(2)}`
		for (let i = 0; i < 30; i++) {
			expect((await call('GET', calendar)).status).toBe(200)
		}
		const limited = await call('GET', calendar)
		expect(limited.status).toBe(429)
		expect(limited.body.error).toBe('rate_limited')
	})

	it('limits holds durably, 10 per IP per 10 minutes (VAL-ONLINE-021)', async () => {
		const statuses: number[] = []
		for (let i = 0; i < 11; i++) {
			if (i === 5) resetPublicRateLimits()
			statuses.push(
				(await createHold(19 * 60, 1, {}, {}, dateAhead(10 + i))).status,
			)
		}
		expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true)
		expect(statuses[10]).toBe(429)
		resetPublicRateLimits()
		const afterRestart = await createHold(19 * 60, 1, {}, {}, dateAhead(30))
		expect(afterRestart.status).toBe(429)
		const db = await getTenantDb(ORG)
		const counters = await db.select().from(rsvRateCounters).all()
		expect(counters.some((c) => c.bucket === 'holds_ip' && c.count >= 11)).toBe(
			true,
		)
	})

	it('limits manage mutations to 30/hour per token, durably (VAL-ONLINE-022)', async () => {
		const { booked: b } = await holdAndBook(19 * 60, 90)
		for (let i = 0; i < 30; i++) {
			if (i % 8 === 0) resetPublicRateLimits()
			const res = await call('POST', '/reservations/manage/confirm', {
				token: b.manageToken,
				body: {},
			})
			expect(res.status).toBe(200)
		}
		resetPublicRateLimits()
		const limited = await call('POST', '/reservations/manage/late', {
			token: b.manageToken,
			body: { minutes: 5 },
		})
		expect(limited.status).toBe(429)
		expect(limited.body.error).toBe('rate_limited')
		const view = await call('GET', '/reservations/manage', {
			token: b.manageToken,
		})
		expect(view.status).toBe(200)
	})
})

describe('data placement', () => {
	it('keeps the guest in the tenant database of the resolved organization (VAL-ONLINE-041)', async () => {
		await holdAndBook(19 * 60, 95)
		const db = await getTenantDb(ORG)
		const guests = await db.select().from(rsvGuests).all()
		expect(guests.map((g) => g.firstName)).toEqual(['Pat95'])
		const areas = await db.select().from(rsvAreas).all()
		expect(areas.length).toBeGreaterThan(0)
		void and
	})
})

describe('guest-selectable seating areas', () => {
	async function seedAreas() {
		const db = await getTenantDb(ORG)
		await db.insert(rsvAreas).values([
			{
				id: 'area_pub_patio',
				locationId: PUBLIC_LOC,
				name: 'Patio',
				nameI18n: { ar: 'الشرفة' },
				sort: 1,
				onlineBookable: true,
				guestSelectable: true,
			},
			{
				id: 'area_pub_bar',
				locationId: PUBLIC_LOC,
				name: 'Bar',
				sort: 2,
				onlineBookable: true,
				guestSelectable: false,
			},
			{
				id: 'area_pub_old',
				locationId: PUBLIC_LOC,
				name: 'Old Room',
				sort: 3,
				onlineBookable: true,
				guestSelectable: true,
				archivedAt: new Date(),
			},
			{
				id: 'area_pub_closed',
				locationId: PUBLIC_LOC,
				name: 'Closed Room',
				sort: 4,
				onlineBookable: false,
				guestSelectable: true,
			},
		])
		return db
	}

	it('config lists only active, online, guest-selectable areas without internals', async () => {
		await seedAreas()
		const { status, body, text } = await call('GET', '/reservations/config')
		expect(status).toBe(200)
		expect(body.locations[0].areas).toEqual([
			{ id: 'area_pub_main', name: 'Main Room' },
			{ id: 'area_pub_patio', name: 'Patio' },
		])
		expect(text).not.toContain('Bar')
		expect(text).not.toContain('Old Room')
		expect(text).not.toContain('Closed Room')
	})

	it('config localizes area names', async () => {
		await seedAreas()
		seedReservationsContextForTest(
			ORG,
			publicContext(ORG, { locales: ['en', 'ar'] }),
		)
		const { body } = await call('GET', '/reservations/config?locale=ar')
		const names = body.locations[0].areas.map((a: { name: string }) => a.name)
		expect(names).toContain('الشرفة')
		expect(names).toContain('Main Room')
	})

	describe('languages follow the organization Website settings', () => {
		const org = (locales: string[], defaultLocale: string) =>
			seedReservationsContextForTest(
				ORG,
				publicContext(ORG, { locales, defaultLocale }),
			)
		const configNames = async (locale: string) => {
			const { body } = await call(
				'GET',
				`/reservations/config?locale=${locale}`,
			)
			return body.locations[0].areas.map((a: { name: string }) => a.name)
		}

		it('serves the organization default language before the canonical name, never a hard-coded English entry', async () => {
			const db = await seedAreas()
			await db
				.update(rsvAreas)
				.set({ nameI18n: { ar: 'الشرفة', en: 'Terrace' } })
				.where(eq(rsvAreas.id, 'area_pub_patio'))
			org(['ar', 'en'], 'ar')
			// Spanish is not enabled: the default (Arabic) wins over the English entry.
			expect(await configNames('es')).toContain('الشرفة')
			expect(await configNames('en')).toContain('Terrace')
		})

		it('falls back to the canonical name, not to another language, when the default has no entry', async () => {
			const db = await seedAreas()
			await db
				.update(rsvAreas)
				.set({ nameI18n: { en: 'Terrace' } })
				.where(eq(rsvAreas.id, 'area_pub_patio'))
			org(['ar', 'en'], 'ar')
			const names = await configNames('ar')
			expect(names).toContain('Patio')
			expect(names).not.toContain('Terrace')
		})

		it('never serves a language the organization has not enabled', async () => {
			const db = await seedAreas()
			await db
				.update(rsvAreas)
				.set({ nameI18n: { fr: 'Terrasse' } })
				.where(eq(rsvAreas.id, 'area_pub_patio'))
			org(['en'], 'en')
			expect(await configNames('fr')).toContain('Patio')
		})

		it.each(['es', 'fr', 'de', 'zh'])(
			'serves %s operator copy when enabled',
			async (lang) => {
				const db = await seedAreas()
				await db
					.update(rsvAreas)
					.set({ nameI18n: { en: 'Patio', [lang]: `Patio ${lang}` } })
					.where(eq(rsvAreas.id, 'area_pub_patio'))
				org(['en', lang], 'en')
				expect(await configNames(lang)).toContain(`Patio ${lang}`)
			},
		)

		it('stores the guest language only when it is enabled, else the organization default', async () => {
			org(['en', 'es'], 'en')
			const { guestLocaleFor } = await import('../lib/reservations-i18n.ts')
			const orgLocales = { locales: ['en', 'es'], defaultLocale: 'en' }
			expect(guestLocaleFor('es-MX', orgLocales)).toBe('es')
			expect(guestLocaleFor('zh', orgLocales)).toBe('en')
			expect(guestLocaleFor(undefined, orgLocales)).toBe('en')
		})
	})

	it('availability slots carry areaId and areaLabel only for selectable areas', async () => {
		const db = await seedAreas()
		const withArea = await availability(2)
		expect(withArea.status).toBe(200)
		expect(withArea.body.slots.length).toBeGreaterThan(0)
		for (const slot of withArea.body.slots) {
			expect(slot.areaId).toBe('area_pub_main')
			expect(slot.areaLabel).toBe('Main Room')
		}

		await db
			.update(rsvAreas)
			.set({ guestSelectable: false })
			.where(eq(rsvAreas.id, 'area_pub_main'))
		clearReservationDayCacheForTest()
		const without = await availability(2)
		expect(without.status).toBe(200)
		expect(without.body.slots.length).toBeGreaterThan(0)
		for (const slot of without.body.slots) {
			expect(slot.areaId).toBeNull()
			expect(slot.areaLabel).toBeNull()
		}
		expect(without.text).not.toContain('Main Room')
	})
})

describe('hold areaPref', () => {
	async function seedPatio() {
		const db = await getTenantDb(ORG)
		await db.insert(rsvAreas).values({
			id: 'area_pub_patio',
			locationId: PUBLIC_LOC,
			name: 'Patio',
			sort: 1,
			onlineBookable: true,
			guestSelectable: true,
		})
		await db.insert(rsvTables).values({
			id: 'tbl_pub_patio2',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_patio',
			label: 'P2',
			minCovers: 1,
			maxCovers: 2,
			onlineBookable: true,
			resetBufferMin: 0,
		})
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		clearReservationDayCacheForTest()
		return db
	}

	async function holdTables() {
		const db = await getTenantDb(ORG)
		const rows = await db
			.select({ tableId: rsvTableOccupancies.tableId })
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.kind, 'hold'))
			.all()
		return rows.map((r) => r.tableId)
	}

	it('seats the hold in the chosen guest-selectable area', async () => {
		await seedPatio()
		const patio = await createHold(19 * 60, 2, { areaPref: 'area_pub_patio' })
		expect(patio.status).toBe(201)
		expect(await holdTables()).toEqual(['tbl_pub_patio2'])
	})

	it('refuses a time that is full in the chosen area even if another area is free', async () => {
		await seedPatio()
		expect(
			(await createHold(19 * 60, 2, { areaPref: 'area_pub_patio' })).status,
		).toBe(201)
		const second = await createHold(19 * 60, 2, {
			areaPref: 'area_pub_patio',
		})
		expect(second.status).toBe(409)
		expect(second.body.error).toBe('slot_unavailable')
		const other = await createHold(19 * 60, 2, { areaPref: 'area_pub_main' })
		expect(other.status).toBe(201)
		expect((await holdTables()).sort()).toEqual(['tbl_pub_2', 'tbl_pub_patio2'])
	})

	it('ignores an area the guest may not choose, and treats an empty value as none', async () => {
		await seedPatio()
		const db = await getTenantDb(ORG)
		await db
			.update(rsvAreas)
			.set({ guestSelectable: false })
			.where(eq(rsvAreas.id, 'area_pub_patio'))
		clearReservationDayCacheForTest()
		expect(
			(await createHold(19 * 60, 2, { areaPref: 'area_pub_patio' })).status,
		).toBe(201)
		expect((await createHold(20 * 60, 2, { areaPref: '' })).status).toBe(201)
	})
})

describe('operator reads of the recorded client', () => {
	async function bookAs(client: string | undefined, n: number, date: string) {
		const hold = await createHold(19 * 60, 2, {}, {}, date)
		expect(hold.status, hold.text).toBe(201)
		const booked = await book(hold.body.holdToken, n, {
			headers: client === undefined ? {} : { 'X-Client': client },
		})
		expect(booked.status, booked.text).toBe(201)
		return booked.body.reservation.id as string
	}

	async function feedRow(id: string, date: string) {
		const feed = await operatorCall(
			'GET',
			`/book/day?locationId=${PUBLIC_LOC}&date=${date}`,
		)
		expect(feed.status).toBe(200)
		const row = feed.body.reservations.find((r: { id: string }) => r.id === id)
		expect(row, JSON.stringify(feed.body).slice(0, 300)).toBeTruthy()
		return row
	}

	it('returns client next to channel in the day feed and detail', async () => {
		const cases: Array<[string | undefined, string, string]> = [
			['ios', 'native', 'ios'],
			['android', 'native', 'android'],
			[undefined, 'online', 'web'],
		]
		for (const [i, [header, channel, client]] of cases.entries()) {
			const date = dateAhead(20 + i)
			const id = await bookAs(header, 60 + i, date)
			const row = await feedRow(id, date)
			expect(row).toMatchObject({ channel, client })
			const detail = await operatorCall('GET', `/book/reservations/${id}`)
			expect(detail.status).toBe(200)
			expect(detail.body.reservation).toMatchObject({ channel, client })
		}
	})

	it('sanitizes unknown or hostile X-Client values to web', async () => {
		const date = dateAhead(30)
		const id = await bookAs('<script>' + 'x'.repeat(300), 70, date)
		const row = await feedRow(id, date)
		expect(row).toMatchObject({ channel: 'online', client: 'web' })
	})

	it('reports a null client for rows that never recorded one', async () => {
		const date = dateAhead(31)
		const id = await bookAs('ios', 71, date)
		const db = await getTenantDb(ORG)
		await db
			.update(rsvReservations)
			.set({ client: null })
			.where(eq(rsvReservations.id, id))
		const row = await feedRow(id, date)
		expect(row.client).toBeNull()
		const detail = await operatorCall('GET', `/book/reservations/${id}`)
		expect(detail.body.reservation.client).toBeNull()
	})
})
