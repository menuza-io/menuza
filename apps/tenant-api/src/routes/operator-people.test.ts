import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvLocationSettings,
	rsvReservations,
	rsvTags,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { operatorPeopleRoutes } from './operator-people.ts'

const SECRET = 'test-operator-secret-key-for-people-routes-32chars!!'
const ORG = 'org_people_a'
const ORG_B = 'org_people_b'
const LOC = 'loc_people'
const DAY = 86_400_000

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

let tempDir: string
const app = new Hono()
app.route('/operator/people', operatorPeopleRoutes)

type Claims = Record<string, unknown>
const FULL: Claims = {
	scope: 'people',
	peopleCustomers: true,
	peopleDining: 'full',
	canUpdate: true,
	canUpdateGuest: true,
}
const HOST: Claims = { scope: 'people', peopleDining: 'flags' }
const CUSTOMERS_ONLY: Claims = {
	scope: 'people',
	peopleCustomers: true,
	canUpdate: true,
}

async function token(claims: Claims = FULL, orgId = ORG, extra?: Claims) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, ...claims, ...extra })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

async function call(
	pathname: string,
	jwt: string | null,
	init: { method?: string; body?: unknown } = {},
) {
	return app.request(`/operator/people${pathname}`, {
		method: init.method ?? 'GET',
		headers: {
			...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
			...(init.body !== undefined
				? { 'Content-Type': 'application/json' }
				: {}),
		},
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
	})
}

type ListBody = {
	people: Array<{
		key: string
		name: string
		status: string
		walkIn: boolean
		hasDining: boolean
		customerLinked: boolean
		orders: { count: number } | null
		flags: { vip: boolean; allergy: boolean | null; noShowRisk: boolean }
		dining: { visits: number; nextBookingAt: number | null } | null
	}>
	nextCursor: string | null
	total: number
	meta: { hasOrders: boolean; walkInCount: number | null }
}

async function list(query: string, claims: Claims = FULL) {
	const res = await call(query, await token(claims))
	return { res, body: (await res.json()) as ListBody }
}

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-people-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = SECRET
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as PublishedOrganization)
		await provisionTenantDb(id)
	}
	const db = await getTenantDb(ORG)
	await db.insert(rsvLocationSettings).values({
		locationId: LOC,
		timeZone: 'UTC',
		enabled: true,
		version: 1,
	})
	const now = Date.now()
	await db.insert(customers).values([
		{
			id: 'cus_v',
			name: 'Vera Signed',
			phone: '+14155550101',
			phoneVerified: true,
			email: 'vera@example.com',
		},
		{ id: 'cus_u', name: 'Una Unverified', phone: '+14155550109' },
		{ id: 'cus_shadow', name: 'Shae Booker', phone: '+14155550103' },
	])
	await db.insert(customerSubscriptions).values({
		customerId: 'cus_v',
		topic: 'reservations',
		channel: 'email',
		source: 'reservation_booking',
		subscribedAt: new Date(),
	})
	await db.insert(rsvGuests).values([
		{
			id: 'gst_linked',
			customerId: 'cus_v',
			firstName: 'Vera',
			lastName: 'Signed',
			phoneE164: '+14155550101',
			allergyNotes: 'severe peanut allergy',
			visits: 3,
			covers: 8,
			lastVisitAt: now - 5 * DAY,
		},
		{
			id: 'gst_only',
			firstName: 'Gus',
			lastName: 'Guest',
			phoneE164: '+14155550102',
			visits: 1,
			noShows: 2,
			lastVisitAt: now - 200 * DAY,
		},
		{ id: 'gst_walk', firstName: 'Walk-in', lastName: 'Guest' },
		{
			id: 'gst_shadow',
			marketingCustomerId: 'cus_shadow',
			firstName: 'Shae',
			lastName: 'Booker',
			phoneE164: '+14155550103',
		},
	])
	await db.insert(rsvTags).values({
		id: 'tag_vip',
		scope: 'guest',
		category: 'vip',
		name: 'VIP',
	})
	await db
		.insert(rsvGuestTags)
		.values({ guestId: 'gst_linked', tagId: 'tag_vip' })
	await db.insert(rsvGuestNotes).values({
		id: 'note_1',
		guestId: 'gst_linked',
		body: 'Prefers the corner booth, wife is gluten free',
		pinned: true,
		authorId: 'usr_1',
		createdAt: now,
	})
	await db.insert(rsvReservations).values({
		id: 'res_up',
		confirmationCode: 'UP1',
		locationId: LOC,
		guestId: 'gst_only',
		businessDate: '2099-01-01',
		localStartMin: 1140,
		timeZone: 'UTC',
		startAt: now + 3 * DAY,
		endAt: now + 3 * DAY + 90 * 60_000,
		durationMin: 90,
		partySize: 2,
		channel: 'online',
		status: 'confirmed',
		guestRequests: 'a window table please',
	})
	await db.insert(restaurantOrders).values({
		id: 'ord_1',
		orgId: ORG,
		number: 'A-1',
		customerId: 'cus_v',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'pickup',
		locationId: LOC,
		locationName: 'Downtown',
		contactName: 'Vera Signed',
		contactPhone: '+14155550101',
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [],
		idempotencyKey: 'idem_1',
		requestHash: 'hash_1',
		receiptTokenHash: 'rcpt_1',
	} as typeof restaurantOrders.$inferInsert)
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id)
	rmSync(tempDir, { recursive: true, force: true })
})

describe('GET /operator/people', () => {
	it('lists one row per person: customer with its dining facet, guest-only, no shadow, no walk-in', async () => {
		const { res, body } = await list('')
		expect(res.status).toBe(200)
		const keys = body.people.map((p) => p.key).sort()
		expect(keys).toEqual(
			['c_cus_u', 'c_cus_v', 'g_gst_only', 'g_gst_shadow'].sort(),
		)
		const vera = body.people.find((p) => p.key === 'c_cus_v')!
		expect(vera).toMatchObject({
			status: 'signed_in',
			hasDining: true,
			customerLinked: true,
			flags: { vip: true, allergy: true },
			orders: { count: 1 },
		})
		expect(vera.dining!.visits).toBe(3)
		const gus = body.people.find((p) => p.key === 'g_gst_only')!
		expect(gus).toMatchObject({
			status: 'guest_no_sign_in',
			orders: null,
			flags: { noShowRisk: true },
		})
		expect(gus.dining!.nextBookingAt).not.toBeNull()
		expect(body.people.find((p) => p.key === 'c_cus_u')!.status).toBe(
			'unverified',
		)
		expect(body.total).toBe(4)
		expect(body.meta).toEqual({ hasOrders: true, walkInCount: 1 })
	})

	it('hides walk-ins without contact unless asked', async () => {
		const { body } = await list('?includeWalkIns=1')
		expect(body.people.map((p) => p.key)).toContain('g_gst_walk')
		expect(body.people.find((p) => p.key === 'g_gst_walk')!.walkIn).toBe(true)
	})

	it('filters server-side', async () => {
		const keys = async (q: string) =>
			(await list(q)).body.people.map((p) => p.key).sort()
		expect(await keys('?vip=1')).toEqual(['c_cus_v'])
		expect(await keys('?allergy=1')).toEqual(['c_cus_v'])
		expect(await keys('?lapsed=1')).toEqual(['g_gst_only'])
		expect(await keys('?upcoming=1')).toEqual(['g_gst_only'])
		expect(await keys('?noShowRisk=1')).toEqual(['g_gst_only'])
		expect(await keys('?account=signed_in')).toEqual(['c_cus_v'])
		expect(await keys('?account=guest_only')).toEqual([
			'g_gst_only',
			'g_gst_shadow',
		])
		expect(await keys('?hasDining=1')).toEqual([
			'c_cus_v',
			'g_gst_only',
			'g_gst_shadow',
		])
	})

	it('searches by name, phone and email on the server', async () => {
		const keys = async (q: string) =>
			(await list(`?q=${encodeURIComponent(q)}`)).body.people.map((p) => p.key)
		expect(await keys('gus')).toEqual(['g_gst_only'])
		expect(await keys('555-0102')).toEqual(['g_gst_only'])
		expect(await keys('vera@example')).toEqual(['c_cus_v'])
		expect(await keys('zzz')).toEqual([])
	})

	it('pages with a stable keyset cursor in every sort', async () => {
		for (const sort of ['recent', 'name', 'visits', 'last_visit']) {
			const seen: string[] = []
			let cursor: string | null = null
			for (let i = 0; i < 6; i++) {
				const { body }: { body: ListBody } = await list(
					`?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
				)
				seen.push(...body.people.map((p) => p.key))
				cursor = body.nextCursor
				if (!cursor) break
			}
			expect(new Set(seen).size).toBe(4)
			expect(seen).toHaveLength(4)
		}
		expect((await call('?cursor=%%%', await token())).status).toBe(400)
	})

	it('pages past 100 people', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(customers).values(
			Array.from({ length: 120 }, (_, i) => ({
				id: `cus_bulk_${i}`,
				name: `Bulk ${String(i).padStart(3, '0')}`,
				phone: `+1415556${String(i).padStart(4, '0')}`,
			})),
		)
		const seen = new Set<string>()
		let cursor: string | null = null
		let total = 0
		do {
			const { body }: { body: ListBody } = await list(
				`?sort=name${cursor ? `&cursor=${cursor}` : ''}`,
			)
			total = body.total
			for (const p of body.people) seen.add(p.key)
			cursor = body.nextCursor
		} while (cursor)
		expect(total).toBe(124)
		expect(seen.size).toBe(124)
	})

	it('a guest-grant-only token sees guests (no orders, no customer ids), a customers-only token sees no dining', async () => {
		const guestOnly = await list('', {
			scope: 'people',
			peopleDining: 'full',
		})
		expect(guestOnly.res.status).toBe(200)
		const keys = guestOnly.body.people.map((p) => p.key).sort()
		expect(keys).toEqual(['g_gst_linked', 'g_gst_only', 'g_gst_shadow'])
		expect(guestOnly.body.people.every((p) => p.orders === null)).toBe(true)
		expect(
			guestOnly.body.people.find((p) => p.key === 'g_gst_linked')!.status,
		).toBe('signed_in')
		expect(guestOnly.body.meta.hasOrders).toBe(false)

		const custOnly = await list('', CUSTOMERS_ONLY)
		expect(custOnly.body.people.every((p) => p.key.startsWith('c_'))).toBe(true)
		expect(custOnly.body.people.every((p) => p.dining === null)).toBe(true)
		expect(custOnly.body.people.every((p) => p.flags.allergy === null)).toBe(
			true,
		)
		expect((await call('?vip=1', await token(CUSTOMERS_ONLY))).status).toBe(403)
	})

	it('a host token (flags only) gets no allergy flag and cannot filter by it', async () => {
		const host = await list('', HOST)
		expect(host.res.status).toBe(200)
		expect(host.body.people.every((p) => p.flags.allergy === null)).toBe(true)
		expect(JSON.stringify(host.body)).not.toContain('peanut')
		expect((await call('?allergy=1', await token(HOST))).status).toBe(403)
	})

	it('never shows data of another organization', async () => {
		const { body } = await list('', {
			...FULL,
		})
		expect(body.people.length).toBeGreaterThan(0)
		const other = await call('', await token(FULL, ORG_B))
		expect(((await other.json()) as ListBody).people).toEqual([])
	})
})

describe('GET /operator/people/:key', () => {
	it('joins the customer and dining facets with orders and consent', async () => {
		const res = await call('/c_cus_v', await token())
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			canonicalKey: 'c_cus_v',
			status: 'signed_in',
			customerLinked: true,
			customer: { id: 'cus_v', orders: { count: 1 }, phoneVerified: true },
			dining: {
				guest: { allergyNotes: 'severe peanut allergy', hasAllergy: true },
			},
		})
		expect(body.dining.notes[0].body).toContain('corner booth')
		expect(body.marketing.subscriptions[0]).toMatchObject({
			topic: 'reservations',
			channel: 'email',
			subscribed: true,
		})
	})

	it('resolves a guest key to its customer, a shadow customer to its guest, and a merged guest to the survivor', async () => {
		const linked = await (await call('/g_gst_linked', await token())).json()
		expect(linked.canonicalKey).toBe('c_cus_v')
		const shadow = await (await call('/c_cus_shadow', await token())).json()
		expect(shadow.canonicalKey).toBe('g_gst_shadow')
		const db = await getTenantDb(ORG)
		await db
			.update(rsvGuests)
			.set({ mergedIntoId: 'gst_only' })
			.where(eq(rsvGuests.id, 'gst_walk'))
		const merged = await (await call('/g_gst_walk', await token())).json()
		expect(merged.canonicalKey).toBe('g_gst_only')
	})

	it('404s an unknown or malformed key and an erased guest', async () => {
		expect((await call('/c_nope', await token())).status).toBe(404)
		expect((await call('/x_nope', await token())).status).toBe(404)
		const db = await getTenantDb(ORG)
		await db
			.update(rsvGuests)
			.set({ erasedAt: Date.now() })
			.where(eq(rsvGuests.id, 'gst_only'))
		expect((await call('/g_gst_only', await token())).status).toBe(404)
	})

	it('PRIVACY: a host token (read:reservation only) gets no free text, no allergy, no notes', async () => {
		const res = await call('/g_gst_only', await token(HOST))
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).not.toContain('window table')
		const body = JSON.parse(text)
		expect(body.dining.notes).toEqual([])
		expect(body.dining.pinnedNotes).toEqual([])
		expect(body.dining.guest.allergyNotes).toBeNull()
		expect(body.dining.guest.hasAllergy).toBeNull()
		expect(body.marketing).toBeNull()
		expect(body.customer).toBeNull()

		const linked = await call('/g_gst_linked', await token(HOST))
		const linkedText = await linked.text()
		expect(linkedText).not.toContain('peanut')
		expect(linkedText).not.toContain('corner booth')
		const body2 = JSON.parse(linkedText)
		expect(body2.canonicalKey).toBe('g_gst_linked')
		// Sensitive tags and the consent facet need the full grant too.
		expect(body2.marketing).toBeNull()
	})

	it('a customers-only token gets no dining facet and cannot read a guest key', async () => {
		const res = await call('/c_cus_v', await token(CUSTOMERS_ONLY))
		const body = await res.json()
		expect(body.dining).toBeNull()
		expect(body.customer.id).toBe('cus_v')
		expect(
			(await call('/g_gst_only', await token(CUSTOMERS_ONLY))).status,
		).toBe(403)
	})

	it('a guest-only token cannot read a customer key', async () => {
		const jwt = await token({ scope: 'people', peopleDining: 'full' })
		expect((await call('/c_cus_v', jwt)).status).toBe(403)
	})
})

describe('PATCH /operator/people/:key', () => {
	it('edits a customer and keeps the dining facet in step', async () => {
		const res = await call('/c_cus_v', await token(), {
			method: 'PATCH',
			body: { name: 'Vera Renamed', email: 'new@example.com' },
		})
		expect(res.status).toBe(200)
		const db = await getTenantDb(ORG)
		const c = await db
			.select()
			.from(customers)
			.where(eq(customers.id, 'cus_v'))
			.get()
		expect(c).toMatchObject({ name: 'Vera Renamed', email: 'new@example.com' })
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_linked'))
			.get()
		expect(g).toMatchObject({
			firstName: 'Vera',
			lastName: 'Renamed',
			emailNorm: 'new@example.com',
		})
	})

	it('refuses a phone change on a customer and an edit without the update claim', async () => {
		const phone = await call('/c_cus_v', await token(), {
			method: 'PATCH',
			body: { phone: '+14155550999' },
		})
		expect(phone.status).toBe(400)
		const denied = await call(
			'/c_cus_v',
			await token({ scope: 'people', peopleCustomers: true }),
			{ method: 'PATCH', body: { name: 'Nope' } },
		)
		expect(denied.status).toBe(403)
	})

	it('edits a guest-only person with the version, and allergy only with the full grant', async () => {
		const stale = await call('/g_gst_only', await token(), {
			method: 'PATCH',
			body: { name: 'Gus Renamed', expectedVersion: 99 },
		})
		expect(stale.status).toBe(409)
		const ok = await call('/g_gst_only', await token(), {
			method: 'PATCH',
			body: {
				name: 'Gus Renamed',
				allergyNotes: 'shellfish',
				expectedVersion: 1,
			},
		})
		expect(ok.status).toBe(200)
		expect((await ok.json()).dining.guest).toMatchObject({
			firstName: 'Gus',
			lastName: 'Renamed',
			allergyNotes: 'shellfish',
		})
		const host = await call('/g_gst_only', await token(HOST), {
			method: 'PATCH',
			body: { allergyNotes: 'x', expectedVersion: 2 },
		})
		expect(host.status).toBe(403)
	})
})

describe('merge, tags, notes', () => {
	it('merges guest facets and answers 409 merge_conflicting_customers for two customers', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(customers).values({
			id: 'cus_v2',
			name: 'Second',
			phone: '+14155550777',
			phoneVerified: true,
		})
		await db.insert(rsvGuests).values({
			id: 'gst_linked2',
			customerId: 'cus_v2',
			firstName: 'Second',
			lastName: 'Signed',
			phoneE164: '+14155550777',
		})
		const conflict = await call('/merge', await token(), {
			method: 'POST',
			body: { keepKey: 'c_cus_v', mergeKey: 'c_cus_v2' },
		})
		expect(conflict.status).toBe(409)
		expect((await conflict.json()).error).toBe('merge_conflicting_customers')

		const merged = await call('/merge', await token(), {
			method: 'POST',
			body: { keepKey: 'c_cus_v', mergeKey: 'g_gst_only' },
		})
		expect(merged.status).toBe(200)
		expect(await merged.json()).toMatchObject({ key: 'c_cus_v' })
		const host = await call('/merge', await token(HOST), {
			method: 'POST',
			body: { keepKey: 'g_gst_walk', mergeKey: 'g_gst_shadow' },
		})
		expect(host.status).toBe(403)
	})

	it('manages tags and notes through the person key, behind the write grant', async () => {
		const jwt = await token()
		const created = await call('/tags', jwt, {
			method: 'POST',
			body: { name: 'Regular' },
		})
		expect(created.status).toBe(201)
		const tagId = (await created.json()).tag.id as string
		const assigned = await call('/c_cus_v/tags', jwt, {
			method: 'POST',
			body: { tagId },
		})
		expect(assigned.status).toBe(200)
		const note = await call('/g_gst_only/notes', jwt, {
			method: 'POST',
			body: { body: 'Likes quiet tables' },
		})
		expect(note.status).toBe(201)
		const noGuest = await call('/c_cus_u/notes', jwt, {
			method: 'POST',
			body: { body: 'x' },
		})
		expect(noGuest.status).toBe(409)
		const readOnly = await token({ ...FULL, canUpdateGuest: false })
		expect(
			(
				await call('/g_gst_only/notes', readOnly, {
					method: 'POST',
					body: { body: 'x' },
				})
			).status,
		).toBe(403)
		const hostTags = (await (await call('/tags', await token(HOST))).json())
			.tags
		expect(hostTags.every((t: { sensitive: boolean }) => !t.sensitive)).toBe(
			true,
		)
	})
})

describe('POST /operator/people/:key/erase', () => {
	it('needs canDelete, then erases the customer, its guest and consent in one flow', async () => {
		expect(
			(await call('/c_cus_v/erase', await token(), { method: 'POST' })).status,
		).toBe(403)
		const jwt = await token(FULL, ORG, { canDelete: true })
		const res = await call('/c_cus_v/erase', jwt, { method: 'POST' })
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			customersErased: 1,
			guestsErased: 1,
		})
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customerSubscriptions)).toHaveLength(0)
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_linked'))
			.get()
		expect(g!.erasedAt).not.toBeNull()
		expect((await call('/c_cus_v', jwt)).status).toBe(404)
		expect((await call('/c_cus_v/erase', jwt, { method: 'POST' })).status).toBe(
			404,
		)
	})

	it('erases a guest-only person', async () => {
		const jwt = await token(FULL, ORG, { canDelete: true })
		const res = await call('/g_gst_only/erase', jwt, { method: 'POST' })
		expect(res.status).toBe(200)
		const db = await getTenantDb(ORG)
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_only'))
			.get()
		expect(g!.erasedAt).not.toBeNull()
		expect(g!.phoneE164).toBeNull()
	})

	it('cannot erase across organizations', async () => {
		const jwt = await token(FULL, ORG_B, { canDelete: true })
		const res = await call('/c_cus_v/erase', jwt, { method: 'POST' })
		expect(res.status).toBe(404)
		const db = await getTenantDb(ORG)
		expect(
			await db.select().from(customers).where(eq(customers.id, 'cus_v')),
		).toHaveLength(1)
	})
})

describe('security sweep: every people route', () => {
	const routes = operatorPeopleRoutes.routes
		.filter((r) => r.method !== 'ALL')
		.map((r) => ({
			method: r.method,
			path: r.path
				.replace(/:key/g, 'c_cus_v')
				.replace(/:\w+/g, 'x')
				.replace(/^\/$/, ''),
		}))

	it('covers the whole surface', () => {
		expect(routes.length).toBeGreaterThanOrEqual(13)
	})

	it.each(routes)(
		'$method $path refuses missing, forged, wrong-scope and claimless tokens',
		async ({ method, path: p }) => {
			const init = {
				method,
				body: method === 'GET' ? undefined : {},
			}
			expect((await call(p, null, init)).status).toBe(401)
			expect((await call(p, 'not.a.jwt', init)).status).toBe(401)
			// Same secret, but the customers token (no scope) or another scope.
			expect((await call(p, await token({}), init)).status).toBe(401)
			expect(
				(await call(p, await token({ scope: 'mailbox' }), init)).status,
			).toBe(401)
			// Right scope, no facet claim at all.
			expect(
				(await call(p, await token({ scope: 'people' }), init)).status,
			).toBe(403)
			// Signed with another secret.
			const now = Math.floor(Date.now() / 1000)
			const forged = await new jose.SignJWT({
				role: 'operator',
				orgId: ORG,
				...FULL,
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setIssuer(brand.shortName)
				.setAudience('tenant-api-operator')
				.setExpirationTime(now + 300)
				.sign(
					new TextEncoder().encode('another-secret-another-secret-0123456789'),
				)
			expect((await call(p, forged, init)).status).toBe(401)
		},
	)
})
