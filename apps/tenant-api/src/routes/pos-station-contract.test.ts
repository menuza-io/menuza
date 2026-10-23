import fs from 'node:fs'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import {
	waitlistListingSchema,
	type ReservationsContext,
} from '@repo/reservations'
import { getTenantDb, posManagers } from '@repo/tenant-db'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	LOC_1,
	ORG_A,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import {
	makeOrg,
	OPERATOR_SECRET,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'

/**
 * The host stand payloads the Station till reads, recorded from the real
 * routes with a token the till minted itself (`/pos/reservations/token`).
 *
 * The fixtures live in `apps/station/src/apps/reservations/fixtures`, where the
 * till's own tests parse them. This suite checks the live responses still have
 * exactly the fixtures' key structure, so a server change the till would not
 * understand fails here until the fixtures are re-recorded:
 *
 *   RECORD_STATION_FIXTURES=1 npx vitest run src/routes/pos-station-contract.test.ts
 */

const RECORD = process.env.RECORD_STATION_FIXTURES === '1'
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const FIXTURE_DIR = path.join(
	REPO_ROOT,
	'apps/station/src/apps/reservations/fixtures',
)

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())
const rsvContexts = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	getStaffingFeatures: vi.fn(async () => ({
		features: {
			enabled: true,
			timeclock: true,
			scheduling: false,
			hiring: false,
		},
		dataRegion: 'us',
	})),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/reservations-context.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/reservations-context.ts')>()),
	getReservationsContext: vi.fn(
		async (orgId: string) =>
			(rsvContexts.get(orgId) as ReservationsContext | undefined) ?? null,
	),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

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

/** Keys must match; a nullable field may be null in one sample and typed in the other. */
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
		const aItems = (aObj.array as unknown[] | undefined) ?? []
		const bItems = (bObj.array as unknown[] | undefined) ?? []
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

const FIXED_NOW = Date.UTC(2026, 0, 15, 18, 0, 0)
const FIXED_DAY = '2026-01-15'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BUSINESS_TIME_KEYS = new Set([
	'startAt',
	'start_at',
	'endAt',
	'end_at',
	'slotStartAt',
	'slotEndAt',
])
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stable values, so recording twice leaves `git status` clean. */
function makeNormalizer(recordedNow: number) {
	const aliases = new Map<string, string>()
	const alias = (prefix: string, value: string) => {
		const hit = aliases.get(value)
		if (hit) return hit
		const next = `${prefix}${String(aliases.size + 1).padStart(4, '0')}`
		aliases.set(value, next)
		return next
	}
	const today = new Date(recordedNow)
	today.setUTCHours(0, 0, 0, 0)
	const walk = (value: unknown, key: string): unknown => {
		if (typeof value === 'number' && value > 1e12 && value < 1e13) {
			// A booking's own times keep their time of day on their business day.
			if (BUSINESS_TIME_KEYS.has(key)) {
				return Date.parse(`${FIXED_DAY}T00:00:00Z`) + (value - today.getTime())
			}
			// Anything else: whole minutes from the recording instant.
			return FIXED_NOW + Math.round((value - recordedNow) / 60_000) * 60_000
		}
		if (typeof value === 'string') {
			if (DATE_RE.test(value)) {
				const offset = Math.round(
					(Date.parse(`${value}T00:00:00Z`) - today.getTime()) / 86_400_000,
				)
				return new Date(
					Date.parse(`${FIXED_DAY}T00:00:00Z`) + offset * 86_400_000,
				)
					.toISOString()
					.slice(0, 10)
			}
			if (key === 'etag' || key === 'shortEtag') return `"fixture-${key}"`
			if (key === 'confirmationCode' || key === 'confirmation_code')
				return alias('FIX', value)
			if (UUID_RE.test(value)) return alias('id_fixture_', value)
			if (/^(rsv|wle|res|hld|gst|evt)_[A-Za-z0-9_-]{6,}$/.test(value))
				return alias('rsv_fixture_', value)
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
	return (value: unknown) => walk(value, '')
}

const mintOperator = () =>
	new SignJWT({ orgId: ORG_A, role: 'operator', scope: 'orders:write' })
		.setSubject('user_manager_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(OPERATOR_SECRET))

describe('Station host stand contract', () => {
	let h: ClockHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: 'UTC' })
		rsvContexts.clear()
		rsvContexts.set(ORG_A, publicContext(ORG_A))
		vi.stubEnv('POS_ENABLED', '')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A])
		await seedPublicOrg(ORG_A, { seedContext: false })
	})
	afterEach(async () => {
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	async function call(
		method: string,
		pathname: string,
		headers: Record<string, string>,
		body?: unknown,
	) {
		const response = await h.app.request(pathname, {
			method,
			headers: {
				...headers,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await response.text()
		return {
			status: response.status,
			text,
			body: text ? (JSON.parse(text) as any) : null,
		}
	}

	it('the till reads and runs the day of service with its own token', async () => {
		const recordedNow = Date.now()
		// A till manager at a terminal bound to the location.
		const { pin, staffId } = await h.seedStaff(ORG_A, {
			firstName: 'Lina',
			lastName: 'Mansour',
		})
		const db = await getTenantDb(ORG_A)
		await db.insert(posManagers).values({ staffId, addedBy: 'test' })
		const created = await call(
			'POST',
			'/operator/pos/pairing-codes',
			{ authorization: `Bearer ${await mintOperator()}` },
			{
				label: 'Host stand',
				terminalCode: 'H1',
				scopeId: LOC_1,
				locationId: PUBLIC_LOC,
				signInRequired: true,
				timeclockEnabled: true,
				reservationsEnabled: true,
			},
		)
		expect(created.status, created.text).toBe(201)
		const paired = await call(
			'POST',
			'/pos/pair',
			{},
			{ code: created.body.code },
		)
		const device = { authorization: `Bearer ${paired.body.deviceSecret}` }
		const signedIn = await call('POST', '/pos/sign-in', device, { pin })
		const minted = await call(
			'POST',
			'/pos/reservations/token',
			{ ...device, [POS_STAFF_SESSION_HEADER]: signedIn.body.sessionToken },
			{ scope: 'book' },
		)
		expect(minted.status, minted.text).toBe(200)
		const rsv = { authorization: `Bearer ${minted.body.token}` }
		const tomorrow = dateAhead(1)
		let key = 0
		const write = (pathname: string, body: unknown) =>
			call(
				'POST',
				`/operator/reservations/book${pathname}`,
				{ ...rsv, 'Idempotency-Key': `station-contract-${++key}` },
				body,
			)

		const booked = await write('/reservations', {
			locationId: PUBLIC_LOC,
			date: tomorrow,
			time: '19:00',
			partySize: 2,
			tableIds: ['tbl_pub_2'],
			guest: {
				firstName: 'Maya',
				lastName: 'Haddad',
				phone: '+14155550111',
				allergyNotes: 'Peanuts',
			},
			staffNotes: 'Window if possible',
		})
		expect(booked.status, booked.text).toBe(201)
		const seated = await write('/reservations', {
			locationId: PUBLIC_LOC,
			date: tomorrow,
			time: '19:30',
			partySize: 4,
			tableIds: ['tbl_pub_4'],
			guest: { firstName: 'Omar', lastName: 'Saleh' },
		})
		expect(seated.status, seated.text).toBe(201)
		const seatedId = seated.body.reservation?.id ?? seated.body.id
		const seat = await write(`/reservations/${seatedId}/status`, {
			toStatus: 'seated',
		})
		expect(seat.status, seat.text).toBe(200)
		const walkIn = await write('/walk-ins', {
			locationId: PUBLIC_LOC,
			date: tomorrow,
			time: '20:00',
			partySize: 3,
			tableIds: ['tbl_pub_12'],
			guestName: 'Walk-in',
		})
		expect(walkIn.status, walkIn.text).toBe(201)
		const waiting = await call(
			'POST',
			'/operator/reservations/book/waitlist',
			{ ...rsv, 'Idempotency-Key': 'station-contract-waitlist' },
			{ locationId: PUBLIC_LOC, displayName: 'Rana Khalid', partySize: 2 },
		)
		expect(waiting.status, waiting.text).toBe(201)

		const replies = {
			'day-feed': await call(
				'GET',
				`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${tomorrow}`,
				rsv,
			),
			availability: await call(
				'GET',
				`/operator/reservations/book/availability?locationId=${PUBLIC_LOC}&date=${tomorrow}&partySize=2`,
				rsv,
			),
			waitlist: await call(
				'GET',
				`/operator/reservations/book/waitlist?locationId=${PUBLIC_LOC}`,
				rsv,
			),
		}
		for (const [name, reply] of Object.entries(replies)) {
			expect(reply.status, `${name}: ${reply.text}`).toBe(200)
		}
		expect(waitlistListingSchema.safeParse(replies.waitlist.body).success).toBe(
			true,
		)
		// A manager's token reads the allergy; the feed carries it.
		expect(replies['day-feed'].text).toContain('Peanuts')

		const normalize = makeNormalizer(recordedNow)
		if (RECORD) fs.mkdirSync(FIXTURE_DIR, { recursive: true })
		for (const [name, reply] of Object.entries(replies)) {
			const file = path.join(FIXTURE_DIR, `${name}.json`)
			const value = normalize(reply.body)
			if (RECORD) {
				fs.writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`)
				continue
			}
			expect(fs.existsSync(file), `${file} is missing: re-record`).toBe(true)
			const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
			expect(sameKeys(shapeOf(fixture), shapeOf(value)), name).toEqual([])
		}
	})
})
