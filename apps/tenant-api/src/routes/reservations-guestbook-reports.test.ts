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
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAuditLog,
	rsvGuestMerges,
	rsvGuests,
	rsvLocationSettings,
	rsvReservationEvents,
	rsvReservations,
	rsvServices,
	rsvWaitlistEntries,
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
import { reservationsInternalRoutes } from './reservations-internal.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'
import { publicContext } from './reservations-public-fixture.ts'

const OPERATOR_SECRET =
	'test-reservations-operator-secret-key-32-chars-minimum!!'
const INTERNAL_SECRET =
	'test-reservations-internal-secret-key-32-chars-minimum!!'
const ORG_ID = 'org_guestbook_reports'
const LOC = 'loc_gb'
const OTHER_LOC = 'loc_gb_other'
const D = '2031-03-10'
const PROBE = 'Reportprobe Zed'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string
const app = new Hono()
app.route('/operator/reservations', reservationsOperatorRoutes)
app.route('/internal/reservations', reservationsInternalRoutes)

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

describe('Guestbook and Bookings today', () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-gb-reports-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
		process.env.INTERNAL_COMMAND_TOKEN = INTERNAL_SECRET
		resetReservationsContextCache()
		seq = 0
		orgs.set(ORG_ID, {
			id: ORG_ID,
			slug: 'acme-gb',
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

	describe('Guestbook', () => {
		it('refuses tokens without the guest grant or the guests scope', async () => {
			const bookToken = await mint({
				scope: 'book',
				grants: [P.READ_RESERVATION],
			})
			expect((await api('GET', guestsUrl(), bookToken)).status).toBe(403)
			const readOnly = await mint({
				scope: 'guests',
				grants: [P.READ_RESERVATION_GUEST],
			})
			expect((await api('GET', guestsUrl(), readOnly)).status).toBe(200)
			for (const [method, url, body] of [
				['POST', guestsUrl('/tags'), { name: 'VIP' }],
				['POST', guestsUrl('/merge'), { keepId: 'a', mergeId: 'b' }],
				['POST', guestsUrl('/g/notes'), { body: 'x' }],
			] as const) {
				expect((await api(method, url, readOnly, body)).status, url).toBe(403)
			}
		})

		it('searches partially by name, phone and email, and pages at most 50 at a time', async () => {
			await insertGuest({
				firstName: 'Amira',
				lastName: 'Haddad',
				phoneE164: '+14155550101',
				emailNorm: 'amira.haddad@example.com',
			})
			for (let i = 0; i < 55; i += 1) {
				await insertGuest({ firstName: 'Bulk', lastName: `Guest${i}` })
			}
			const token = await guestsToken()
			for (const q of ['mira', 'Hadd', '55501', 'haddad@exa', 'amira.had']) {
				const res = await api('GET', guestsUrl(`?q=${q}`), token)
				expect(
					res.body.guests.map((g: any) => g.firstName),
					q,
				).toEqual(['Amira'])
			}
			const page1 = await api('GET', guestsUrl('?q=Bulk&limit=100'), token)
			expect(page1.body.guests).toHaveLength(50)
			expect(page1.body.nextCursor).toBeTruthy()
			const page2 = await api(
				'GET',
				guestsUrl(
					`?q=Bulk&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
				),
				token,
			)
			expect(page2.body.guests).toHaveLength(5)
			expect(page2.body.nextCursor ?? null).toBeNull()
			const ids = new Set(
				[...page1.body.guests, ...page2.body.guests].map((g: any) => g.id),
			)
			expect(ids.size).toBe(55)
		})

		it('carries nextBookingAt on every list row, null without an upcoming booking', async () => {
			await insertGuest({ firstName: 'Nora', lastName: 'Quiet' })
			const res = await api('GET', guestsUrl('?q=Nora'), await guestsToken())
			expect(res.body.guests).toHaveLength(1)
			expect(res.body.guests[0].nextBookingAt).toBeNull()
		})

		it('creates, assigns, filters by and archives custom tags, and derives system tags', async () => {
			const fresh = await insertGuest({ firstName: 'Fresh' })
			const regular = await insertGuest({ firstName: 'Regular', visits: 4 })
			const flaky = await insertGuest({
				firstName: 'Flaky',
				visits: 3,
				noShows: 2,
			})
			const token = await guestsToken()

			const created = await api('POST', guestsUrl('/tags'), token, {
				name: 'Wine club',
			})
			expect(created.status).toBe(201)
			const tagId = created.body.tag.id as string
			expect(
				(await api('POST', guestsUrl('/tags'), token, { name: 'Wine club' }))
					.status,
			).toBe(409)

			expect(
				(await api('POST', guestsUrl(`/${regular}/tags`), token, { tagId }))
					.status,
			).toBe(200)
			const filtered = await api('GET', guestsUrl(`?tag=${tagId}`), token)
			expect(filtered.body.guests.map((g: any) => g.firstName)).toEqual([
				'Regular',
			])

			const all = await api('GET', guestsUrl('?limit=50'), token)
			const byName = Object.fromEntries(
				all.body.guests.map((g: any) => [g.firstName, g]),
			)
			const keys = (name: string) =>
				byName[name].tags.map((t: any) => t.systemKey).filter(Boolean)
			expect(keys('Fresh')).toEqual(['first_visit'])
			expect(keys('Regular')).toEqual([])
			expect(keys('Flaky')).toEqual(['frequent_no_show'])

			const system = await api('GET', guestsUrl('/tags'), token)
			const firstVisit = system.body.tags.find(
				(t: any) => t.systemKey === 'first_visit',
			)
			const sysFiltered = await api(
				'GET',
				guestsUrl(`?tag=${firstVisit.id}`),
				token,
			)
			expect(sysFiltered.body.guests.map((g: any) => g.id)).toEqual([fresh])
			expect(
				(
					await api('POST', guestsUrl(`/${flaky}/tags`), token, {
						tagId: firstVisit.id,
					})
				).status,
			).toBe(400)

			expect(
				(await api('DELETE', guestsUrl(`/${regular}/tags/${tagId}`), token))
					.status,
			).toBe(200)
			const none = await api('GET', guestsUrl(`?tag=${tagId}`), token)
			expect(none.body.guests).toEqual([])
		})

		it('pins, edits and deletes notes; deleted notes disappear from profile and summary', async () => {
			const id = await insertGuest({ firstName: 'Noted' })
			const token = await guestsToken()
			const a = await api('POST', guestsUrl(`/${id}/notes`), token, {
				body: 'Prefers booth',
				pinned: true,
			})
			const b = await api('POST', guestsUrl(`/${id}/notes`), token, {
				body: 'Left a good tip',
			})
			expect(a.status).toBe(201)
			const summary = await api('GET', guestsUrl(`/${id}/summary`), token)
			expect(summary.body.pinnedNotes.map((n: any) => n.body)).toEqual([
				'Prefers booth',
			])

			const edited = await api(
				'PATCH',
				guestsUrl(`/${id}/notes/${b.body.note.id}`),
				token,
				{ body: 'Left a great tip', pinned: true },
			)
			expect(edited.body.note.pinned).toBe(true)
			expect(edited.body.note.body).toBe('Left a great tip')

			await api('DELETE', guestsUrl(`/${id}/notes/${a.body.note.id}`), token)
			const profile = await api('GET', guestsUrl(`/${id}`), token)
			expect(profile.body.notes.map((n: any) => n.body)).toEqual([
				'Left a great tip',
			])
			const after = await api('GET', guestsUrl(`/${id}/summary`), token)
			expect(after.body.pinnedNotes.map((n: any) => n.body)).toEqual([
				'Left a great tip',
			])
		})

		it('merges duplicate guests atomically and refuses a stale version', async () => {
			const keep = await insertGuest({ firstName: 'Keep', visits: 1 })
			const dupe = await insertGuest({ firstName: 'Dupe', visits: 2 })
			const resId = await insertBooking({ guestId: dupe })
			const token = await guestsToken()

			const stale = await api('POST', guestsUrl('/merge'), token, {
				keepId: keep,
				mergeId: dupe,
				expectedVersions: { [dupe]: 99 },
			})
			expect(stale.status).toBe(409)
			expect(stale.body.error).toBe('stale_version')

			const merged = await api('POST', guestsUrl('/merge'), token, {
				keepId: keep,
				mergeId: dupe,
			})
			expect(merged.status).toBe(200)

			const db = await getTenantDb(ORG_ID)
			const reservation = await db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, resId))
				.get()
			expect(reservation!.guestId).toBe(keep)
			const old = await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, dupe))
				.get()
			expect(old!.mergedIntoId).toBe(keep)
			expect(await db.select().from(rsvGuestMerges)).toHaveLength(1)
			const events = await db
				.select()
				.from(rsvReservationEvents)
				.where(eq(rsvReservationEvents.reservationId, resId))
			expect(events.some((e) => e.type === 'merged_guest')).toBe(true)
			const again = await api('POST', guestsUrl('/merge'), token, {
				keepId: keep,
				mergeId: dupe,
			})
			expect(again.status).toBeGreaterThanOrEqual(400)
		})

		it('erase-customer performs the complete erase: customer, linked guest, subscriptions and contact', async () => {
			const db = await getTenantDb(ORG_ID)
			await db.insert(customers).values([
				{
					id: 'cus_1',
					phone: '+14155550999',
					email: 'linked@example.com',
					name: 'Linked',
					phoneVerified: true,
				},
			] as never)
			await db.insert(customerSubscriptions).values({
				customerId: 'cus_1',
				topic: 'reservations',
				channel: 'email',
				source: 'reservation_booking',
				subscribedAt: new Date(),
			})
			const id = await insertGuest({
				firstName: 'Linked',
				phoneE164: '+14155550999',
				customerId: 'cus_1',
				marketingCustomerId: 'cus_1',
				visits: 3,
			})
			const resId = await insertBooking({ guestId: id, status: 'finished' })
			const call = () =>
				app.request('/internal/reservations/erase-customer', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${INTERNAL_SECRET}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ orgId: ORG_ID, customerId: 'cus_1' }),
				})
			const res = await call()
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body).toMatchObject({
				ok: true,
				customersErased: 1,
				guestsErased: 1,
			})
			expect(JSON.stringify(body)).not.toContain('linked@example.com')
			const guest = await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, id))
				.get()
			expect(guest!.erasedAt).not.toBeNull()
			expect(guest!.customerId).toBeNull()
			expect(guest!.marketingCustomerId).toBeNull()
			expect(guest!.phoneE164).toBeNull()
			expect(await db.select().from(customers)).toHaveLength(0)
			expect(await db.select().from(customerSubscriptions)).toHaveLength(0)
			// Visit history stays (anonymized) and a re-run is a safe no-op.
			expect(
				(await db
					.select()
					.from(rsvReservations)
					.where(eq(rsvReservations.id, resId))
					.get())!.status,
			).toBe('finished')
			const again = await call()
			expect(again.status).toBe(200)
			expect(
				((await again.json()) as { alreadyErased: boolean }).alreadyErased,
			).toBe(true)
		})

		it('erase-customer refuses a missing or wrong internal token', async () => {
			const res = await app.request('/internal/reservations/erase-customer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: ORG_ID, customerId: 'cus_1' }),
			})
			expect(res.status).toBe(401)
		})

		it('merging two guests linked to different customers answers 409 merge_conflicting_customers', async () => {
			const token = await guestsToken()
			const db = await getTenantDb(ORG_ID)
			await db.insert(customers).values([
				{ id: 'cus_a', phone: '+14155550001', name: 'A', phoneVerified: true },
				{ id: 'cus_b', phone: '+14155550002', name: 'B', phoneVerified: true },
			] as never)
			const keep = await insertGuest({
				customerId: 'cus_a',
				phoneE164: '+14155550001',
			})
			const dupe = await insertGuest({
				customerId: 'cus_b',
				phoneE164: '+14155550002',
			})
			const res = await api('POST', guestsUrl('/merge'), token, {
				keepId: keep,
				mergeId: dupe,
			})
			expect(res.status).toBe(409)
			expect(JSON.stringify(res.body)).toContain('merge_conflicting_customers')
		})
	})

	describe('GET /book/today', () => {
		it('returns counts by status, covers by service, waitlist count and next arrivals with first names only', async () => {
			const db = await getTenantDb(ORG_ID)
			const today = new Date().toISOString().slice(0, 10)
			const g = await insertGuest({
				firstName: 'Dashprobe',
				lastName: 'Surname',
				phoneE164: '+14155550166',
			})
			const future = 23 * 60 + 30
			await insertBooking({
				guestId: g,
				businessDate: today,
				localStartMin: future,
				partySize: 3,
			})
			await insertBooking({
				guestId: g,
				businessDate: today,
				localStartMin: future,
				status: 'cancelled',
			})
			await db.insert(rsvWaitlistEntries).values({
				id: 'wl_today',
				locationId: LOC,
				businessDate: today,
				displayName: 'Walkin',
				partySize: 2,
			})
			const token = await mint({ scope: 'book', grants: [P.READ_RESERVATION] })
			const res = await api(
				'GET',
				`/operator/reservations/book/today?locationId=${LOC}`,
				token,
			)
			expect(res.status).toBe(200)
			expect(res.body.counts).toMatchObject({ booked: 1, cancelled: 1 })
			expect(res.body.waitlistCount).toBe(1)
			expect(res.body.coversByService).toEqual([
				expect.objectContaining({ name: 'Dinner', covers: 3 }),
			])
			expect(res.body.nextArrivals).toEqual([
				expect.objectContaining({
					time: '23:30',
					partySize: 3,
					firstName: 'Dashprobe',
					status: 'booked',
				}),
			])
			expect(res.text).not.toContain('Surname')
			expect(res.text).not.toContain('+14155550166')
		})

		it('requires the reservation read grant and a permitted location', async () => {
			const noRead = await mint({ scope: 'book', grants: [] })
			expect(
				(
					await api(
						'GET',
						`/operator/reservations/book/today?locationId=${LOC}`,
						noRead,
					)
				).status,
			).toBe(403)
			const scoped = await mint({
				scope: 'book',
				grants: [P.READ_RESERVATION],
				locationIds: [OTHER_LOC],
			})
			expect(
				(
					await api(
						'GET',
						`/operator/reservations/book/today?locationId=${LOC}`,
						scoped,
					)
				).status,
			).toBe(403)
		})
	})
})
