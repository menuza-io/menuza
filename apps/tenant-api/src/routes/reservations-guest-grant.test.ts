import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS as P,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	type ReservationsScope,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuestNotes,
	rsvIdempotencyKeys,
	rsvGuests,
	rsvLocationSettings,
	rsvReservations,
	rsvServices,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { publicContext } from './reservations-public-fixture.ts'

const OPERATOR_SECRET =
	'test-reservations-operator-secret-key-32-chars-minimum!!'
const ORG_ID = 'org_guest_grant'
const LOC = 'loc_gb'
const OTHER_LOC = 'loc_gb_other'
const D = '2031-03-10'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string
const app = new Hono()
app.route('/operator/reservations', reservationsOperatorRoutes)

async function mint(opts: {
	scope: ReservationsScope
	grants: string[]
	locationIds?: string[] | null
}) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG_ID,
		region: 'us',
		scope: opts.scope,
		grants: opts.grants,
		locationIds: opts.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: true,
			payments: true,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject('usr_gb_operator')
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

const guestsToken = () =>
	mint({
		scope: 'guests',
		grants: [P.READ_RESERVATION_GUEST, P.UPDATE_RESERVATION_GUEST],
	})

async function api(method: string, url: string, token: string, body?: unknown) {
	const res = await app.request(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	return {
		status: res.status,
		text,
		body: text ? (JSON.parse(text) as any) : null,
	}
}

const guestsUrl = (suffix = '') => `/operator/reservations/guests${suffix}`

let seq = 0
async function insertGuest(patch: Partial<typeof rsvGuests.$inferInsert> = {}) {
	seq += 1
	const db = await getTenantDb(ORG_ID)
	const id = patch.id ?? `gst_${seq}`
	await db.insert(rsvGuests).values({
		id,
		firstName: `First${seq}`,
		lastName: `Last${seq}`,
		...patch,
	})
	return id
}

async function insertBooking(
	patch: Partial<typeof rsvReservations.$inferInsert> & { guestId: string },
) {
	seq += 1
	const db = await getTenantDb(ORG_ID)
	const localStartMin = patch.localStartMin ?? 19 * 60
	const date = patch.businessDate ?? D
	const startAt = Date.parse(`${date}T00:00:00Z`) + localStartMin * 60_000
	const id = patch.id ?? `rsv_${seq}`
	await db.insert(rsvReservations).values({
		id,
		locationId: LOC,
		confirmationCode: `CODE${seq}`,
		businessDate: date,
		localStartMin,
		timeZone: 'UTC',
		startAt,
		endAt: startAt + 90 * 60_000,
		durationMin: 90,
		partySize: 2,
		status: 'booked',
		channel: 'online',
		serviceId: 'svc_dinner',
		...patch,
	})
	return id
}

const SECRETS = [
	'SECRET-PINNED',
	'SECRET-REQUEST',
	'SECRET-DIET',
	'SECRET-ALLERGY',
	'SECRET-STAFFFREE',
]

const hostToken = () =>
	mint({
		scope: 'book',
		grants: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
	})
const guestGrantToken = () =>
	mint({
		scope: 'book',
		grants: [
			P.READ_RESERVATION,
			P.UPDATE_RESERVATION,
			P.READ_RESERVATION_GUEST,
		],
	})

const book = (suffix: string) => `/operator/reservations/book${suffix}`

describe('guest free text follows the guest-data grant', () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-guest-grant-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
		resetReservationsContextCache()
		seq = 0
		orgs.set(ORG_ID, {
			id: ORG_ID,
			slug: 'acme-gg',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Acme',
		})
		await provisionTenantDb(ORG_ID)
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvLocationSettings).values({
			locationId: LOC,
			timeZone: 'UTC',
			enabled: true,
			version: 1,
		})
		await db.insert(rsvServices).values([
			{
				id: 'svc_lunch',
				locationId: LOC,
				name: 'Lunch',
				daysMask: 127,
				firstSeatingMin: 11 * 60,
				lastSeatingMin: 14 * 60,
				endMin: 15 * 60,
				sort: 0,
			},
			{
				id: 'svc_dinner',
				locationId: LOC,
				name: 'Dinner',
				daysMask: 127,
				firstSeatingMin: 17 * 60,
				lastSeatingMin: 21 * 60,
				endMin: 22 * 60,
				sort: 1,
			},
		])
		seedReservationsContextForTest(ORG_ID, {
			...publicContext(ORG_ID),
			locations: [
				{
					id: LOC,
					name: 'Acme Downtown',
					slug: 'downtown',
					timeZone: 'UTC',
					currency: 'USD',
					phone: null,
					address: null,
					storeHours: null,
					specialHours: null,
					isActive: true,
				},
			],
		})
	})

	afterEach(async () => {
		await destroyTenantDb(ORG_ID)
		rmSync(tempDir, { recursive: true, force: true })
	})

	let guestId = ''
	let reservationId = ''

	async function seedGuestData() {
		const db = await getTenantDb(ORG_ID)
		guestId = await insertGuest({
			firstName: 'Zed',
			lastName: 'Probe',
			phoneE164: '+14155550123',
			allergyNotes: 'SECRET-ALLERGY peanuts',
		})
		await db.insert(rsvGuestNotes).values({
			id: 'note_pinned',
			guestId,
			body: 'SECRET-PINNED prefers the corner',
			pinned: true,
			authorId: 'usr_x',
			createdAt: Date.now(),
		})
		reservationId = await insertBooking({
			guestId,
			guestRequests: 'SECRET-REQUEST birthday cake',
			dietaryNotes: 'SECRET-DIET no gluten',
		})
	}

	const READS = [
		() => book('/guests/lookup?q=Zed'),
		() => book(`/guests/${guestId}/summary`),
		() => book(`/day?locationId=${LOC}&date=${D}`),
		() => book(`/reservations/${reservationId}`),
	]

	it('hides pinned notes, requests, dietary and allergy text from a host without the grant, on every read endpoint', async () => {
		await seedGuestData()
		const host = await hostToken()
		const granted = await guestGrantToken()
		const urls = [
			book('/guests/lookup?q=Zed'),
			book(`/guests/${guestId}/summary`),
			book(`/day?locationId=${LOC}&date=${D}`),
			book(`/reservations/${reservationId}`),
			book(`/today?locationId=${LOC}`),
		]
		void READS
		for (const url of urls) {
			const withGrant = await api('GET', url, granted)
			const without = await api('GET', url, host)
			expect(without.status, url).toBe(200)
			for (const secret of SECRETS.slice(0, 4)) {
				expect(without.text, `${url} leaks ${secret}`).not.toContain(secret)
			}
			// The grant still sees the same text, so the guard is not vacuous.
			if (!url.includes('/today')) {
				expect(withGrant.text, url).toContain('SECRET-')
			}
		}
		// The three text kinds each appear somewhere with the grant.
		const day = await api('GET', urls[2]!, granted)
		expect(day.text).toContain('SECRET-REQUEST')
		expect(day.text).toContain('SECRET-PINNED')
		const summary = await api('GET', urls[1]!, granted)
		expect(summary.text).toContain('SECRET-ALLERGY')
	})

	it('keeps coded allergy flags for a host without the grant', async () => {
		await seedGuestData()
		const day = await api(
			'GET',
			book(`/day?locationId=${LOC}&date=${D}`),
			await hostToken(),
		)
		const row = day.body.reservations.find((r: any) => r.id === reservationId)
		expect(row.hasAllergy).toBe(true)
	})

	it('guest export without the sensitive flag carries no request text', async () => {
		await seedGuestData()
		const token = await guestsToken()
		const res = await api('GET', guestsUrl(`/${guestId}/export`), token)
		expect(res.status).toBe(200)
		expect(res.text).not.toContain('SECRET-REQUEST')
		expect(res.text).not.toContain('SECRET-DIET')
		expect(res.text).not.toContain('SECRET-ALLERGY')
	})

	describe('idempotent booking replay', () => {
		const KEY = 'idem-key-guest-grant-1'
		const payload = {
			locationId: LOC,
			date: D,
			time: '19:00',
			partySize: 2,
			serviceId: 'svc_dinner',
			guest: {
				firstName: 'Replay',
				lastName: 'Guest',
				phone: '+14155550999',
				allergyNotes: 'SECRET-ALLERGY shellfish',
			},
			dietaryNotes: 'SECRET-DIET vegan',
			guestRequests: 'SECRET-REQUEST window seat',
			overbook: true,
			overbookReason: 'test',
		}
		const create = (token: string, key = KEY, extra: object = {}) =>
			app
				.request(book('/reservations'), {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
						'Idempotency-Key': key,
					},
					body: JSON.stringify({ ...payload, ...extra }),
				})
				.then(async (res) => {
					const text = await res.text()
					return { status: res.status, text, body: JSON.parse(text) }
				})

		it('re-serializes for the current caller: no free text once the grant is gone, text again with it', async () => {
			const granted = await guestGrantToken()
			const first = await create(granted)
			expect(first.status).toBe(201)
			expect(first.text).toContain('SECRET-DIET')
			expect(first.text).toContain('SECRET-REQUEST')

			const replayHost = await create(await hostToken())
			expect(replayHost.status).toBe(201)
			expect(replayHost.body.reservation.id).toBe(first.body.reservation.id)
			for (const secret of [
				'SECRET-DIET',
				'SECRET-REQUEST',
				'SECRET-ALLERGY',
			]) {
				expect(replayHost.text, secret).not.toContain(secret)
			}

			const replayGranted = await create(granted)
			expect(replayGranted.body.reservation.id).toBe(first.body.reservation.id)
			expect(replayGranted.text).toContain('SECRET-DIET')

			// One reservation only.
			const db = await getTenantDb(ORG_ID)
			const rows = await db.select().from(rsvReservations).all()
			expect(rows).toHaveLength(1)
		})

		it('never stores the serialized reservation in the idempotency record', async () => {
			await create(await guestGrantToken())
			const db = await getTenantDb(ORG_ID)
			const records = await db.select().from(rsvIdempotencyKeys).all()
			expect(records.length).toBeGreaterThan(0)
			for (const record of records) {
				expect(record.responseJson).not.toContain('SECRET-')
			}
		})

		it('does not replay one operator key for another operator', async () => {
			const first = await create(await guestGrantToken())
			expect(first.status).toBe(201)
			const other = await mint({
				scope: 'book',
				grants: [P.READ_RESERVATION, P.UPDATE_RESERVATION],
			}).then(async (token) => {
				const claims = jose.decodeJwt(token)
				return { token, sub: claims.sub }
			})
			expect(other.sub).toBe('usr_gb_operator')
		})
	})
})
