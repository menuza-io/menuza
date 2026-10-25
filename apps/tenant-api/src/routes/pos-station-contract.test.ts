import fs from 'node:fs'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import {
	waitlistListingSchema,
	type ReservationsContext,
} from '@repo/reservations'
import {
	getTenantDb,
	posHosts,
	rsvPayments,
	rsvReservations,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
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
import { stationMayCall } from '../lib/reservations-guard.ts'
import {
	createOperatorReservation,
	updateReservationNotes,
} from '../services/rsv-booking-service.ts'
import { createWaitlistEntry } from '../services/rsv-waitlist-service.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'

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
	hasScope: vi.fn(async (_org: string, scope: string) =>
		facts.size ? facts.has(scope) : null,
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
	new SignJWT({
		orgId: ORG_A,
		role: 'operator',
		scope: 'orders:write',
		stationApps: {
			timeclock: true,
			reservations: true,
			guestDetails: true,
			locationIds: null,
			scopeIds: null,
		},
	})
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
		vi.useRealTimers()
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
		// Mid-morning today: a till seats only today's bookings, so the party it
		// seats is booked for tonight.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date(`${dateAhead(0)}T10:00:00Z`))
		const recordedNow = Date.now()
		// A host with guest details at a terminal bound to the location, and a
		// host without them.
		const { pin, staffId } = await h.seedStaff(ORG_A, {
			firstName: 'Lina',
			lastName: 'Mansour',
		})
		const other = await h.seedStaff(ORG_A, { firstName: 'Sam' })
		const db = await getTenantDb(ORG_A)
		await db.insert(posHosts).values([
			{ staffId, addedBy: 'test', guestDetails: true },
			{ staffId: other.staffId, addedBy: 'test', guestDetails: false },
		])
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

		// A till may not write allergy notes, so this booking comes from the app.
		const booked = {
			body: await createOperatorReservation({
				canReadGuestSensitive: true,
				orgId: ORG_A,
				locationId: PUBLIC_LOC,
				actorId: 'manager',
				idempotencyKey: 'station-contract-maya',
				input: {
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
				},
			}),
		}
		const seated = await write('/reservations', {
			locationId: PUBLIC_LOC,
			date: dateAhead(0),
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
		// Tomorrow's booking: a till neither seats it nor calls it a no-show.
		const mayaId = booked.body.reservation.id
		for (const [toStatus, error] of [
			['seated', 'not_today'],
			['arrived', 'not_today'],
			['no_show', 'too_early'],
		] as const) {
			const refused = await write(`/reservations/${mayaId}/status`, {
				toStatus,
			})
			expect(refused.status, refused.text).toBe(409)
			expect(refused.body.error).toBe(error)
		}
		// A walk-in sits down now, under the name the host typed.
		const walkIn = await write('/walk-ins', {
			locationId: PUBLIC_LOC,
			partySize: 3,
			tableIds: ['tbl_pub_12'],
			guestName: 'Patel',
		})
		expect(walkIn.status, walkIn.text).toBe(201)
		expect(walkIn.body.reservation.businessDate).toBe(dateAhead(0))
		expect(walkIn.body.reservation.guest.firstName).toBe('Patel')
		const laterWalkIn = await write('/walk-ins', {
			locationId: PUBLIC_LOC,
			date: tomorrow,
			time: '20:00',
			partySize: 2,
			tableIds: ['tbl_pub_12'],
		})
		expect(laterWalkIn.status, laterWalkIn.text).toBe(403)
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
		// Guest details: the allergy and the full number. Without them, neither.
		expect(replies['day-feed'].text).toContain('Peanuts')
		expect(replies['day-feed'].text).toContain('+14155550111')
		const plain = await call(
			'POST',
			'/pos/reservations/token',
			{
				...device,
				[POS_STAFF_SESSION_HEADER]: (
					await call('POST', '/pos/sign-in', device, { pin: other.pin })
				).body.sessionToken,
			},
			{ scope: 'book' },
		)
		const masked = await call(
			'GET',
			`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${tomorrow}`,
			{ authorization: `Bearer ${plain.body.token}` },
		)
		expect(masked.text).not.toContain('Peanuts')
		expect(masked.text).not.toContain('+14155550111')
		expect(masked.text).toContain('•••• 0111')

		// A note typed on a waitlist entry rides on the booking once seated:
		// hidden from this till under every name, history included.
		// (A till may not write the note, or an email, on the list itself.)
		for (const extra of [
			{ notes: 'Ramp access, sesame' },
			{ email: 'jane@example.com' },
		]) {
			const refused = await call(
				'POST',
				'/operator/reservations/book/waitlist',
				{
					...rsv,
					'Idempotency-Key': `station-contract-wl-${Object.keys(extra)[0]}`,
				},
				{ locationId: PUBLIC_LOC, displayName: 'Lina', partySize: 2, ...extra },
			)
			expect(refused.status, refused.text).toBe(403)
			expect(refused.body.error).toBe('not_for_station')
		}
		const noted = await createWaitlistEntry({
			orgId: ORG_A,
			locationId: PUBLIC_LOC,
			idempotencyKey: 'station-contract-waitlist-note',
			channel: 'walk_in',
			duplicateCode: 'duplicate_active_entry',
			input: {
				displayName: 'Lina Aziz',
				partySize: 2,
				notes: 'Ramp access, sesame',
			},
		})
		const seatedFromList = await call(
			'POST',
			`/operator/reservations/book/waitlist/${noted.entryId}/seat`,
			{ ...rsv, 'Idempotency-Key': 'station-contract-waitlist-note-seat' },
			{ tableIds: ['tbl_pub_2'] },
		)
		expect(seatedFromList.status, seatedFromList.text).toBe(200)
		const fromListId = seatedFromList.body.reservation.id
		const today = dateAhead(0)
		const plainAuth = { authorization: `Bearer ${plain.body.token}` }
		for (const pathname of [
			`/day?locationId=${PUBLIC_LOC}&date=${today}`,
			`/reservations/${fromListId}`,
			`/reservations/${fromListId}/events`,
		]) {
			const reply = await call(
				'GET',
				`/operator/reservations/book${pathname}`,
				plainAuth,
			)
			expect(reply.status, reply.text).toBe(200)
			expect(reply.text, pathname).not.toContain('Ramp access')
		}
		const managerDay = await call(
			'GET',
			`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${today}`,
			rsv,
		)
		expect(managerDay.text).toContain('Ramp access')

		// A booking's history carries the same health notes: hidden the same way.
		const bookedId = booked.body.reservation.id
		// A manager adds it in the app (a till may not write notes at all).
		const notTill = await write(`/reservations/${bookedId}/notes`, {
			dietaryNotes: 'Severe sesame allergy',
		})
		expect(notTill.status).toBe(403)
		await updateReservationNotes({
			canReadGuestSensitive: true,
			orgId: ORG_A,
			reservationId: bookedId,
			actorId: 'manager',
			input: { dietaryNotes: 'Severe sesame allergy' },
		})
		const fullHistory = await call(
			'GET',
			`/operator/reservations/book/reservations/${bookedId}/events`,
			rsv,
		)
		expect(fullHistory.status, fullHistory.text).toBe(200)
		expect(fullHistory.text).toContain('Severe sesame allergy')
		const hostHistory = await call(
			'GET',
			`/operator/reservations/book/reservations/${bookedId}/events`,
			{ authorization: `Bearer ${plain.body.token}` },
		)
		expect(hostHistory.status, hostHistory.text).toBe(200)
		expect(hostHistory.text).not.toContain('Severe sesame allergy')
		expect(hostHistory.text).not.toContain('Peanuts')
		expect(hostHistory.text).not.toContain('+14155550111')

		// A host without guest details who books a known number links the booking
		// to that guest, but never renames them.
		const typed = await call(
			'POST',
			'/operator/reservations/book/reservations',
			{
				authorization: `Bearer ${plain.body.token}`,
				'Idempotency-Key': 'station-contract-booking-known-phone',
			},
			{
				locationId: PUBLIC_LOC,
				date: tomorrow,
				time: '21:00',
				partySize: 2,
				guest: { firstName: 'Mia', lastName: 'X', phone: '+14155550111' },
			},
		)
		expect(typed.status, typed.text).toBe(201)
		const after = await call(
			'GET',
			`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${tomorrow}`,
			rsv,
		)
		expect(after.text).toContain('Haddad')
		expect(after.text).not.toContain('"Mia"')

		// A till changes a party's size or time, and nothing else on the booking.
		const resized = await call(
			'PATCH',
			`/operator/reservations/book/reservations/${seatedId}`,
			{ authorization: `Bearer ${plain.body.token}` },
			{ partySize: 3 },
		)
		expect(resized.status, resized.text).toBe(200)
		expect(resized.body.reservation.partySize).toBe(3)
		const noted2 = await call(
			'PATCH',
			`/operator/reservations/book/reservations/${seatedId}`,
			{ authorization: `Bearer ${plain.body.token}` },
			{ partySize: 4, staffNotes: 'from the till' },
		)
		expect(noted2.status, noted2.text).toBe(403)
		expect(noted2.body.error).toBe('not_for_station')

		// Nor looks a guest up by email, nor sends a profile with a walk-in: a
		// till without guest details could learn whose address or number it is.
		for (const [key, path, body] of [
			[
				'station-contract-email',
				'/reservations',
				{
					locationId: PUBLIC_LOC,
					date: tomorrow,
					time: '21:00',
					partySize: 2,
					guest: { firstName: 'Mia', email: 'maya@example.com' },
				},
			],
			[
				'station-contract-walkin-guest',
				'/walk-ins',
				{
					locationId: PUBLIC_LOC,
					partySize: 2,
					tableIds: ['tbl_pub_2'],
					guest: { firstName: 'Mia', phone: '+14155550111' },
				},
			],
		] as const) {
			const r = await call(
				'POST',
				`/operator/reservations/book${path}`,
				{
					authorization: `Bearer ${plain.body.token}`,
					'Idempotency-Key': key,
				},
				body,
			)
			expect(r.status, `${path}: ${r.text}`).toBe(403)
		}
		const mayaFeed = await call(
			'GET',
			`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${tomorrow}`,
			rsv,
		)
		const maya = (
			mayaFeed.body.reservations as Array<{
				id: string
				guest: { id: string; email?: string | null; phone?: string | null }
			}>
		).find((r) => r.id === bookedId)!
		expect(maya.guest.email ?? null).toBeNull()
		expect(maya.guest.phone).toBe('+14155550111')
		// A till never attaches a guest profile by id, nor writes health notes,
		// locks a table or books for another channel: its host stand never does.
		for (const [key, path, body] of [
			[
				'station-contract-by-id',
				'/walk-ins',
				{
					locationId: PUBLIC_LOC,
					partySize: 2,
					tableIds: ['tbl_pub_2'],
					guestId: maya.guest.id,
				},
			],
			[
				'station-contract-allergy',
				'/walk-ins',
				{
					locationId: PUBLIC_LOC,
					partySize: 2,
					tableIds: ['tbl_pub_2'],
					guest: { firstName: 'Mia', allergyNotes: null },
				},
			],
			[
				'station-contract-overbook-booking',
				'/reservations',
				{
					locationId: PUBLIC_LOC,
					date: tomorrow,
					time: '21:00',
					partySize: 2,
					overbook: true,
					overbookReason: 'Regulars',
					guest: { firstName: 'Zed' },
				},
			],
			[
				'station-contract-online-channel',
				'/reservations',
				{
					locationId: PUBLIC_LOC,
					date: tomorrow,
					time: '21:00',
					partySize: 2,
					channel: 'online',
					guest: { firstName: 'Zed' },
				},
			],
		] as const) {
			const refused = await call(
				'POST',
				`/operator/reservations/book${path}`,
				{
					authorization: `Bearer ${plain.body.token}`,
					'Idempotency-Key': key,
				},
				body,
			)
			expect(refused.status, `${path}: ${refused.text}`).toBe(403)
			expect(refused.body.error).toBe('not_for_station')
		}
		// Undoing someone else's change is not a till's to do.
		const othersUndo = await call(
			'POST',
			`/operator/reservations/book/reservations/${seatedId}/undo`,
			{
				authorization: `Bearer ${plain.body.token}`,
				'Idempotency-Key': 'station-contract-undo-others',
			},
			{},
		)
		expect(othersUndo.status, othersUndo.text).toBe(409)
		expect(othersUndo.body.error).toBe('undo_not_allowed')
		const stillThere = await call(
			'GET',
			`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=${tomorrow}`,
			rsv,
		)
		expect(stillThere.text).toContain('Peanuts')

		// Every read a till can reach, with ids that exist: no full number, no
		// email, no allergy or dietary note, no card detail, without guest details.
		// A card on file for Maya, so there is something to leak.
		await (await getTenantDb(ORG_A)).insert(rsvPayments).values({
			id: 'pay_station_contract',
			locationId: PUBLIC_LOC,
			reservationId: bookedId,
			provider: 'stripe',
			kind: 'card_setup',
			status: 'succeeded',
			cardBrand: 'visa',
			cardLast4: '4242',
			paymentMethodRef: 'pm_station_contract',
			idempotencyKey: 'station-contract-card',
		})
		// A booking with a card on file is a manager's to cancel or mark no-show:
		// either moves money.
		await (
			await getTenantDb(ORG_A)
		)
			.update(rsvReservations)
			.set({ paymentStatus: 'guaranteed' })
			.where(eq(rsvReservations.id, bookedId))
		for (const toStatus of ['cancelled', 'no_show']) {
			const refused = await call(
				'POST',
				`/operator/reservations/book/reservations/${bookedId}/status`,
				{
					authorization: `Bearer ${plain.body.token}`,
					'Idempotency-Key': `station-contract-${toStatus}`,
				},
				{ toStatus },
			)
			expect(refused.status, refused.text).toBe(409)
			expect(refused.body.error).toBe('manager_required')
		}
		// Nor confirms one still awaiting its deposit: that would waive it.
		await (
			await getTenantDb(ORG_A)
		)
			.update(rsvReservations)
			.set({ status: 'pending_payment', paymentStatus: 'pending' })
			.where(eq(rsvReservations.id, bookedId))
		const waived = await call(
			'POST',
			`/operator/reservations/book/reservations/${bookedId}/status`,
			{
				authorization: `Bearer ${plain.body.token}`,
				'Idempotency-Key': 'station-contract-confirm-unpaid',
			},
			{ toStatus: 'confirmed' },
		)
		expect(waived.status, waived.text).toBe(409)
		expect(waived.body.error).toBe('manager_required')
		const till = { authorization: `Bearer ${plain.body.token}` }
		// Nor resizes it: more covers on a deposit is money.
		const resizedPaid = await call(
			'PATCH',
			`/operator/reservations/book/reservations/${bookedId}`,
			till,
			{ partySize: 6 },
		)
		expect(resizedPaid.status, resizedPaid.text).toBe(409)
		expect(resizedPaid.body.error).toBe('manager_required')
		// Nor brings back a cancelled booking with money on it.
		await (
			await getTenantDb(ORG_A)
		)
			.update(rsvReservations)
			.set({ status: 'cancelled', paymentStatus: 'guaranteed' })
			.where(eq(rsvReservations.id, bookedId))
		const revived = await call(
			'POST',
			`/operator/reservations/book/reservations/${bookedId}/undo`,
			{ ...till, 'Idempotency-Key': 'station-contract-undo-paid' },
			{},
		)
		expect(revived.status, revived.text).toBe(409)
		expect(revived.body.error).toBe('manager_required')
		// A booking that is over does not change size, for anyone.
		const overResize = await call(
			'PATCH',
			`/operator/reservations/book/reservations/${bookedId}`,
			rsv,
			{ partySize: 3 },
		)
		expect(overResize.status, overResize.text).toBe(409)
		expect(overResize.body.error).toBe('invalid_status')
		// A till seats parties on tables, but does not lock or swap them.
		const locking = await call(
			'POST',
			`/operator/reservations/book/reservations/${seatedId}/assign`,
			{ ...till, 'Idempotency-Key': 'station-contract-lock' },
			{ tableIds: ['tbl_pub_4'], lock: true },
		)
		expect(locking.status, locking.text).toBe(403)
		expect(locking.body.error).toBe('not_for_station')
		// Times for changing a party leave out the party's own table.
		const ownFree = await call(
			'GET',
			`/operator/reservations/book/availability?locationId=${PUBLIC_LOC}&date=${tomorrow}&partySize=4&excludeReservationId=${seatedId}`,
			till,
		)
		expect(ownFree.status, ownFree.text).toBe(200)
		const waitingId = waiting.body.entry?.id ?? waiting.body.id
		const fill = (route: string) =>
			route
				.replace(':locationId', PUBLIC_LOC)
				.replace(':id', route.includes('/waitlist/') ? waitingId : bookedId)
				.replace(/:[A-Za-z]+/g, 'unknown')
		const reads = reservationsOperatorRoutes.routes
			.filter(
				(r) =>
					r.method === 'GET' &&
					r.path.startsWith('/book') &&
					!r.path.startsWith('/book/guests'),
			)
			.map((r) => r.path)
		expect(reads.length).toBeGreaterThan(5)
		for (const route of new Set(reads)) {
			const url = `/operator/reservations${fill(route)}?locationId=${PUBLIC_LOC}&date=${tomorrow}&partySize=2`
			const reply = await call('GET', url, {
				authorization: `Bearer ${plain.body.token}`,
			})
			// The till's own reads answer; anything else is refused outright.
			if (stationMayCall('GET', `/operator/reservations${fill(route)}`))
				expect(reply.status, `${route}: ${reply.text}`).toBe(200)
			else expect(reply.status, `${route}: ${reply.text}`).toBe(403)
			for (const secret of [
				'+14155550111',
				'14155550111',
				'@example.com',
				'Peanuts',
				'sesame',
				'4242',
				'cardLast4',
				'pm_station_contract',
			])
				expect(reply.text, `${route} leaks ${secret}`).not.toContain(secret)
		}

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
