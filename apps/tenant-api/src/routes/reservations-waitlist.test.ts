import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	currentBusinessDate,
	instantToLocal,
	publicJoinWaitlistResponseSchema,
	publicNotifyMeResponseSchema,
	publicWaitlistStatusResponseSchema,
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	restrictGrantsForImpersonation,
	waitlistEntryChangeResponseSchema,
	waitlistEntryResponseSchema,
	waitlistListingSchema,
	waitlistQuoteSchema,
	waitlistSeatConflictSchema,
	waitlistSeatResponseSchema,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	rsvAuditLog,
	rsvLocationSettings,
	rsvMessages,
	rsvNotifyRequests,
	rsvRateCounters,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { resetPublicRateLimits } from '../lib/reservations-public-auth.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import { createOperatorReservation } from '../services/rsv-booking-service.ts'
import { runNotifyMeMatching } from '../services/rsv-notify-service.ts'
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

const ORG = 'org_wl_us'
const ORG_KSA = 'org_wl_ksa'
const OPERATOR_SECRET = 'test-waitlist-operator-secret-key-32-chars-min!'
const JWT_SECRET = 'test-waitlist-customer-jwt-secret-123456'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
const originToOrg = vi.hoisted(
	() =>
		new Map<string, string>([
			['http://acme.menuza.test:3008', 'org_wl_us'],
			['http://riyadh.menuza.test:3008', 'org_wl_ksa'],
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

const WAITLIST_ON = { waitlistEnabled: true, waitlistOnline: true }

async function mintOperatorToken(
	options: {
		scope?: 'book' | 'setup'
		grants?: string[]
		locationIds?: string[] | null
		waitlist?: boolean
		impersonated?: boolean
	} = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope: options.scope ?? 'book',
		grants: restrictGrantsForImpersonation(
			options.grants ??
				(options.scope === 'setup'
					? [
							RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
							RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
						]
					: [
							RESERVATIONS_PERMISSIONS.READ_RESERVATION,
							RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
							RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
						]),
			options.impersonated ?? false,
		),
		locationIds: options.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: options.waitlist ?? true,
			experiences: false,
			payments: false,
			voice: false,
		},
		impersonated: options.impersonated ?? false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject('usr_wl_operator')
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

let keyCounter = 0
const idemKey = () =>
	`wl-route-key-${++keyCounter}-${Math.random().toString(36).slice(2, 10)}`

async function operator(
	method: string,
	urlPath: string,
	options: {
		body?: unknown
		token?: string
		key?: string | null
	} = {},
) {
	const token = options.token ?? (await mintOperatorToken())
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
	if (options.key !== null)
		headers['Idempotency-Key'] = options.key ?? idemKey()
	let body: string | undefined
	if (options.body !== undefined && method !== 'GET') {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	const res = await app.request(`/operator/reservations${urlPath}`, {
		method,
		headers,
		body,
	})
	const text = await res.text()
	return { status: res.status, body: text ? JSON.parse(text) : null, text }
}

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

const WL = '/book/waitlist'

function joinBody(n: number, extra: Record<string, unknown> = {}) {
	return {
		locationId: PUBLIC_LOC,
		name: `Remote Guest ${n}`,
		partySize: 2,
		phone: `+1415555${String(2000 + n)}`,
		email: `remote${n}@example.com`,
		smsOptIn: true,
		website: '',
		...extra,
	}
}

function join(n: number, options: CallOptions & { key?: string } = {}) {
	return call('POST', '/reservations/waitlist/join', {
		...options,
		headers: {
			'Idempotency-Key': options.key ?? idemKey(),
			...options.headers,
		},
		body: options.body ?? joinBody(n),
	})
}

async function setSettings(
	patch: Partial<typeof rsvLocationSettings.$inferInsert>,
	orgId = ORG,
) {
	const db = await getTenantDb(orgId)
	await db
		.update(rsvLocationSettings)
		.set(patch)
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
}

async function clearLimits() {
	resetPublicRateLimits()
	const db = await getTenantDb(ORG)
	await db.delete(rsvRateCounters)
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-waitlist-route-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.JWT_SECRET = JWT_SECRET
	process.env.AUTH_HMAC_SECRET = 'test-waitlist-auth-hmac-secret-0123456789'
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
	await seedPublicOrg(ORG, {
		settings: { ...WAITLIST_ON, notifyMeEnabled: true },
	})
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	await destroyTenantDb(ORG_KSA).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
	process.env.DATA_REGION = 'us'
	delete process.env.TURNSTILE_SECRET_KEY
})

describe('operator waitlist routes', () => {
	it('lists an empty day and adds a party with a quote and a position', async () => {
		const empty = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		expect(empty.status).toBe(200)
		expect(empty.body).toMatchObject({
			ok: true,
			orgId: ORG,
			locationId: PUBLIC_LOC,
			counts: { active: 0, waiting: 0, notified: 0, onTheWay: 0 },
			waitlistResponseMin: 10,
			entries: [],
		})

		const created = await operator('POST', WL, {
			body: {
				locationId: PUBLIC_LOC,
				displayName: 'Walk In',
				partySize: 3,
				phone: '+14155550123',
				notes: 'birthday',
			},
		})
		expect(created.status).toBe(201)
		expect(created.body.entry).toMatchObject({
			displayName: 'Walk In',
			partySize: 3,
			status: 'waiting',
			position: 1,
			channel: 'walk_in',
			notes: 'birthday',
		})
		expect(created.body.entry.quotedMin).toBeGreaterThanOrEqual(1)

		const listed = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		expect(listed.body.entries.map((e: { id: string }) => e.id)).toEqual([
			created.body.entry.id,
		])
		expect(listed.body.counts.active).toBe(1)
	})

	it('replays an idempotent add, and refuses the same phone twice', async () => {
		const key = idemKey()
		const body = {
			locationId: PUBLIC_LOC,
			displayName: 'Dup',
			partySize: 2,
			phone: '+14155550124',
		}
		const first = await operator('POST', WL, { body, key })
		const replay = await operator('POST', WL, { body, key })
		expect(replay.status).toBe(201)
		expect(replay.body.entry.id).toBe(first.body.entry.id)
		const clash = await operator('POST', WL, { body })
		expect(clash.status).toBe(409)
		expect(clash.body.error).toBe('duplicate_active_entry')
		const changed = await operator('POST', WL, {
			body: { ...body, partySize: 5 },
			key,
		})
		expect(changed.status).toBe(409)
		expect(changed.body.error).toBe('idempotency_conflict')
	})

	it('validates without echoing submitted values', async () => {
		const res = await operator('POST', WL, {
			body: {
				locationId: PUBLIC_LOC,
				displayName: 'Valid Name',
				partySize: 'SECRET-PARTY-VALUE',
			},
		})
		expect(res.status).toBe(400)
		expect(res.text).not.toContain('SECRET-PARTY-VALUE')
		expect(res.body.issues[0].path).toBe('partySize')
	})

	it('quotes through the same function as the add', async () => {
		const quote = await operator(
			'GET',
			`${WL}/quote?locationId=${PUBLIC_LOC}&partySize=2`,
		)
		expect(quote.status).toBe(200)
		expect(quote.body.quotedMin).toBeGreaterThanOrEqual(1)
		expect(quote.body.quotedMin).toBe(quote.body.quotedWaitMin)
		const created = await operator('POST', WL, {
			body: { locationId: PUBLIC_LOC, displayName: 'Q', partySize: 2 },
		})
		expect(created.body.entry.quotedMin).toBe(quote.body.quotedMin)
		const bad = await operator(
			'GET',
			`${WL}/quote?locationId=${PUBLIC_LOC}&partySize=0`,
		)
		expect(bad.status).toBe(400)
	})

	it('edits, reorders, notifies, and moves an entry through statuses', async () => {
		const ids: string[] = []
		for (const name of ['A', 'B', 'C']) {
			const res = await operator('POST', WL, {
				body: { locationId: PUBLIC_LOC, displayName: name, partySize: 2 },
			})
			ids.push(res.body.entry.id)
		}
		const patched = await operator('PATCH', `${WL}/${ids[0]}`, {
			body: { partySize: 4, expectedVersion: 1 },
		})
		expect(patched.status).toBe(200)
		expect(patched.body.entry).toMatchObject({ partySize: 4, version: 2 })
		const stale = await operator('PATCH', `${WL}/${ids[0]}`, {
			body: { partySize: 3, expectedVersion: 1 },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.error).toBe('stale_version')

		const reordered = await operator('POST', `${WL}/reorder`, {
			body: { locationId: PUBLIC_LOC, ids: [ids[2], ids[0]] },
		})
		expect(reordered.status).toBe(200)
		expect(reordered.body.entries.map((e: { id: string }) => e.id)).toEqual([
			ids[2],
			ids[1],
			ids[0],
		])

		const notified = await operator('POST', `${WL}/${ids[1]}/notify`)
		expect(notified.status).toBe(200)
		expect(notified.body).toMatchObject({
			changed: true,
			entry: { status: 'notified' },
		})
		const deadline =
			notified.body.entry.responseDeadlineAt - notified.body.entry.notifiedAt
		expect(deadline).toBe(10 * 60_000)
		const again = await operator('POST', `${WL}/${ids[1]}/notify`)
		expect(again.body.changed).toBe(false)

		const left = await operator('POST', `${WL}/${ids[2]}/status`, {
			body: { status: 'left' },
		})
		expect(left.body.entry.status).toBe('left')
		const bad = await operator('POST', `${WL}/${ids[2]}/status`, {
			body: { status: 'waiting' },
		})
		expect(bad.status).toBe(409)
		expect(bad.body.error).toBe('invalid_status_transition')
		const invalid = await operator('POST', `${WL}/${ids[2]}/status`, {
			body: { status: 'seated' },
		})
		expect(invalid.status).toBe(400)
	})

	it('seats a party onto a table as a waitlist reservation', async () => {
		const created = await operator('POST', WL, {
			body: { locationId: PUBLIC_LOC, displayName: 'Seat Me', partySize: 2 },
		})
		const id = created.body.entry.id
		const seated = await operator('POST', `${WL}/${id}/seat`, {
			body: { tableIds: ['tbl_pub_2'] },
		})
		expect(seated.status).toBe(200)
		expect(seated.body.entry.status).toBe('seated')
		expect(seated.body.reservation.id).toBe(seated.body.entry.reservationId)
		const db = await getTenantDb(ORG)
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, seated.body.reservation.id))
			.get()
		expect(reservation?.channel).toBe('waitlist')
		const again = await operator('POST', `${WL}/${id}/seat`, {
			body: { tableIds: ['tbl_pub_4'] },
		})
		expect(again.status).toBe(409)
	})

	it('answers 404 for an unknown entry and refuses cross-location, grantless and flag-off tokens', async () => {
		const created = await operator('POST', WL, {
			body: { locationId: PUBLIC_LOC, displayName: 'Guarded', partySize: 2 },
		})
		const id = created.body.entry.id
		const missing = await operator('POST', `${WL}/wle_missing/notify`)
		expect(missing.status).toBe(404)

		const otherLocation = await mintOperatorToken({
			locationIds: ['loc_other'],
		})
		for (const [method, url] of [
			['GET', `${WL}?locationId=${PUBLIC_LOC}`],
			['POST', `${WL}/${id}/notify`],
			['PATCH', `${WL}/${id}`],
			['POST', `${WL}/${id}/seat`],
			['POST', `${WL}/${id}/status`],
		] as const) {
			const res = await operator(method, url, {
				token: otherLocation,
				body: { locationId: undefined, status: 'left', partySize: 2 },
			})
			expect(res.status, `${method} ${url}`).toBe(403)
		}

		const readOnly = await mintOperatorToken({
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
		})
		const denied = await operator('POST', `${WL}/${id}/notify`, {
			token: readOnly,
		})
		expect(denied.status).toBe(403)
		const read = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`, {
			token: readOnly,
		})
		expect(read.status).toBe(200)
		expect(read.body.entries[0].notes ?? null).toBeNull()

		const flagOff = await mintOperatorToken({ waitlist: false })
		const off = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`, {
			token: flagOff,
		})
		expect(off.status).toBeGreaterThanOrEqual(400)
		const impersonated = await mintOperatorToken({ impersonated: true })
		const imp = await operator('POST', `${WL}/${id}/notify`, {
			token: impersonated,
		})
		expect(imp.status).toBe(403)
	})
})

describe('waitlist settings routes', () => {
	const url = `/setup/locations/${PUBLIC_LOC}/waitlist`

	it('reads and updates the waitlist switches with a version check and an audit row', async () => {
		const token = await mintOperatorToken({ scope: 'setup' })
		const read = await operator('GET', url, { token })
		expect(read.status).toBe(200)
		expect(read.body).toMatchObject({
			locationId: PUBLIC_LOC,
			waitlistEnabled: true,
			waitlist_online: true,
			notifyMeEnabled: true,
			waitlistResponseMin: 10,
			waitlistMaxParties: null,
		})
		const put = await operator('PUT', url, {
			token,
			body: {
				expectedVersion: read.body.version,
				waitlistResponseMin: 20,
				waitlistMaxParties: 40,
				notifyMeEnabled: false,
			},
		})
		expect(put.status).toBe(200)
		expect(put.body).toMatchObject({
			waitlistResponseMin: 20,
			waitlist_max_parties: 40,
			notifyMeEnabled: false,
			version: read.body.version + 1,
		})
		const stale = await operator('PUT', url, {
			token,
			body: { expectedVersion: read.body.version, waitlistEnabled: false },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.error).toBe('stale_version')
		for (const bad of [
			{ waitlistResponseMin: 0 },
			{ waitlistResponseMin: 121 },
			{ waitlistMaxParties: 0 },
			{ waitlistMaxParties: 501 },
			{ waitlistEnabled: 'yes' },
		]) {
			const res = await operator('PUT', url, { token, body: bad })
			expect(res.status, JSON.stringify(bad)).toBe(400)
		}
		const cleared = await operator('PUT', url, {
			token,
			body: { waitlistMaxParties: null },
		})
		expect(cleared.body.waitlistMaxParties).toBeNull()
		const db = await getTenantDb(ORG)
		const audits = await db.select().from(rsvAuditLog).all()
		expect(audits.filter((a) => a.action === 'settings.update')).toHaveLength(2)
	})

	it('refuses a read-only token on write and a wrong-scope token', async () => {
		const readOnly = await mintOperatorToken({
			scope: 'setup',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
		})
		const res = await operator('PUT', url, {
			token: readOnly,
			body: { waitlistEnabled: false },
		})
		expect(res.status).toBe(403)
		const wrongScope = await operator('GET', url, {
			token: await mintOperatorToken({ scope: 'book' }),
		})
		expect(wrongScope.status).toBe(403)
		const otherLocation = await mintOperatorToken({
			scope: 'setup',
			locationIds: ['loc_other'],
		})
		expect((await operator('GET', url, { token: otherLocation })).status).toBe(
			403,
		)
	})
})

describe('public waitlist join and status', () => {
	it('joins, then reads the status page by token with no personal data (VAL-WAIT-009/010)', async () => {
		const res = await join(1)
		expect(res.status).toBe(201)
		expect(res.res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(res.body.statusToken).toMatch(/^rsv_w_/)
		expect(res.body.entry).toMatchObject({
			status: 'waiting',
			position: 1,
			partySize: 2,
			locationId: PUBLIC_LOC,
			locationName: 'Acme Downtown',
		})
		expect(res.body.entry.quotedMin).toBeGreaterThanOrEqual(1)
		expect(Date.parse(res.body.entry.quotedReadyAt)).toBeGreaterThan(Date.now())

		const status = await call('GET', '/reservations/waitlist/status', {
			token: res.body.statusToken,
		})
		expect(status.status).toBe(200)
		expect(status.body).toMatchObject({
			status: 'waiting',
			position: 1,
			partySize: 2,
			canLeave: true,
			canOnMyWay: true,
		})
		expect(status.text).not.toContain('Remote Guest')
		expect(status.text).not.toContain('+1415555')
		expect(status.text).not.toContain('example.com')

		const inQuery = await call(
			'GET',
			`/reservations/waitlist/status?t=${res.body.statusToken}`,
		)
		expect(inQuery.status).toBe(404)

		const db = await getTenantDb(ORG)
		const row = await db.select().from(rsvWaitlistEntries).get()
		expect(row).toMatchObject({ channel: 'remote', smsOptIn: true })
		const messages = await db.select().from(rsvMessages).all()
		expect(messages.map((m) => `${m.kind}:${m.channel}`).sort()).toEqual([
			'waitlist_joined:email',
			'waitlist_joined:sms',
		])
	})

	it('shows the notify state and lets the guest say they are on the way, then leave', async () => {
		const joined = await join(2)
		const token = joined.body.statusToken
		const entryId = joined.body.entry.id
		const notified = await operator('POST', `${WL}/${entryId}/notify`)
		expect(notified.status).toBe(200)
		const status = await call('GET', '/reservations/waitlist/status', { token })
		expect(status.body).toMatchObject({ status: 'notified', canOnMyWay: true })
		expect(Date.parse(status.body.responseDeadlineAt)).toBeGreaterThan(
			Date.parse(status.body.notifiedAt),
		)

		const onWay = await call(
			'POST',
			'/reservations/waitlist/status/on-my-way',
			{
				token,
			},
		)
		expect(onWay.status).toBe(200)
		expect(onWay.body.status).toBe('on_the_way')
		const repeat = await call(
			'POST',
			'/reservations/waitlist/status/on-my-way',
			{
				token,
			},
		)
		expect(repeat.body.status).toBe('on_the_way')

		const left = await call('POST', '/reservations/waitlist/status/leave', {
			token,
			body: {},
		})
		expect(left.status).toBe(200)
		expect(left.body).toMatchObject({
			status: 'left',
			position: null,
			canLeave: false,
		})
		const after = await call(
			'POST',
			'/reservations/waitlist/status/on-my-way',
			{
				token,
			},
		)
		expect(after.status).toBe(409)
		expect(after.body.error).toBe('invalid_status_transition')
	})

	it('answers a repeated key with the same entry and token, a changed body with 409 (VAL-WAIT-022)', async () => {
		const key = idemKey()
		const first = await join(3, { key })
		const replay = await join(3, { key })
		expect(replay.status).toBe(201)
		expect(replay.body.entry.id).toBe(first.body.entry.id)
		expect(replay.body.statusToken).toBe(first.body.statusToken)
		const changed = await join(3, {
			key,
			body: joinBody(3, { partySize: 3 }),
		})
		expect(changed.status).toBe(409)
		expect(changed.body.error).toBe('idempotency_conflict')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvWaitlistEntries).all()).toHaveLength(1)
	})

	it('needs an idempotency key, a contact and a name', async () => {
		const noKey = await call('POST', '/reservations/waitlist/join', {
			body: joinBody(4),
		})
		expect(noKey.status).toBe(400)
		const noContact = await join(4, {
			body: joinBody(4, { phone: undefined, email: undefined }),
		})
		expect(noContact.status).toBe(400)
		const noName = await join(4, { body: joinBody(4, { name: undefined }) })
		expect(noName.status).toBe(400)
		const badPhone = await join(4, { body: joinBody(4, { phone: '12' }) })
		expect(badPhone.status).toBe(400)
		expect(badPhone.text).not.toContain('"12"')
	})

	it('refuses a second join for the same phone with already_on_waitlist', async () => {
		await join(5)
		const clash = await join(5, {
			body: joinBody(5, { email: 'other@example.com' }),
		})
		expect(clash.status).toBe(409)
		expect(clash.body.error).toBe('already_on_waitlist')
	})

	it('stops at waitlist_max_parties', async () => {
		await setSettings({ waitlistMaxParties: 1 })
		expect((await join(6)).status).toBe(201)
		const full = await join(7)
		expect(full.status).toBe(409)
		expect(full.body.error).toBe('waitlist_full')
	})

	it('writes nothing for a filled honeypot but looks like success', async () => {
		const res = await join(8, {
			body: joinBody(8, { website: 'http://spam.example' }),
		})
		expect(res.status).toBe(201)
		expect(res.body.statusToken).toMatch(/^rsv_w_/)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvWaitlistEntries).all()).toHaveLength(0)
		const status = await call('GET', '/reservations/waitlist/status', {
			token: res.body.statusToken,
		})
		expect(status.status).toBe(404)
	})

	it('trips the 5 per 10 minute limit with 429 rate_limited', async () => {
		for (let n = 10; n < 15; n++) {
			expect((await join(n)).status).toBe(201)
		}
		const limited = await join(15)
		expect(limited.status).toBe(429)
		expect(limited.body.error).toBe('rate_limited')
	})

	it('counts durable per-IP attempts across a memory reset', async () => {
		for (let n = 20; n < 25; n++) {
			expect((await join(n)).status).toBe(201)
		}
		resetPublicRateLimits()
		const limited = await join(25)
		expect(limited.status).toBe(429)
		const db = await getTenantDb(ORG)
		expect(
			(await db.select().from(rsvRateCounters).all()).length,
		).toBeGreaterThan(0)
	})

	it('answers the uniform 404 when any switch is off', async () => {
		for (const patch of [
			{ waitlistEnabled: false },
			{ waitlistOnline: false },
		]) {
			await setSettings(patch)
			const res = await join(30)
			expect(res.status).toBe(404)
			expect(res.body).toEqual({ error: 'not_found' })
			await setSettings(WAITLIST_ON)
		}
		const ctx = publicContext(ORG)
		for (const features of [
			{ ...ctx.features, waitlist: false },
			{ ...ctx.features, online: false },
		]) {
			seedReservationsContextForTest(ORG, { ...ctx, features })
			resetPublicRateLimits()
			const res = await join(31)
			expect(res.status).toBe(404)
			expect(res.body).toEqual({ error: 'not_found' })
		}
		seedReservationsContextForTest(ORG, ctx)
		resetPublicRateLimits()
		expect((await join(32)).status).toBe(201)
	})

	it('answers identical 404s for missing, forged, cross-org and wrong-origin tokens (VAL-WAIT-014)', async () => {
		const joined = await join(40)
		const token: string = joined.body.statusToken
		const forged = `${token.slice(0, -2)}xx`
		const cases: Array<[string, string, CallOptions]> = []
		for (const [method, urlPath] of [
			['GET', '/reservations/waitlist/status'],
			['POST', '/reservations/waitlist/status/leave'],
			['POST', '/reservations/waitlist/status/on-my-way'],
		] as const) {
			cases.push([method, urlPath, {}])
			cases.push([method, urlPath, { token: forged }])
			cases.push([method, urlPath, { token: 'rsv_w_garbage' }])
			cases.push([method, urlPath, { token: 'rsv_m_other.token' }])
			cases.push([method, urlPath, { token, origin: KSA_ORIGIN }])
			cases.push([method, urlPath, { token, origin: UNKNOWN_ORIGIN }])
			cases.push([method, urlPath, { token, origin: null }])
		}
		const seen = new Set<string>()
		for (const [method, urlPath, options] of cases) {
			const res = await call(method, urlPath, {
				...options,
				body: method === 'POST' ? {} : undefined,
			})
			expect(
				res.status,
				`${method} ${urlPath} ${JSON.stringify(options)}`,
			).toBe(404)
			seen.add(res.text)
		}
		expect([...seen]).toEqual([JSON.stringify({ error: 'not_found' })])

		const still = await call('GET', '/reservations/waitlist/status', { token })
		expect(still.status).toBe(200)
		expect(still.body.status).toBe('waiting')
	})

	it('hides the status page when the waitlist flag is off', async () => {
		const joined = await join(41)
		const ctx = publicContext(ORG)
		seedReservationsContextForTest(ORG, {
			...ctx,
			features: { ...ctx.features, waitlist: false },
		})
		const res = await call('GET', '/reservations/waitlist/status', {
			token: joined.body.statusToken,
		})
		expect(res.status).toBe(404)
	})

	it('refuses other methods on the POST routes without running them', async () => {
		for (const urlPath of [
			'/reservations/waitlist/join',
			'/reservations/waitlist/status/leave',
			'/reservations/waitlist/status/on-my-way',
			'/reservations/notify-me',
			'/reservations/notify-me/cancel',
		]) {
			for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
				const res = await call(method, urlPath)
				expect(res.status, `${method} ${urlPath}`).toBeGreaterThanOrEqual(400)
			}
		}
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvWaitlistEntries).all()).toHaveLength(0)
	})

	it('exposes the waitlist and notify-me hints only while the module is on', async () => {
		const config = await call('GET', '/reservations/config')
		expect(config.body.locations[0]).toMatchObject({
			waitlist: { enabled: true, online: true },
			notifyMe: true,
		})
		const day = dateAhead(3)
		const query = `/reservations/availability?locationId=${PUBLIC_LOC}&date=${day}&partySize=2`
		const on = await call('GET', query)
		expect(on.body).toMatchObject({ notifyMe: true, waitlist: true })

		const ctx = publicContext(ORG)
		seedReservationsContextForTest(ORG, {
			...ctx,
			features: { ...ctx.features, waitlist: false },
		})
		const offConfig = await call('GET', '/reservations/config')
		expect(offConfig.body.locations[0]).toMatchObject({
			waitlist: { enabled: false, online: false },
			notifyMe: false,
		})
		const off = await call('GET', query)
		expect(off.body).toMatchObject({ notifyMe: false, waitlist: false })
	})
})

describe('telling a party their table is ready', () => {
	it('says whether a text was queued: only for a guest who agreed, on a node that sends texts', async () => {
		// Joined online and agreed to texts, US node: a text goes out.
		const online = await join(60)
		expect(online.status).toBe(201)
		const onlineId = online.body.entry?.id ?? online.body.id
		const list = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		const joined = list.body.entries.find(
			(e: { channel?: string }) => e.channel === 'remote',
		)
		const told = await operator(
			'POST',
			`${WL}/${joined?.id ?? onlineId}/notify`,
		)
		expect(told.status).toBe(200)
		expect(told.body).toMatchObject({ changed: true, textQueued: true })
		// A repeat tap queues nothing and says nothing about a text.
		const again = await operator(
			'POST',
			`${WL}/${joined?.id ?? onlineId}/notify`,
		)
		expect(again.body.changed).toBe(false)
		expect('textQueued' in again.body).toBe(false)
		// Added at the stand: no consent, so no text.
		const added = await operator('POST', WL, {
			body: {
				locationId: PUBLIC_LOC,
				displayName: 'Walk-up',
				partySize: 2,
				phone: '+14155550777',
			},
		})
		expect(added.status).toBe(201)
		const standTold = await operator(
			'POST',
			`${WL}/${added.body.entry.id}/notify`,
		)
		expect(standTold.body).toMatchObject({ changed: true, textQueued: false })
	})
})

describe('KSA node', () => {
	it('sends waitlist messages by email only and never queues an SMS (VAL-WAIT-020)', async () => {
		process.env.DATA_REGION = 'ksa'
		await seedPublicOrg(ORG_KSA, {
			dataRegion: 'ksa',
			settings: WAITLIST_ON,
		})
		const res = await join(50, { origin: KSA_ORIGIN })
		expect(res.status).toBe(201)
		const db = await getTenantDb(ORG_KSA)
		const entry = await db.select().from(rsvWaitlistEntries).get()
		expect(entry?.phoneE164).toBeTruthy()
		const messages = await db.select().from(rsvMessages).all()
		expect(messages.length).toBeGreaterThan(0)
		expect(messages.every((m) => m.channel === 'email')).toBe(true)
		const status = await call('GET', '/reservations/waitlist/status', {
			token: res.body.statusToken,
			origin: KSA_ORIGIN,
		})
		expect(status.status).toBe(200)
		const usOrigin = await call('GET', '/reservations/waitlist/status', {
			token: res.body.statusToken,
		})
		expect(usOrigin.status).toBe(404)
	})
})

describe('public notify-me', () => {
	const DAY = dateAhead(4)
	const notifyBody = (n: number, extra: Record<string, unknown> = {}) => ({
		locationId: PUBLIC_LOC,
		date: DAY,
		partySize: 2,
		fromLocalMin: 18 * 60,
		toLocalMin: 20 * 60,
		email: `notify${n}@example.com`,
		website: '',
		...extra,
	})
	const notifyMe = (n: number, options: CallOptions & { key?: string } = {}) =>
		call('POST', '/reservations/notify-me', {
			...options,
			headers: {
				'Idempotency-Key': options.key ?? idemKey(),
				...options.headers,
			},
			body: options.body ?? notifyBody(n),
		})

	it('creates a request with a cancel token, then cancels once and 404s on reuse (VAL-WAIT-015/017)', async () => {
		const res = await notifyMe(1)
		expect(res.status).toBe(201)
		expect(res.body.cancelToken).toMatch(/^rsv_n_/)
		expect(res.body.request).toMatchObject({
			status: 'active',
			date: DAY,
			partySize: 2,
		})
		const db = await getTenantDb(ORG)
		const row = await db.select().from(rsvNotifyRequests).get()
		expect(row).toMatchObject({
			status: 'active',
			contactEmailNorm: 'notify1@example.com',
		})

		const forged = await call('POST', '/reservations/notify-me/cancel', {
			token: `${res.body.cancelToken.slice(0, -2)}xx`,
			body: {},
		})
		expect(forged.status).toBe(404)
		const cancelled = await call('POST', '/reservations/notify-me/cancel', {
			token: res.body.cancelToken,
			body: {},
		})
		expect(cancelled.status).toBe(200)
		expect(cancelled.body.cancelled).toBe(true)
		const reuse = await call('POST', '/reservations/notify-me/cancel', {
			token: res.body.cancelToken,
			body: {},
		})
		expect(reuse.status).toBe(404)
		expect(reuse.body).toEqual({ error: 'not_found' })
		expect((await db.select().from(rsvNotifyRequests).get())?.status).toBe(
			'cancelled',
		)

		const viaBody = await notifyMe(2)
		const cancelViaBody = await call('POST', '/reservations/notify-me/cancel', {
			body: { cancelToken: viaBody.body.cancelToken },
		})
		expect(cancelViaBody.status).toBe(200)
	})

	it('caps a contact at five active requests and replays an idempotent key', async () => {
		const key = idemKey()
		const first = await notifyMe(3, { key })
		const replay = await notifyMe(3, { key })
		expect(replay.body.request.id).toBe(first.body.request.id)
		expect(replay.body.cancelToken).toBe(first.body.cancelToken)
		const changed = await notifyMe(3, {
			key,
			body: notifyBody(3, { toLocalMin: 21 * 60 }),
		})
		expect(changed.status).toBe(409)
		expect(changed.body.error).toBe('idempotency_conflict')
	})

	it('refuses a sixth active request for one contact', async () => {
		for (let i = 0; i < 5; i++) {
			await clearLimits()
			const res = await notifyMe(4, {
				body: notifyBody(4, { toLocalMin: 1200 + i }),
			})
			expect(res.status).toBe(201)
		}
		await clearLimits()
		const sixth = await notifyMe(4, {
			body: notifyBody(4, { toLocalMin: 1300 }),
		})
		expect(sixth.status).toBe(409)
		expect(sixth.body.error).toBe('too_many_active_requests')
	})

	it('writes nothing for a filled honeypot', async () => {
		const res = await notifyMe(5, {
			body: notifyBody(5, { website: 'http://spam.example' }),
		})
		expect(res.status).toBe(201)
		expect(res.body.cancelToken).toMatch(/^rsv_n_/)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvNotifyRequests).all()).toHaveLength(0)
		const cancel = await call('POST', '/reservations/notify-me/cancel', {
			token: res.body.cancelToken,
			body: {},
		})
		expect(cancel.status).toBe(404)
	})

	it('trips the 5 per 10 minute limit', async () => {
		for (let n = 10; n < 15; n++) {
			expect((await notifyMe(n)).status).toBe(201)
		}
		const limited = await notifyMe(15)
		expect(limited.status).toBe(429)
		expect(limited.body.error).toBe('rate_limited')
	})

	it('answers the uniform 404 when notify-me or the module is off, and 400 for bad input', async () => {
		await setSettings({ notifyMeEnabled: false })
		const off = await notifyMe(20)
		expect(off.status).toBe(404)
		expect(off.body).toEqual({ error: 'not_found' })
		await setSettings({ notifyMeEnabled: true })

		const ctx = publicContext(ORG)
		seedReservationsContextForTest(ORG, {
			...ctx,
			features: { ...ctx.features, waitlist: false },
		})
		resetPublicRateLimits()
		expect((await notifyMe(21)).status).toBe(404)
		seedReservationsContextForTest(ORG, ctx)

		resetPublicRateLimits()
		const noContact = await notifyMe(22, {
			body: notifyBody(22, { email: undefined }),
		})
		expect(noContact.status).toBe(400)
		const bigParty = await notifyMe(22, {
			body: notifyBody(22, { partySize: 9 }),
		})
		expect(bigParty.status).toBe(400)
		const noKey = await call('POST', '/reservations/notify-me', {
			body: notifyBody(23),
		})
		expect(noKey.status).toBe(400)
		const past = await notifyMe(24, {
			body: notifyBody(24, { date: dateAhead(-1) }),
		})
		expect(past.status).toBe(400)
	})

	it('refuses an unknown origin, the KSA origin and missing origin alike', async () => {
		const seen = new Set<string>()
		for (const origin of [UNKNOWN_ORIGIN, KSA_ORIGIN, null]) {
			const res = await notifyMe(30, { origin })
			expect(res.status).toBe(404)
			seen.add(res.text)
		}
		expect(seen.size).toBe(1)
	})

	it('runs the matching task over a freed day and notifies the guest once (VAL-WAIT-016)', async () => {
		const res = await notifyMe(40)
		expect(res.status).toBe(201)
		const out = await runNotifyMeMatching(ORG, { now: Date.now() })
		expect(out.notified).toBe(1)
		const db = await getTenantDb(ORG)
		expect((await db.select().from(rsvNotifyRequests).get())?.status).toBe(
			'notified',
		)
		const messages = await db.select().from(rsvMessages).all()
		expect(messages.filter((m) => m.kind === 'notify_available')).toHaveLength(
			1,
		)
		const cancel = await call('POST', '/reservations/notify-me/cancel', {
			token: res.body.cancelToken,
			body: {},
		})
		expect(cancel.status).toBe(200)
	})
})

describe('trailing slash', () => {
	it('answers every operator waitlist route the same with and without a trailing slash', async () => {
		const list = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		const listSlash = await operator('GET', `${WL}/?locationId=${PUBLIC_LOC}`)
		expect(listSlash.status).toBe(200)
		expect(listSlash.body).toEqual({ ...list.body, now: listSlash.body.now })

		const quote = await operator(
			'GET',
			`${WL}/quote/?locationId=${PUBLIC_LOC}&partySize=2`,
		)
		expect(quote.status).toBe(200)

		const created = await operator('POST', `${WL}/`, {
			body: { locationId: PUBLIC_LOC, displayName: 'Slash', partySize: 2 },
		})
		expect(created.status).toBe(201)
		const id = created.body.entry.id

		const patched = await operator('PATCH', `${WL}/${id}/`, {
			body: { partySize: 3 },
		})
		expect(patched.status).toBe(200)
		const notified = await operator('POST', `${WL}/${id}/notify/`)
		expect(notified.status).toBe(200)
		const status = await operator('POST', `${WL}/${id}/status/`, {
			body: { status: 'on_the_way' },
		})
		expect(status.status).toBe(200)
		const reordered = await operator('POST', `${WL}/reorder/`, {
			body: { locationId: PUBLIC_LOC, ids: [id] },
		})
		expect(reordered.status).toBe(200)
		const seated = await operator('POST', `${WL}/${id}/seat/`, {
			body: { tableIds: ['tbl_pub_4'] },
		})
		expect(seated.status).toBe(200)
		expect(seated.body.entry.status).toBe('seated')

		const noToken = await app.request(`/operator/reservations${WL}/`, {
			method: 'GET',
		})
		expect(noToken.status).toBe(401)
	})

	it('answers every public waitlist and notify-me route with a trailing slash', async () => {
		const joined = await call('POST', '/reservations/waitlist/join/', {
			headers: { 'Idempotency-Key': idemKey() },
			body: joinBody(41),
		})
		expect(joined.status).toBe(201)
		const token = joined.body.statusToken
		const status = await call('GET', '/reservations/waitlist/status/', {
			token,
		})
		expect(status.status).toBe(200)
		const onWay = await call(
			'POST',
			'/reservations/waitlist/status/on-my-way/',
			{
				token,
			},
		)
		expect(onWay.status).toBe(200)
		const left = await call('POST', '/reservations/waitlist/status/leave/', {
			token,
		})
		expect(left.status).toBe(200)
		const nmBody = {
			locationId: PUBLIC_LOC,
			date: dateAhead(2),
			partySize: 2,
			fromLocalMin: 18 * 60,
			toLocalMin: 20 * 60,
			email: 'slash@example.com',
			website: '',
		}
		const notify = await call('POST', '/reservations/notify-me/', {
			headers: { 'Idempotency-Key': idemKey() },
			body: nmBody,
		})
		expect(notify.status).toBe(201)
		const cancel = await call('POST', '/reservations/notify-me/cancel/', {
			body: { cancelToken: notify.body.cancelToken },
		})
		expect(cancel.status).toBe(200)
		const wrongMethod = await call('GET', '/reservations/waitlist/join/')
		const wrongMethodBare = await call('GET', '/reservations/waitlist/join')
		expect(wrongMethod.status).toBe(wrongMethodBare.status)
		expect(wrongMethod.res.headers.get('Allow')).toBe('POST')
		expect(wrongMethodBare.res.headers.get('Allow')).toBe('POST')
	})
})

describe('@repo/reservations waitlist schemas parse real route payloads', () => {
	it('parses operator responses', async () => {
		const empty = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		expect(waitlistListingSchema.parse(empty.body).entries).toEqual([])

		const quote = await operator(
			'GET',
			`${WL}/quote?locationId=${PUBLIC_LOC}&partySize=2`,
		)
		expect(waitlistQuoteSchema.parse(quote.body).partySize).toBe(2)

		const created = await operator('POST', WL, {
			body: {
				locationId: PUBLIC_LOC,
				displayName: 'Schema Guest',
				partySize: 2,
				phone: '+14155550177',
				notes: 'window',
			},
		})
		const entry = waitlistEntryResponseSchema.parse(created.body).entry
		expect(entry).toMatchObject({
			displayName: 'Schema Guest',
			firstName: 'Schema',
		})

		const patched = await operator('PATCH', `${WL}/${entry.id}`, {
			body: { partySize: 3 },
		})
		expect(
			waitlistEntryResponseSchema.parse(patched.body).entry.partySize,
		).toBe(3)

		const notified = await operator('POST', `${WL}/${entry.id}/notify`)
		expect(
			waitlistEntryChangeResponseSchema.parse(notified.body),
		).toMatchObject({
			changed: true,
			entry: { status: 'notified' },
		})
		const status = await operator('POST', `${WL}/${entry.id}/status`, {
			body: { status: 'waiting' },
		})
		expect(
			waitlistEntryChangeResponseSchema.parse(status.body).entry.status,
		).toBe('waiting')

		const listed = await operator('GET', `${WL}?locationId=${PUBLIC_LOC}`)
		expect(waitlistListingSchema.parse(listed.body).entries).toHaveLength(1)

		const seated = await operator('POST', `${WL}/${entry.id}/seat`, {
			body: { tableIds: ['tbl_pub_4'] },
		})
		const parsed = waitlistSeatResponseSchema.parse(seated.body)
		expect(parsed.entry.status).toBe('seated')
		expect(parsed.reservation?.id).toBe(parsed.entry.reservationId)
	})

	it('parses public join, status and notify-me responses', async () => {
		const joined = await join(51)
		const parsed = publicJoinWaitlistResponseSchema.parse(joined.body)
		expect(parsed.entry.status).toBe('waiting')
		const status = await call('GET', '/reservations/waitlist/status', {
			token: parsed.statusToken,
		})
		expect(publicWaitlistStatusResponseSchema.parse(status.body).position).toBe(
			1,
		)
		const notified = await operator('POST', `${WL}/${parsed.entry.id}/notify`)
		expect(notified.status).toBe(200)
		const notifiedStatus = await call('GET', '/reservations/waitlist/status', {
			token: parsed.statusToken,
		})
		expect(
			publicWaitlistStatusResponseSchema.parse(notifiedStatus.body).status,
		).toBe('notified')

		const nm = await call('POST', '/reservations/notify-me', {
			headers: { 'Idempotency-Key': idemKey() },
			body: {
				locationId: PUBLIC_LOC,
				date: dateAhead(2),
				partySize: 2,
				fromLocalMin: 18 * 60,
				toLocalMin: 20 * 60,
				email: 'schema@example.com',
			},
		})
		expect(publicNotifyMeResponseSchema.parse(nm.body).request.status).toBe(
			'active',
		)
	})
})

describe('seating a waitlist party on an occupied table', () => {
	const T2 = 'tbl_pub_2'

	async function addEntry(name: string, partySize = 2) {
		const res = await operator('POST', WL, {
			body: { locationId: PUBLIC_LOC, displayName: name, partySize },
		})
		return res.body.entry as { id: string; version: number }
	}

	async function seat(
		id: string,
		body: Record<string, unknown>,
		token?: string,
	) {
		return operator('POST', `${WL}/${id}/seat`, { body, token })
	}

	async function activeTables(reservationId: string) {
		const db = await getTenantDb(ORG)
		const rows = await db
			.select({ tableId: rsvTableOccupancies.tableId })
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.reservationId, reservationId),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all()
		return rows.map((r) => r.tableId)
	}

	async function seatedOccupant(name = 'Occupant Party') {
		const entry = await addEntry(name)
		const res = await seat(entry.id, { tableIds: [T2] })
		expect(res.status).toBe(200)
		return res.body.reservation.id as string
	}

	async function bookedOccupant() {
		const now = Date.now()
		const businessDate = currentBusinessDate(now, 'UTC', 240)
		const { localStartMin } = instantToLocal(now, 'UTC')
		const { reservation } = await createOperatorReservation({
			orgId: ORG,
			locationId: PUBLIC_LOC,
			actorId: 'usr_wl_operator',
			idempotencyKey: idemKey(),
			input: {
				date: businessDate,
				localStartMin,
				partySize: 2,
				tableIds: [T2],
				channel: 'phone',
				guest: { firstName: 'Booked', lastName: 'Guest' },
			},
		})
		expect(reservation.status).not.toBe('seated')
		return reservation.id
	}

	async function addSpareTable() {
		const db = await getTenantDb(ORG)
		await db.insert(rsvTables).values({
			id: 'tbl_wl_spare',
			locationId: PUBLIC_LOC,
			areaId: 'area_pub_main',
			label: 'S2',
			minCovers: 1,
			maxCovers: 2,
			onlineBookable: true,
			resetBufferMin: 0,
		})
		clearReservationDayCacheForTest()
	}

	async function audit(action: string) {
		const db = await getTenantDb(ORG)
		return (await db.select().from(rsvAuditLog).all()).filter(
			(row) => row.action === action,
		)
	}

	it('answers 409 with the occupant and the accepted resolutions, and changes nothing', async () => {
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Next Party')
		const res = await seat(entry.id, { tableIds: [T2] })
		expect(res.status).toBe(409)
		const conflict = waitlistSeatConflictSchema.parse(res.body)
		expect(conflict.occupant).toMatchObject({
			kind: 'reservation',
			reservationId: occupantId,
			status: 'seated',
			partySize: 2,
			guestName: 'Occupant Party',
			tableIds: [T2],
		})
		expect(conflict.resolutions).toEqual(['move', 'overbook'])

		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(rsvWaitlistEntries)
			.where(eq(rsvWaitlistEntries.id, entry.id))
			.get()
		expect(row?.status).toBe('waiting')

		const noGuest = await mintOperatorToken({
			grants: [
				RESERVATIONS_PERMISSIONS.READ_RESERVATION,
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			],
		})
		const hidden = await seat(entry.id, { tableIds: [T2] }, noGuest)
		expect(hidden.status).toBe(409)
		expect(hidden.body.occupant.guestName).toBeNull()
		expect(hidden.text).not.toContain('Occupant Party')
	})

	it('move: sends the occupant to a free table and seats the party, audited', async () => {
		await addSpareTable()
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Mover')
		const res = await seat(entry.id, { tableIds: [T2], resolution: 'move' })
		expect(res.status).toBe(200)
		const parsed = waitlistSeatResponseSchema.parse(res.body)
		expect(parsed.entry.status).toBe('seated')
		expect(parsed.moves).toEqual([
			expect.objectContaining({
				reservationId: occupantId,
				fromTableIds: [T2],
				toTableIds: ['tbl_wl_spare'],
			}),
		])
		expect(await activeTables(occupantId)).toEqual(['tbl_wl_spare'])
		expect(await activeTables(parsed.reservation!.id)).toEqual([T2])
		const rows = await audit('waitlist.seat_resolution')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			entityId: occupantId,
			changes: expect.objectContaining({ resolution: 'move' }),
		})
	})

	it('move: honours an explicit target table', async () => {
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Mover')
		const res = await seat(entry.id, {
			tableIds: [T2],
			resolution: 'move',
			moveToTableIds: ['tbl_pub_4'],
		})
		expect(res.status).toBe(200)
		expect(await activeTables(occupantId)).toEqual(['tbl_pub_4'])
	})

	it('move: refuses when no other table fits, and rolls everything back', async () => {
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Stuck')
		const res = await seat(entry.id, { tableIds: [T2], resolution: 'move' })
		expect(res.status).toBe(409)
		expect(res.body.error).toBe('no_move_target')
		expect(await activeTables(occupantId)).toEqual([T2])
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(rsvWaitlistEntries)
			.where(eq(rsvWaitlistEntries.id, entry.id))
			.get()
		expect(row).toMatchObject({ status: 'waiting', reservationId: null })
		expect(await audit('waitlist.seat_resolution')).toHaveLength(0)
	})

	it('move onto a table that holds a locked party fails whole: the occupant stays put', async () => {
		const occupantId = await seatedOccupant()
		const other = await addEntry('Other', 3)
		const otherSeat = await seat(other.id, { tableIds: ['tbl_pub_4'] })
		expect(otherSeat.status).toBe(200)
		const entry = await addEntry('Blocked Mover')
		const res = await seat(entry.id, {
			tableIds: [T2],
			resolution: 'move',
			moveToTableIds: ['tbl_pub_4'],
		})
		expect(res.status).toBe(409)
		expect(res.body.error).toBe('locked_table_conflict')
		expect(await activeTables(occupantId)).toEqual([T2])
		expect(await activeTables(otherSeat.body.reservation.id)).toEqual([
			'tbl_pub_4',
		])
		const db = await getTenantDb(ORG)
		const rows = await db.select().from(rsvReservations).all()
		expect(rows).toHaveLength(2)
		expect(await audit('waitlist.seat_resolution')).toHaveLength(0)
	})

	it('swap: unseats a booked occupant and seats the party', async () => {
		const occupantId = await bookedOccupant()
		const entry = await addEntry('Swapper')
		const conflict = await seat(entry.id, { tableIds: [T2] })
		expect(conflict.status).toBe(409)
		expect(conflict.body.resolutions).toEqual(['swap', 'move', 'overbook'])

		const res = await seat(entry.id, { tableIds: [T2], resolution: 'swap' })
		expect(res.status).toBe(200)
		expect(res.body.entry.status).toBe('seated')
		expect(await activeTables(occupantId)).toEqual([])
		expect(await activeTables(res.body.reservation.id)).toEqual([T2])
		const db = await getTenantDb(ORG)
		const occupant = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, occupantId))
			.get()
		expect(occupant?.assignment).toBe('soft')
		expect(['booked', 'confirmed']).toContain(occupant?.status)
		const rows = await audit('waitlist.seat_resolution')
		expect(rows[0]).toMatchObject({
			entityId: occupantId,
			changes: expect.objectContaining({ resolution: 'swap', toTableIds: [] }),
		})
	})

	it('swap: refuses an arrived or seated occupant', async () => {
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Swapper')
		const res = await seat(entry.id, { tableIds: [T2], resolution: 'swap' })
		expect(res.status).toBe(409)
		expect(res.body.error).toBe('swap_target_seated')
		expect(await activeTables(occupantId)).toEqual([T2])
	})

	it('overbook: seats anyway and records the overbook in the audit log', async () => {
		const occupantId = await seatedOccupant()
		const entry = await addEntry('Overbooker')
		const res = await seat(entry.id, {
			tableIds: [T2],
			resolution: 'overbook',
			overbookReason: 'regular guest',
		})
		expect(res.status).toBe(200)
		expect(await activeTables(occupantId)).toEqual([T2])
		expect(await activeTables(res.body.reservation.id)).toEqual([T2])
		const rows = await audit('reservation.overbook')
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			entityId: res.body.reservation.id,
			changes: expect.objectContaining({ reason: 'regular guest' }),
		})
		const db = await getTenantDb(ORG)
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, res.body.reservation.id))
			.get()
		expect(reservation?.overbooked).toBe(true)
	})

	it('overbook without a reason uses a default one', async () => {
		await seatedOccupant()
		const entry = await addEntry('Overbooker')
		const res = await seat(entry.id, { tableIds: [T2], resolution: 'overbook' })
		expect(res.status).toBe(200)
		expect((await audit('reservation.overbook'))[0]?.changes).toMatchObject({
			reason: 'Waitlist overbook',
		})
	})

	it('a resolution does nothing when the table is free', async () => {
		const entry = await addEntry('Free Table')
		const res = await seat(entry.id, { tableIds: [T2], resolution: 'swap' })
		expect(res.status).toBe(200)
		expect(res.body.moves).toEqual([])
		expect(await audit('waitlist.seat_resolution')).toHaveLength(0)
	})

	it('rejects an unknown resolution without echoing it', async () => {
		const entry = await addEntry('Bad')
		const res = await seat(entry.id, {
			tableIds: [T2],
			resolution: 'SECRET-RESOLUTION',
		})
		expect(res.status).toBe(400)
		expect(res.text).not.toContain('SECRET-RESOLUTION')
	})
})
