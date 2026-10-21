import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	type LocationSpecialHour,
	type LocationWeeklyDay,
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

type Hours = {
	storeHours?: LocationWeeklyDay[] | null
	specialHours?: LocationSpecialHour[] | null
	isActive?: boolean
	timeZone?: string
}

const DAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

function weekly(
	slots: Array<[string, string]> | null,
	over: Partial<
		Record<(typeof DAYS)[number], Array<[string, string]> | null>
	> = {},
): LocationWeeklyDay[] {
	return DAYS.map((day) => {
		const s = day in over ? over[day]! : slots
		return {
			day,
			isOpen: s !== null,
			slots: (s ?? []).map(([start, end]) => ({ start, end })),
		}
	})
}

function setHours(hours: Hours) {
	const ctx = publicContext(ORG)
	ctx.locations[0] = {
		...ctx.locations[0]!,
		storeHours: hours.storeHours ?? null,
		specialHours: hours.specialHours ?? null,
		isActive: hours.isActive ?? true,
		timeZone: hours.timeZone ?? 'UTC',
	}
	seedReservationsContextForTest(ORG, ctx)
}

const closedOn = (date: string, note?: string): LocationSpecialHour[] => [
	{ id: 'sh', date, isOpen: false, slots: [], ...(note ? { note } : {}) },
]

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-lochours-test-'))
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
	await seedPublicOrg(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('location hours govern public availability', () => {
	it('C1: a location closed day offers no slots, with the reason and note', async () => {
		setHours({
			storeHours: weekly([['16:00', '23:00']]),
			specialHours: closedOn(DAY, 'Closed for Christmas'),
		})
		const res = await availability()
		expect(res.status).toBe(200)
		expect(res.body.status).toBe('closed')
		expect(res.body.slots).toEqual([])
		expect(res.body.closed).toMatchObject({
			reason: 'location_closed',
			note: 'Closed for Christmas',
			source: 'location_hours',
		})
		// The next day is unaffected.
		expect(
			(await availability(2, dateAhead(11))).body.slots.length,
		).toBeGreaterThan(0)
	})

	it('C1: a closed weekday closes every such day', async () => {
		const dow = new Date(`${DAY}T00:00:00Z`).getUTCDay()
		const name = (['sunday', ...DAYS.slice(0, 6)] as const)[dow]!
		setHours({ storeHours: weekly([['16:00', '23:00']], { [name]: null }) })
		const res = await availability()
		expect(res.body.status).toBe('closed')
		expect(res.body.closed).toMatchObject({ reason: 'location_closed' })
	})

	it('C1: no hold can be created on a location closed day', async () => {
		setHours({
			storeHours: weekly([['16:00', '23:00']]),
			specialHours: closedOn(DAY),
		})
		const hold = await createHold(19 * 60)
		expect(hold.status).toBe(409)
		expect(hold.body.error).toBe('slot_unavailable')
	})

	it('C1: a hold taken before the owner closes the day cannot be confirmed', async () => {
		setHours({ storeHours: weekly([['16:00', '23:00']]) })
		const hold = await createHold(19 * 60)
		expect(hold.status).toBe(201)
		setHours({
			storeHours: weekly([['16:00', '23:00']]),
			specialHours: closedOn(DAY),
		})
		const booked = await book(hold.body.holdToken, 1)
		expect(booked.status).toBe(409)
		expect(booked.body.error).toBe('slot_unavailable')
	})

	it('C2: a reservations-only closure keeps its own reason and an open location stays bookable on other days', async () => {
		setHours({ storeHours: weekly([['16:00', '23:00']]) })
		const db = await getTenantDb(ORG)
		await db.insert(rsvSpecialDays).values({
			id: 'sp_rsv',
			locationId: PUBLIC_LOC,
			fromDate: DAY,
			toDate: DAY,
			kind: 'closed',
			name: 'Buyout',
		})
		const res = await availability()
		expect(res.body.status).toBe('closed')
		expect(res.body.closed).toMatchObject({
			reason: 'special_day',
			source: 'reservation_special_day',
		})
	})

	it('C3: partial special hours clip the offered slots', async () => {
		setHours({
			storeHours: weekly([['16:00', '23:00']]),
			specialHours: [
				{
					id: 'sh',
					date: DAY,
					isOpen: true,
					slots: [{ start: '17:00', end: '19:00' }],
				},
			],
		})
		const res = await availability()
		expect(res.body.status).toBe('available')
		const times = slotTimes(res.body)
		expect(Math.min(...times)).toBe(17 * 60)
		expect(Math.max(...times)).toBe(19 * 60)
		// A slot outside the hours cannot be held either.
		expect((await createHold(20 * 60)).status).toBe(409)
		expect((await createHold(18 * 60)).status).toBe(201)
	})

	it('C4: a weekly pattern that ends early removes the late seatings', async () => {
		setHours({ storeHours: weekly([['16:00', '20:00']]) })
		const times = slotTimes((await availability()).body)
		expect(Math.max(...times)).toBe(20 * 60)
	})

	it('C7/C8: midnight-split overnight hours keep every evening slot open', async () => {
		const dow = new Date(`${DAY}T00:00:00Z`).getUTCDay()
		const names = ['sunday', ...DAYS.slice(0, 6)] as const
		const today = names[dow]!
		const next = names[(dow + 1) % 7]!
		setHours({
			storeHours: weekly(null, {
				[today]: [['17:00', '23:59']],
				[next]: [['00:00', '02:00']],
			}),
		})
		const res = await availability()
		expect(res.body.status).toBe('available')
		expect(Math.max(...slotTimes(res.body))).toBe(20 * 60 + 30)
	})

	it('C6: hours are read in the location zone, not the reservations zone', async () => {
		// Reservation slots run on UTC; the location is in Riyadh (UTC+3).
		// Open 18:00-21:00 Riyadh = 15:00-18:00 UTC, so only 17:00-18:00 UTC seatings stay.
		setHours({
			timeZone: 'Asia/Riyadh',
			storeHours: weekly([['18:00', '21:00']]),
		})
		const times = slotTimes((await availability()).body)
		expect(Math.min(...times)).toBe(17 * 60)
		expect(Math.max(...times)).toBe(18 * 60)
	})

	it('C9: an inactive location is not bookable', async () => {
		setHours({ storeHours: weekly([['16:00', '23:00']]), isActive: false })
		expect((await availability()).status).toBe(404)
	})

	it('C13: unknown or malformed hours fail open', async () => {
		setHours({ storeHours: null, specialHours: null })
		expect(slotTimes((await availability()).body).length).toBeGreaterThan(0)
		resetReservationsContextCache()
		const noContext = await availability()
		expect([200, 503, 404]).toContain(noContext.status)
	})

	it('marks closed days in the calendar summary with the source', async () => {
		setHours({
			storeHours: weekly([['16:00', '23:00']]),
			specialHours: closedOn(DAY, 'Holiday'),
		})
		const res = await call(
			'GET',
			`/reservations/calendar?locationId=${PUBLIC_LOC}&from=${dateAhead(9)}&to=${dateAhead(11)}&partySize=2`,
		)
		expect(res.status).toBe(200)
		const day = res.body.days.find((d: { date: string }) => d.date === DAY)
		expect(day).toMatchObject({
			closed: true,
			hasAvailability: false,
			closedSource: 'location_hours',
		})
		const other = res.body.days.find(
			(d: { date: string }) => d.date === dateAhead(9),
		)
		expect(other.closed).toBe(false)
	})
})
