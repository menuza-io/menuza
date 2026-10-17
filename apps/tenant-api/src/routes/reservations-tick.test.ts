import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvReservations,
} from '@repo/tenant-db'
import { type ReservationsContext } from '@repo/reservations'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantApiApp } from '../app.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { resetReservationsTickLocks } from '../services/rsv-tick-service.ts'
import { reservationsTickRoutes } from './reservations-tick.ts'
import {
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'

const contexts = vi.hoisted(() => new Map<string, unknown | 'throw'>())

vi.mock('../lib/reservations-context.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/reservations-context.ts')>()),
	getReservationsContext: vi.fn(async (orgId: string) => {
		const value = contexts.get(orgId)
		if (value === 'throw') throw new Error('control plane exploded')
		return (value as ReservationsContext | undefined) ?? null
	}),
}))

const INTERNAL_TOKEN = 'test-internal-token-very-long-and-secure-12345'
const OPERATOR_TOKEN = 'test-operator-token-very-long-and-secure-12345'
const VOICE_TOKEN = 'test-voice-agent-token-very-long-and-secure-123'
const ORG_A = 'clw9x0a12000008l00rsvtka'
const ORG_B = 'clw9x0a12000008l00rsvtkb'
const ORG_NO_DB = 'clw9x0a12000008l00rsvnodb'
const MINUTE = 60_000
const HOUR = 60 * MINUTE

let directory: string
let app: ReturnType<typeof createTenantApiApp>
let ipCounter = 0

function post(
	body: unknown,
	options: {
		token?: string | null
		raw?: string
		authorization?: string
		ip?: string
	} = {},
) {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-forwarded-for': options.ip ?? `10.7.0.${++ipCounter}`,
	}
	const token = options.token === undefined ? INTERNAL_TOKEN : options.token
	if (options.authorization) headers.Authorization = options.authorization
	else if (token) headers.Authorization = `Bearer ${token}`
	return app.request('/api/reservations/tick', {
		method: 'POST',
		headers,
		body: options.raw ?? JSON.stringify(body),
	})
}

function contextFor(
	orgId: string,
	over: { enabled?: boolean; dataRegion?: 'us' | 'ksa' } = {},
): ReservationsContext {
	const base = publicContext(orgId, { dataRegion: over.dataRegion })
	return {
		...base,
		features: { ...base.features, enabled: over.enabled ?? true },
	}
}

async function seedOverdueWork(orgId: string) {
	const db = await getTenantDb(orgId)
	await db
		.update(rsvLocationSettings)
		.set({ autoNoShowAfterMin: 10 })
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
	await db.insert(rsvGuests).values({
		id: 'guest_route_tick',
		firstName: 'Rana',
		lastName: 'Khalid',
		emailNorm: 'rana.khalid@example.com',
		phoneE164: '+14155550199',
	})
	const startAt = Date.now() - 2 * HOUR
	await db.insert(rsvReservations).values({
		id: 'res_route_tick',
		locationId: PUBLIC_LOC,
		guestId: 'guest_route_tick',
		confirmationCode: 'ROUTETICK1',
		businessDate: new Date(startAt).toISOString().slice(0, 10),
		localStartMin: 19 * 60,
		timeZone: 'UTC',
		startAt,
		endAt: startAt + 90 * MINUTE,
		durationMin: 90,
		partySize: 2,
		status: 'booked',
	})
	const holdStart = Date.now() + 3 * 24 * HOUR
	await db.insert(rsvHolds).values({
		id: 'hold_route_tick',
		locationId: PUBLIC_LOC,
		tokenHash: 'route-tick-token-hash',
		businessDate: new Date(holdStart).toISOString().slice(0, 10),
		localStartMin: 19 * 60,
		startAt: holdStart,
		endAt: holdStart + 90 * MINUTE,
		partySize: 2,
		status: 'active',
		expiresAt: Date.now() - MINUTE,
	})
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-tick-route-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
	vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_TOKEN)
	vi.stubEnv('VOICE_AGENT_TOKEN', VOICE_TOKEN)
	vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	vi.stubEnv('APP_URL', '')
	contexts.clear()
	resetRateLimits()
	resetReservationsTickLocks()
	await seedPublicOrg(ORG_A, { settings: { waitlistEnabled: true } })
	await provisionTenantDb(ORG_B)
	app = createTenantApiApp()
})

afterEach(async () => {
	for (const id of [ORG_A, ORG_B]) {
		await destroyTenantDb(id).catch(() => {})
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe('POST /api/reservations/tick authentication', () => {
	it('refuses a request with no token, a wrong token, or a malformed header', async () => {
		for (const options of [
			{ token: null },
			{ token: 'wrong-token-wrong-token-wrong-token' },
			// Same length as the real token, different bytes.
			{ token: INTERNAL_TOKEN.replace(/.$/, 'X') },
			{ authorization: `Basic ${INTERNAL_TOKEN}` },
			{ authorization: INTERNAL_TOKEN },
			{ authorization: 'Bearer ' },
			{ authorization: `bearer ${INTERNAL_TOKEN}` },
		]) {
			const response = await post({ orgId: ORG_A }, options)
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ error: 'unauthorized' })
		}
	})

	it('never accepts an operator, voice agent or customer credential', async () => {
		for (const token of [
			OPERATOR_TOKEN,
			VOICE_TOKEN,
			'test-jwt-secret-123456789',
		]) {
			expect((await post({ orgId: ORG_A }, { token })).status).toBe(401)
		}
		expect((await post({}, { token: OPERATOR_TOKEN })).status).toBe(401)
	})

	it('checks the token before the body, so a bad body never leaks validation detail', async () => {
		const response = await post({ orgId: '../etc' }, { token: null })
		expect(response.status).toBe(401)
		expect(await response.json()).toEqual({ error: 'unauthorized' })
	})

	it('answers 503 when the internal token is not configured or too short', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		const short = await post({ orgId: ORG_A }, { token: 'short' })
		expect(short.status).toBe(503)
		expect(await short.json()).toEqual({ error: 'service_unavailable' })

		vi.stubEnv('INTERNAL_COMMAND_TOKEN', '')
		expect((await post({}, { token: null })).status).toBe(503)
		expect((await post({}, { token: '' })).status).toBe(503)
	})

	it('answers 503 before it looks at the body when it is not configured', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		expect((await post({ orgId: '../etc' }, { token: 'short' })).status).toBe(
			503,
		)
	})

	it('marks every refusal as uncacheable', async () => {
		const unauthorized = await post({}, { token: null })
		expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		const unavailable = await post({}, { token: 'short' })
		expect(unavailable.headers.get('Cache-Control')).toBe('private, no-store')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
		const invalid = await post({ orgId: '../etc' })
		expect(invalid.headers.get('Cache-Control')).toBe('private, no-store')
	})

	it('is a POST route only, and only at /tick', async () => {
		const headers = { Authorization: `Bearer ${INTERNAL_TOKEN}` }
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const response = await app.request('/api/reservations/tick', {
				method,
				headers,
			})
			expect(response.status).toBe(404)
		}
		const elsewhere = await app.request('/api/reservations/ticks', {
			method: 'POST',
			headers,
			body: '{}',
		})
		expect(elsewhere.status).toBe(404)
	})

	it('limits a caller to sixty requests a minute in production', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		// The full app also applies its own global limits, which would trip first.
		const bare = new Hono()
		bare.route('/api/reservations', reservationsTickRoutes)
		const send = (ip: string) =>
			bare.request('/api/reservations/tick', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
				body: '{}',
			})
		for (let i = 0; i < 60; i++) {
			expect((await send('203.0.113.9')).status).toBe(401)
		}
		expect((await send('203.0.113.9')).status).toBe(429)
		// Another caller is not affected.
		expect((await send('203.0.113.10')).status).toBe(401)
	})
})

describe('POST /api/reservations/tick body', () => {
	it.each([
		['a malformed org id', { orgId: '../etc/passwd' }],
		['an empty org id', { orgId: '' }],
		['an unknown key', { orgId: ORG_A, force: true }],
		['an unknown key without an org id', { force: true }],
		['a non-string org id', { orgId: 42 }],
		['a null org id', { orgId: null }],
		['an array org id', { orgId: [ORG_A] }],
		['an array body', [ORG_A]],
		['a string body', 'everyone'],
	])('rejects %s', async (_label, body) => {
		const response = await post(body)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: 'validation_error' })
	})

	it('runs nothing for a rejected body', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		await seedOverdueWork(ORG_A)
		await post({ orgId: ORG_A, force: true })
		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(rsvHolds))[0]!.status).toBe('active')
	})
})

describe('POST /api/reservations/tick for one organization', () => {
	it('runs the organization and answers counts only', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		await seedOverdueWork(ORG_A)
		const response = await post({ orgId: ORG_A })
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		const body = await response.json()
		expect(body.success).toBe(true)
		expect(body.result).toMatchObject({
			orgId: ORG_A,
			status: 'ran',
			needsFollowUp: false,
			nextDueAt: null,
		})
		const task = (name: string) =>
			body.result.tasks.find((t: { name: string }) => t.name === name)
		expect(task('expire_holds')).toMatchObject({ status: 'ok', count: 1 })
		expect(task('auto_no_show')).toMatchObject({ status: 'ok', count: 1 })

		const raw = JSON.stringify(body)
		for (const secret of [
			'Rana',
			'Khalid',
			'rana.khalid@example.com',
			'+14155550199',
			'guest_route_tick',
			'res_route_tick',
			'ROUTETICK1',
			'hold_route_tick',
		]) {
			expect(raw).not.toContain(secret)
		}

		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(rsvHolds))[0]!.status).toBe('expired')
		const reservation = await db.select().from(rsvReservations)
		expect(reservation[0]!.status).toBe('no_show')
	})

	it('reports the follow-up the Durable Object alarm arms from', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		const db = await getTenantDb(ORG_A)
		const startAt = Date.now() + 3 * 24 * HOUR
		const expiresAt = Date.now() + 10 * MINUTE
		await db.insert(rsvHolds).values({
			locationId: PUBLIC_LOC,
			tokenHash: 'route-tick-live-hold',
			businessDate: new Date(startAt).toISOString().slice(0, 10),
			localStartMin: 19 * 60,
			startAt,
			endAt: startAt + 90 * MINUTE,
			partySize: 2,
			status: 'active',
			expiresAt,
		})
		const body = await (await post({ orgId: ORG_A })).json()
		expect(body.result).toMatchObject({
			needsFollowUp: true,
			nextDueAt: expiresAt,
		})
	})

	it('does nothing but retention for an organization whose module is off', async () => {
		contexts.set(ORG_A, contextFor(ORG_A, { enabled: false }))
		await seedOverdueWork(ORG_A)
		const body = await (await post({ orgId: ORG_A })).json()
		expect(body.success).toBe(true)
		expect(body.result).toMatchObject({
			status: 'skipped',
			reason: 'reservations_disabled',
		})
		expect(body.result.tasks.map((t: { name: string }) => t.name)).toEqual([
			'purge',
		])
		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(rsvHolds))[0]!.status).toBe('active')
		expect((await db.select().from(rsvReservations))[0]!.status).toBe('booked')
	})

	it('does nothing for an organization whose flags are unknown', async () => {
		await seedOverdueWork(ORG_A)
		const body = await (await post({ orgId: ORG_A })).json()
		expect(body.result).toMatchObject({
			status: 'skipped',
			reason: 'flags_unknown',
		})
		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(rsvReservations))[0]!.status).toBe('booked')
	})

	it('does nothing for an organization of another region', async () => {
		contexts.set(ORG_A, contextFor(ORG_A, { dataRegion: 'ksa' }))
		await seedOverdueWork(ORG_A)
		const body = await (await post({ orgId: ORG_A })).json()
		expect(body.result).toMatchObject({
			status: 'skipped',
			reason: 'region_mismatch',
		})
		const db = await getTenantDb(ORG_A)
		expect((await db.select().from(rsvHolds))[0]!.status).toBe('active')
	})

	it('reports an organization this node has no database for', async () => {
		contexts.set(ORG_NO_DB, contextFor(ORG_NO_DB))
		const response = await post({ orgId: ORG_NO_DB })
		expect(response.status).toBe(200)
		expect((await response.json()).result).toMatchObject({
			status: 'skipped',
			reason: 'no_database',
		})
	})

	it('reports an organization with nothing set up as skipped', async () => {
		contexts.set(ORG_B, contextFor(ORG_B))
		const body = await (await post({ orgId: ORG_B })).json()
		expect(body.result).toMatchObject({
			status: 'skipped',
			reason: 'no_reservations',
		})
	})

	it('answers a generic 500 when the pass itself throws, without the cause', async () => {
		contexts.set(ORG_A, 'throw')
		const response = await post({ orgId: ORG_A })
		expect(response.status).toBe(500)
		const raw = await response.text()
		expect(raw).not.toContain('control plane exploded')
	})
})

describe('POST /api/reservations/tick for every organization', () => {
	it('fans out over the node and folds the answers into counts', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		contexts.set(ORG_B, contextFor(ORG_B))
		await seedOverdueWork(ORG_A)
		const response = await post({})
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
		const body = await response.json()
		expect(body).toMatchObject({
			success: true,
			orgsRan: 1,
			orgsSkipped: 1,
			orgsDeferred: 0,
			holdsExpired: 1,
			requestsExpired: 0,
			noShowsMarked: 1,
			messagesSent: 0,
			alertsDelivered: 0,
			errors: 0,
		})
		expect(Object.keys(body).sort()).toEqual(
			[
				'alertsDelivered',
				'errors',
				'holdsExpired',
				'messagesSent',
				'noShowsMarked',
				'orgsDeferred',
				'orgsRan',
				'orgsSkipped',
				'requestsExpired',
				'success',
			].sort(),
		)
	})

	it('treats an empty or null body like "everyone"', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		await seedOverdueWork(ORG_A)
		const empty = await (await post(null, { raw: '' })).json()
		expect(empty.orgsRan).toBe(1)
		const db = await getTenantDb(ORG_A)
		await db
			.update(rsvReservations)
			.set({ status: 'booked' })
			.where(eq(rsvReservations.id, 'res_route_tick'))
		const nullBody = await (await post(null)).json()
		expect(nullBody.orgsRan).toBe(1)
		expect(nullBody.noShowsMarked).toBe(1)
	})

	it('counts an organization whose pass throws as an error and keeps going', async () => {
		contexts.set(ORG_A, contextFor(ORG_A))
		contexts.set(ORG_B, 'throw')
		await seedOverdueWork(ORG_A)
		await getTenantDb(ORG_B).then((db) =>
			db.insert(rsvLocationSettings).values({
				locationId: 'loc_b',
				enabled: true,
				timeZone: 'UTC',
			}),
		)
		const response = await post({})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body).toMatchObject({
			success: false,
			orgsRan: 1,
			errors: 1,
			noShowsMarked: 1,
		})
		expect(JSON.stringify(body)).not.toContain('control plane exploded')
	})

	it('skips organizations that are switched off or unknown without failing', async () => {
		contexts.set(ORG_A, contextFor(ORG_A, { enabled: false }))
		await seedOverdueWork(ORG_A)
		const body = await (await post({})).json()
		expect(body).toMatchObject({
			success: true,
			orgsRan: 0,
			orgsSkipped: 2,
			errors: 0,
		})
	})
})
