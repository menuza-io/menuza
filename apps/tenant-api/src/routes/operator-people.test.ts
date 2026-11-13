import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { STAFF_CONSENT_TEXT_VERSION } from '@repo/common/marketing-consent'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	rsvAuditLog,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvLocationSettings,
	rsvReservations,
	rsvTags,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	countPeopleConsentAttempt,
	PEOPLE_CONSENT_LIMITS,
} from '../lib/people-consent-limits.ts'
import { checkGlobalSendCap } from '../lib/rate-limit.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	emailConsentHash,
	setCustomerSubscription,
} from '../services/marketing-audience.ts'
import { PEOPLE_STATS_JSON_LIST } from '../services/people-stats.ts'
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

vi.mock('../lib/rate-limit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/rate-limit.ts')>()
	return { ...actual, checkGlobalSendCap: vi.fn(actual.checkGlobalSendCap) }
})

const sms = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@repo/sms', () => ({ sendSms: sms.send }))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
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

type Summary = {
	guests: { total: number; change30d: number }
	returningGuests: { total: number; change30d: number; share: number }
	emailSubscribers: { total: number; change30d: number }
	textSubscribers: { total: number; change30d: number }
	locationScoped: boolean
	asOf: string
}

const LOC_B = 'loc_people_b'

async function summary(claims: Claims = FULL, orgId = ORG) {
	const res = await call('/summary', await token(claims, orgId))
	return { res, body: (await res.json()) as Summary & { error?: string } }
}

let orderSeq = 0
async function addOrder(
	customerId: string,
	opts: {
		at: number
		locationId?: string
		status?: 'accepted' | 'completed' | 'cancelled'
		paymentMethod?: 'handoff' | 'online'
		paymentStatus?: 'unpaid' | 'pending' | 'paid'
	},
) {
	orderSeq += 1
	const db = await getTenantDb(ORG)
	await db.insert(restaurantOrders).values({
		id: `ord_s_${orderSeq}`,
		orgId: ORG,
		number: `S-${orderSeq}`,
		customerId,
		status: opts.status ?? 'completed',
		paymentMethod: opts.paymentMethod ?? 'handoff',
		paymentStatus: opts.paymentStatus ?? 'unpaid',
		fulfillment: 'pickup',
		locationId: opts.locationId ?? LOC,
		locationName: 'Downtown',
		contactName: 'x',
		contactPhone: '+14155550000',
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 0,
		totalCents: 1000,
		lines: [],
		idempotencyKey: `idem_s_${orderSeq}`,
		requestHash: `hash_s_${orderSeq}`,
		receiptTokenHash: `rcpt_s_${orderSeq}`,
		createdAt: new Date(opts.at),
	} as typeof restaurantOrders.$inferInsert)
}

let visitSeq = 0
async function addVisit(
	guestId: string,
	opts: { at: number; locationId?: string; status?: 'finished' | 'cancelled' },
) {
	visitSeq += 1
	const db = await getTenantDb(ORG)
	await db.insert(rsvReservations).values({
		id: `res_s_${visitSeq}`,
		confirmationCode: `S${visitSeq}`,
		locationId: opts.locationId ?? LOC,
		guestId,
		businessDate: '2026-01-01',
		localStartMin: 1140,
		timeZone: 'UTC',
		startAt: opts.at - 90 * 60_000,
		endAt: opts.at,
		durationMin: 90,
		partySize: 2,
		channel: 'online',
		status: opts.status ?? 'finished',
		finishedAt: opts.at,
	} as typeof rsvReservations.$inferInsert)
}

describe('GET /operator/people/summary', () => {
	const now = Date.now()
	const ago = (days: number) => now - days * DAY

	beforeEach(async () => {
		process.env.AUTH_HMAC_SECRET = 'people-summary-test-hmac-secret-0123456789'
		const db = await getTenantDb(ORG)
		await db
			.update(customers)
			.set({ createdAt: new Date(ago(60)) })
			.where(eq(customers.id, 'cus_u'))
		await db.insert(customers).values([
			{
				id: 'cus_changed',
				name: 'Cam Changed',
				phone: '+14155550201',
				phoneVerified: true,
				email: 'new@example.com',
				createdAt: new Date(ago(60)),
			},
			{
				id: 'cus_lost',
				name: 'Lou Left',
				phone: '+14155550202',
				phoneVerified: true,
				email: 'lou@example.com',
				createdAt: new Date(ago(60)),
			},
		])
		const sub = (
			customerId: string,
			channel: 'email' | 'sms',
			subscribedDaysAgo: number,
			extra: Partial<typeof customerSubscriptions.$inferInsert> = {},
		) => ({
			customerId,
			topic: 'marketing' as const,
			channel,
			source: 'website' as const,
			subscribedAt: new Date(ago(subscribedDaysAgo)),
			...extra,
		})
		await db.insert(customerSubscriptions).values([
			// Vera: text gained in the window, email confirmed long ago.
			sub('cus_v', 'sms', 1),
			sub('cus_v', 'email', 60, {
				confirmedEmailHash: emailConsentHash('vera@example.com'),
			}),
			// Una: unverified phone, email still pending (no confirmation).
			sub('cus_u', 'sms', 1),
			sub('cus_u', 'email', 1),
			// Cam: confirmed an address he no longer has; text still valid.
			sub('cus_changed', 'email', 60, {
				confirmedEmailHash: emailConsentHash('old@example.com'),
			}),
			sub('cus_changed', 'sms', 60),
			// Lou: subscribed long ago, left inside the window on both channels.
			sub('cus_lost', 'sms', 90, { unsubscribedAt: new Date(ago(10)) }),
			sub('cus_lost', 'email', 90, {
				confirmedEmailHash: emailConsentHash('lou@example.com'),
				unsubscribedAt: new Date(ago(5)),
			}),
		])
		// Vera: ord_1 (counted, today) + a visit 40 days ago: returning, but
		// only since the order, so she is new to the group this month.
		await addVisit('gst_linked', { at: ago(40) })
		// Gus: two visits before the window: returning both now and then.
		await addVisit('gst_only', { at: ago(50) })
		await addVisit('gst_only', { at: ago(45) })
		// Una: cancelled and unpaid online orders and a cancelled visit never count.
		await addOrder('cus_u', { at: ago(3), status: 'cancelled' })
		await addOrder('cus_u', {
			at: ago(2),
			status: 'accepted',
			paymentMethod: 'online',
			paymentStatus: 'pending',
		})
		await addOrder('cus_u', { at: ago(1) })
		// Lou: one order at the second location only.
		await addOrder('cus_lost', { at: ago(2), locationId: LOC_B })
	})

	it('counts guests, returning guests and deliverable subscribers with their 30-day change', async () => {
		const { res, body } = await summary()
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(body).toMatchObject({
			// cus_u, cus_v, cus_changed, cus_lost, gst_only, gst_shadow (no walk-in)
			guests: { total: 6, change30d: 3 },
			returningGuests: { total: 2, change30d: 1 },
			// Vera only: Una pending, Cam's address changed, Lou left (-1).
			emailSubscribers: { total: 1, change30d: -1 },
			// Vera (gained) and Cam; Una's phone is unverified; Lou left.
			textSubscribers: { total: 2, change30d: 0 },
			locationScoped: false,
		})
		expect(body.returningGuests.share).toBeCloseTo(2 / 6)
		expect(Date.parse(body.asOf)).not.toBeNaN()
		// Counts only.
		const text = JSON.stringify(body)
		for (const leak of ['cus_', 'gst_', 'Vera', 'example.com', '+1415']) {
			expect(text).not.toContain(leak)
		}
	})

	it('each tile filters the list to exactly its count', async () => {
		const { body: s } = await summary()
		const total = async (q: string) => (await list(q)).body.total
		expect(await total('')).toBe(s.guests.total)
		expect(await total('?returning=1')).toBe(s.returningGuests.total)
		expect(await total('?subscribed=email')).toBe(s.emailSubscribers.total)
		expect(await total('?subscribed=sms')).toBe(s.textSubscribers.total)
		const keys = async (q: string) =>
			(await list(q)).body.people.map((p) => p.key).sort()
		expect(await keys('?returning=1')).toEqual(['c_cus_v', 'g_gst_only'])
		expect(await keys('?subscribed=email')).toEqual(['c_cus_v'])
		expect(await keys('?subscribed=sms')).toEqual(['c_cus_changed', 'c_cus_v'])
		expect((await call('?subscribed=fax', await token())).status).toBe(400)
	})

	it('a third counted order makes Una returning; erasing a guest drops them from every count', async () => {
		await addOrder('cus_u', { at: ago(1), status: 'accepted' })
		expect((await summary()).body.returningGuests.total).toBe(3)

		const jwt = await token(FULL, ORG, { canDelete: true })
		expect((await call('/c_cus_v/erase', jwt, { method: 'POST' })).status).toBe(
			200,
		)
		expect(
			(await call('/g_gst_only/erase', jwt, { method: 'POST' })).status,
		).toBe(200)
		const { body } = await summary()
		expect(body).toMatchObject({
			guests: { total: 4 },
			returningGuests: { total: 1 },
			emailSubscribers: { total: 0 },
			textSubscribers: { total: 1 },
		})
		expect((await list('?returning=1')).body.total).toBe(1)
	})

	it('scopes every count to the token locations; [] is zeros; no claim is everyone', async () => {
		const scoped = await summary({ ...FULL, locationIds: [LOC] })
		// In scope at LOC: Vera (order + visit), Gus (visits), Una (orders).
		expect(scoped.body).toMatchObject({
			guests: { total: 3 },
			returningGuests: { total: 2 },
			emailSubscribers: { total: 1 },
			textSubscribers: { total: 1 },
			locationScoped: true,
		})
		const other = await summary({ ...FULL, locationIds: [LOC_B] })
		expect(other.body).toMatchObject({
			guests: { total: 1 },
			returningGuests: { total: 0 },
			emailSubscribers: { total: 0, change30d: -1 },
			textSubscribers: { total: 0, change30d: -1 },
		})
		const none = await summary({ ...FULL, locationIds: [] })
		expect(none.body).toMatchObject({
			guests: { total: 0, change30d: 0 },
			returningGuests: { total: 0, change30d: 0, share: 0 },
			emailSubscribers: { total: 0 },
			textSubscribers: { total: 0 },
			locationScoped: true,
		})
		const all = await summary({ ...FULL, locationIds: null })
		expect(all.body.guests.total).toBe(6)
		expect(all.body.locationScoped).toBe(false)

		// The tile filters follow the same scope; the plain list does not.
		const scopedList = async (q: string) =>
			(await list(q, { ...FULL, locationIds: [LOC] })).body.total
		expect(await scopedList('?returning=1')).toBe(2)
		expect(await scopedList('?subscribed=sms')).toBe(1)
		expect(await scopedList('')).toBe(6)
		expect(
			(await list('?returning=1', { ...FULL, locationIds: [] })).body.total,
		).toBe(0)
	})

	it('fails closed on a malformed location claim', async () => {
		for (const bad of ['loc_people', [42], ['ok', 'bad id!'], { a: 1 }]) {
			const { body } = await summary({ ...FULL, locationIds: bad })
			expect(body.guests.total).toBe(0)
			expect(body.locationScoped).toBe(true)
		}
	})

	it('a customers-only token counts orders only, never reservations', async () => {
		await addOrder('cus_u', { at: ago(1), status: 'accepted' })
		const { body } = await summary(CUSTOMERS_ONLY)
		// Customer rows only (cus_shadow shows as its own unverified customer).
		expect(body.guests.total).toBe(5)
		// Una's two counted orders; Vera has one order and her visit is not read.
		expect(body.returningGuests.total).toBe(1)
		expect(
			(await list('?returning=1', CUSTOMERS_ONLY)).body.people.map(
				(p) => p.key,
			),
		).toEqual(['c_cus_u'])
	})

	it('refuses tokens without the customers facet, and never counts another organization', async () => {
		expect((await summary(HOST)).res.status).toBe(403)
		const guestOnly = await summary({ scope: 'people', peopleDining: 'full' })
		expect(guestOnly.res.status).toBe(403)
		expect(guestOnly.body.error).toBe('insufficient_permissions')
		expect((await call('?returning=1', await token(HOST))).status).toBe(403)
		expect((await call('?subscribed=email', await token(HOST))).status).toBe(
			403,
		)

		const other = await summary(FULL, ORG_B)
		expect(other.res.status).toBe(200)
		expect(other.body).toMatchObject({
			guests: { total: 0 },
			returningGuests: { total: 0 },
			emailSubscribers: { total: 0, change30d: 0 },
			textSubscribers: { total: 0, change30d: 0 },
		})
	})

	it('an impersonated token reads the counts like the list (claims decide, not the flag)', async () => {
		const { res } = await summary({ ...FULL, impersonated: true })
		expect(res.status).toBe(200)
	})

	describe('many confirmed email subscribers', () => {
		const saved = { ...PEOPLE_STATS_JSON_LIST }
		beforeEach(async () => {
			const db = await getTenantDb(ORG)
			for (const n of [1, 2]) {
				await db.insert(customers).values({
					id: `cus_e${n}`,
					name: `Eve ${n}`,
					phone: `+1415555030${n}`,
					phoneVerified: true,
					email: `eve${n}@example.com`,
					createdAt: new Date(ago(60)),
				})
				await db.insert(customerSubscriptions).values({
					customerId: `cus_e${n}`,
					topic: 'marketing',
					channel: 'email',
					source: 'website',
					subscribedAt: new Date(ago(60)),
					confirmedEmailHash: emailConsentHash(`eve${n}@example.com`),
				})
			}
		})
		afterEach(() => {
			Object.assign(PEOPLE_STATS_JSON_LIST, saved)
		})

		it('counts and lists across several JSON chunks', async () => {
			PEOPLE_STATS_JSON_LIST.chunk = 1
			const { res, body } = await summary()
			expect(res.status).toBe(200)
			expect(body.emailSubscribers.total).toBe(3)
			const listed = await list('?subscribed=email')
			expect(listed.res.status).toBe(200)
			expect(listed.body.total).toBe(3)
			expect(listed.body.people.map((p) => p.key).sort()).toEqual([
				'c_cus_e1',
				'c_cus_e2',
				'c_cus_v',
			])
		})

		it('answers 503 summary_unavailable past the limit; other lists still work', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			PEOPLE_STATS_JSON_LIST.chunk = 1
			PEOPLE_STATS_JSON_LIST.maxChunks = 2
			const over = await summary()
			expect(over.res.status).toBe(503)
			expect(over.res.headers.get('Cache-Control')).toBe('private, no-store')
			expect(over.body).toEqual({
				error: 'summary_unavailable',
				message: 'Subscriber counts are unavailable for this organization',
			})
			const listed = await call('?subscribed=email', await token())
			expect(listed.status).toBe(503)
			const text = await listed.text()
			expect(JSON.parse(text)).toEqual(over.body)
			for (const leak of ['cus_', 'example.com', 'Error', ' at ']) {
				expect(text).not.toContain(leak)
			}
			expect(JSON.stringify(warn.mock.calls)).not.toContain('example.com')
			// Requests without the email predicate never load the email matches.
			expect((await list('')).res.status).toBe(200)
			expect((await list('?subscribed=sms')).res.status).toBe(200)
			expect((await list('?returning=1')).res.status).toBe(200)
			warn.mockRestore()
		})
	})
})

describe('POST /operator/people/:key/consent', () => {
	const MANAGER: Claims = { ...CUSTOMERS_ONLY, canUpdateMarketingConsent: true }
	const ON = { subscribed: true, method: 'in_person', attested: true }
	const send = vi.mocked(sendTenantEmail)

	beforeEach(() => {
		vi.stubEnv('TENANT_API_URL', 'https://tenant.example.com')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		syncEnvFromProcess()
		send.mockClear()
		sms.send.mockReset()
		sms.send.mockResolvedValue({ success: true, mock: true })
		orgs.set(ORG, { ...orgs.get(ORG)!, name: 'Cafe Luna' } as never)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		process.env.DATA_REGION = 'us'
		syncEnvFromProcess()
	})

	async function consent(
		key: string,
		body: Record<string, unknown>,
		claims: Claims = MANAGER,
		orgId = ORG,
	) {
		const res = await call(`/${key}/consent`, await token(claims, orgId), {
			method: 'POST',
			body,
		})
		return { res, body: (await res.json()) as Record<string, any> }
	}

	async function row(customerId: string, channel: 'email' | 'sms') {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(customerSubscriptions)
			.where(
				and(
					eq(customerSubscriptions.customerId, customerId),
					eq(customerSubscriptions.topic, 'marketing'),
					eq(customerSubscriptions.channel, channel),
				),
			)
			.get()
	}

	async function auditRows() {
		const db = await getTenantDb(ORG)
		return db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.action, 'customer.marketing_consent'))
			.all()
	}

	it('records email as pending (never confirmed), with provenance, and sends one link', async () => {
		const { res, body } = await consent('c_cus_v', {
			channel: 'email',
			...ON,
			method: 'paper_form',
		})
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toContain('no-store')
		expect(body).toMatchObject({
			ok: true,
			confirmationEmail: 'sent',
			subscription: {
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'staff',
				pending: true,
				unsubscribedSource: null,
				coolingOffUntil: null,
				staff: {
					recordedBy: 'usr_1',
					method: 'paper_form',
					textVersion: 'staff-2026-11',
				},
			},
		})
		expect(body.confirmationSms).toBeUndefined()
		const stored = await row('cus_v', 'email')
		expect(stored).toMatchObject({
			source: 'staff',
			recordedBy: 'usr_1',
			consentMethod: 'paper_form',
			consentTextVersion: 'staff-2026-11',
			confirmedEmailHash: null,
			unsubscribedAt: null,
		})
		expect(send).toHaveBeenCalledTimes(1)
		expect(send.mock.calls[0]![0].to).toBe('vera@example.com')
		expect(sms.send).not.toHaveBeenCalled()
		const audits = await auditRows()
		expect(audits).toHaveLength(1)
		expect(audits[0]).toMatchObject({
			actorKind: 'operator',
			actorId: 'usr_1',
			entityType: 'customer',
			entityId: 'cus_v',
			changes: {
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				method: 'paper_form',
				source: 'staff',
			},
		})
		expect(JSON.stringify(audits)).not.toContain('vera@')

		// Again at once: nothing rewritten, the resend is throttled.
		const again = await consent('c_cus_v', { channel: 'email', ...ON })
		expect(again.res.status).toBe(200)
		expect(again.body.confirmationEmail).toBe('throttled')
		expect(send).toHaveBeenCalledTimes(1)
		expect((await row('cus_v', 'email'))!.consentMethod).toBe('paper_form')
		expect(await auditRows()).toHaveLength(1)
	})

	it('keeps an already confirmed email subscription as it is', async () => {
		const db = await getTenantDb(ORG)
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'profile',
			confirmedEmail: 'vera@example.com',
		})
		const before = await row('cus_v', 'email')
		const { res, body } = await consent('c_cus_v', { channel: 'email', ...ON })
		expect(res.status).toBe(200)
		expect(body.subscription).toMatchObject({
			source: 'profile',
			pending: false,
			staff: null,
		})
		expect(body.confirmationEmail).toBe('skipped')
		const after = await row('cus_v', 'email')
		expect(after!.confirmedEmailHash).toBe(emailConsentHash('vera@example.com'))
		expect(after!.updatedAt).toEqual(before!.updatedAt)
		expect(send).not.toHaveBeenCalled()
	})

	it('records texts active at once and sends exactly one confirmation text on the US node', async () => {
		const { res, body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(res.status).toBe(200)
		expect(body).toMatchObject({
			confirmationSms: 'sent',
			deliverable: true,
			subscription: {
				channel: 'sms',
				subscribed: true,
				pending: false,
				source: 'staff',
				staff: { recordedBy: 'usr_1', method: 'in_person' },
			},
		})
		expect(sms.send).toHaveBeenCalledTimes(1)
		expect(sms.send.mock.calls[0]![0]).toEqual({
			to: '+14155550101',
			message:
				"You're subscribed to Cafe Luna offers. Reply STOP to unsubscribe.",
		})
		expect(send).not.toHaveBeenCalled()

		// A repeat is idempotent: no rewrite, no second text.
		const again = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(again.body.confirmationSms).toBe('skipped')
		// Off then on again within a day: recorded, but no second text.
		await consent('c_cus_v', { channel: 'sms', subscribed: false })
		const back = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(back.res.status).toBe(200)
		expect(back.body.subscription.subscribed).toBe(true)
		expect(back.body.confirmationSms).toBe('skipped')
		expect(sms.send).toHaveBeenCalledTimes(1)
	})

	it('records a text opt-in for an unverified phone without texting; not deliverable yet', async () => {
		const { res, body } = await consent('c_cus_u', { channel: 'sms', ...ON })
		expect(res.status).toBe(200)
		expect(body).toMatchObject({
			confirmationSms: 'skipped',
			deliverable: false,
			subscription: { subscribed: true, source: 'staff' },
		})
		expect(sms.send).not.toHaveBeenCalled()
	})

	it('a failed text never fails the request and logs no number', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		sms.send.mockRejectedValueOnce(new Error('+14155550101 unreachable'))
		const { res, body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(res.status).toBe(200)
		expect(body.confirmationSms).toBe('skipped')
		expect((await row('cus_v', 'sms'))!.unsubscribedAt).toBeNull()
		expect(JSON.stringify(warn.mock.calls)).not.toContain('4155550101')
		warn.mockRestore()
	})

	it('sends no text on a KSA node but still records the consent', async () => {
		process.env.DATA_REGION = 'ksa'
		orgs.set(ORG, { ...orgs.get(ORG)!, dataRegion: 'ksa' } as never)
		const { res, body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(res.status).toBe(200)
		expect(body.confirmationSms).toBe('skipped')
		expect((await row('cus_v', 'sms'))!.source).toBe('staff')
		expect(sms.send).not.toHaveBeenCalled()
	})

	it('turns off in one call as an operator opt-out, silently and idempotently', async () => {
		await consent('c_cus_v', { channel: 'sms', ...ON })
		sms.send.mockClear()
		const { res, body } = await consent('c_cus_v', {
			channel: 'sms',
			subscribed: false,
		})
		expect(res.status).toBe(200)
		expect(body.subscription).toMatchObject({
			subscribed: false,
			unsubscribedSource: 'operator',
			coolingOffUntil: null,
		})
		expect(body.confirmationSms).toBeUndefined()
		expect((await row('cus_v', 'sms'))!.unsubscribedSource).toBe('operator')
		expect(sms.send).not.toHaveBeenCalled()
		expect(await auditRows()).toHaveLength(2)

		// Off again, or off with no row at all: nothing written.
		const again = await consent('c_cus_v', {
			channel: 'sms',
			subscribed: false,
		})
		expect(again.res.status).toBe(200)
		const none = await consent('c_cus_v', {
			channel: 'email',
			subscribed: false,
		})
		expect(none.res.status).toBe(200)
		expect(none.body.subscription).toBeNull()
		expect(await auditRows()).toHaveLength(2)
	})

	it("a staff opt-out never overwrites the guest's own opt-out", async () => {
		const db = await getTenantDb(ORG)
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'profile',
		})
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
		})
		await consent('c_cus_v', { channel: 'sms', subscribed: false })
		expect((await row('cus_v', 'sms'))!.unsubscribedSource).toBe('self')
	})

	it("cooling-off: a guest's own opt-out within 30 days refuses a staff opt-in and writes nothing", async () => {
		const db = await getTenantDb(ORG)
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'profile',
			now: new Date(Date.now() - 40 * DAY),
		})
		// Stored in whole seconds.
		const optOutAt = new Date(Math.floor((Date.now() - 10 * DAY) / 1000) * 1000)
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
			now: optOutAt,
		})
		const before = await row('cus_v', 'sms')
		const { res, body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(res.status).toBe(409)
		expect(body.error).toBe('cooling_off')
		expect(body.until).toBe(
			new Date(optOutAt.getTime() + 30 * DAY).toISOString(),
		)
		expect(await row('cus_v', 'sms')).toEqual(before)
		expect(await auditRows()).toHaveLength(0)
		expect(sms.send).not.toHaveBeenCalled()

		// The profile shows until when.
		const profile = await (await call('/c_cus_v', await token(MANAGER))).json()
		const sub = profile.marketing.subscriptions.find(
			(s: { topic: string; channel: string }) =>
				s.topic === 'marketing' && s.channel === 'sms',
		)
		expect(sub).toMatchObject({
			subscribed: false,
			unsubscribedSource: 'self',
			coolingOffUntil: body.until,
		})
		expect(profile.access.canUpdateMarketingConsent).toBe(true)
	})

	it('cooling-off ends after 30 days and never follows a staff opt-out', async () => {
		const db = await getTenantDb(ORG)
		await setCustomerSubscription(db, {
			customerId: 'cus_v',
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
			now: new Date(Date.now() - 31 * DAY),
		})
		const late = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(late.res.status).toBe(200)
		expect(late.body.subscription.subscribed).toBe(true)

		await consent('c_cus_v', { channel: 'sms', subscribed: false })
		const back = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(back.res.status).toBe(200)
		expect(back.body.subscription.subscribed).toBe(true)
	})

	it('needs a method and the attestation to turn on, and refuses bad input without echoing it', async () => {
		const noMethod = await consent('c_cus_v', {
			channel: 'sms',
			subscribed: true,
			attested: true,
		})
		expect(noMethod.res.status).toBe(400)
		expect(noMethod.body.error).toBe('method_required')
		const noAttest = await consent('c_cus_v', {
			channel: 'sms',
			subscribed: true,
			method: 'phone',
		})
		expect(noAttest.res.status).toBe(400)
		expect(noAttest.body.error).toBe('attestation_required')
		const falseAttest = await consent('c_cus_v', {
			channel: 'sms',
			...ON,
			attested: false,
		})
		expect(falseAttest.body.error).toBe('attestation_required')
		const bad = await call('/c_cus_v/consent', await token(MANAGER), {
			method: 'POST',
			body: { channel: 'fax', ...ON, textVersion: '<b>evil</b>', extra: 1 },
		})
		expect(bad.status).toBe(400)
		expect(await bad.text()).not.toMatch(/evil|fax/)
		expect(await row('cus_v', 'sms')).toBeUndefined()
	})

	it('stores the server staff wording version; an old client sending textVersion is accepted and ignored', async () => {
		const { res, body } = await consent('c_cus_v', {
			channel: 'sms',
			...ON,
			textVersion: 'guest-2026-11',
		})
		expect(res.status).toBe(200)
		expect(body.subscription.staff.textVersion).toBe(STAFF_CONSENT_TEXT_VERSION)
		expect((await row('cus_v', 'sms'))!.consentTextVersion).toBe(
			STAFF_CONSENT_TEXT_VERSION,
		)
		const [audit] = await auditRows()
		expect((audit!.changes as Record<string, unknown>).textVersion).toBe(
			STAFF_CONSENT_TEXT_VERSION,
		)
		// Any value is ignored, never stored or echoed; other keys stay strict.
		const odd = await consent('c_cus_v', {
			channel: 'email',
			...ON,
			textVersion: 42,
		})
		expect(odd.res.status).toBe(200)
		expect((await row('cus_v', 'email'))!.consentTextVersion).toBe(
			STAFF_CONSENT_TEXT_VERSION,
		)
		const extra = await consent('c_cus_v', {
			channel: 'sms',
			...ON,
			textVersion: 'x',
			other: 1,
		})
		expect(extra.res.status).toBe(400)
	})

	it('caps confirmation texts per organization per hour; consent is still recorded and the sign-in cap is untouched', async () => {
		vi.mocked(checkGlobalSendCap).mockClear()
		const db = await getTenantDb(ORG)
		for (let i = 0; i < PEOPLE_CONSENT_LIMITS.smsConfirmations.max; i += 1) {
			expect(
				(await countPeopleConsentAttempt(db, 'smsConfirmations', ORG)).ok,
			).toBe(true)
		}
		const { res, body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(res.status).toBe(200)
		expect(body).toMatchObject({
			confirmationSms: 'skipped',
			deliverable: true,
			subscription: { subscribed: true, source: 'staff' },
		})
		expect((await row('cus_v', 'sms'))!.unsubscribedAt).toBeNull()
		expect(await auditRows()).toHaveLength(1)
		expect(sms.send).not.toHaveBeenCalled()
		expect(checkGlobalSendCap).not.toHaveBeenCalled()
		// Another organization has its own budget.
		const other = await getTenantDb(ORG_B)
		expect(
			(await countPeopleConsentAttempt(other, 'smsConfirmations', ORG_B)).ok,
		).toBe(true)
	})

	it('a sent confirmation text does not draw on the sign-in code cap', async () => {
		vi.mocked(checkGlobalSendCap).mockClear()
		const { body } = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(body.confirmationSms).toBe('sent')
		expect(checkGlobalSendCap).not.toHaveBeenCalled()
	})

	it('limits consent writes per staff member with a bare 429', async () => {
		const { max } = PEOPLE_CONSENT_LIMITS.actorWrites
		for (let i = 0; i < max; i += 1) {
			const ok = await consent('c_cus_v', { channel: 'sms', subscribed: false })
			expect(ok.res.status).toBe(200)
		}
		const limited = await consent('c_cus_v', { channel: 'sms', ...ON })
		expect(limited.res.status).toBe(429)
		expect(limited.body).toEqual({ error: 'rate_limited' })
		expect(limited.res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(Number(limited.res.headers.get('Retry-After'))).toBeGreaterThan(0)
		expect(await row('cus_v', 'sms')).toBeUndefined()
		expect(sms.send).not.toHaveBeenCalled()
		// Another organization's counters are its own.
		const elsewhere = await consent(
			'c_cus_v',
			{ channel: 'sms', subscribed: false },
			MANAGER,
			ORG_B,
		)
		expect(elsewhere.res.status).not.toBe(429)
	})

	it('needs an address or a phone on the customer', async () => {
		const noEmail = await consent('c_cus_u', { channel: 'email', ...ON })
		expect(noEmail.res.status).toBe(409)
		expect(noEmail.body.error).toBe('email_required')
		const db = await getTenantDb(ORG)
		await db.insert(customers).values({ id: 'cus_np', name: 'No Phone' })
		const noPhone = await consent('c_cus_np', { channel: 'sms', ...ON })
		expect(noPhone.res.status).toBe(409)
		expect(noPhone.body.error).toBe('phone_required')
	})

	it('refuses a token without the claim, a customers-less token, and an impersonation-style token', async () => {
		// Write rights on customers alone are not enough.
		const plain = await consent('c_cus_v', { channel: 'sms', ...ON }, FULL)
		expect(plain.res.status).toBe(403)
		expect(plain.body.error).toBe('insufficient_permissions')
		// The App never mints the claim while impersonating: such a token
		// carries the facets but not the claim.
		const impersonated = await consent(
			'c_cus_v',
			{ channel: 'sms', ...ON },
			{ scope: 'people', peopleCustomers: true, peopleDining: 'flags' },
		)
		expect(impersonated.res.status).toBe(403)
		// The claim without the customers facet.
		const diningOnly = await consent(
			'g_gst_only',
			{ channel: 'sms', ...ON },
			{
				scope: 'people',
				peopleDining: 'full',
				canUpdateGuest: true,
				canUpdateMarketingConsent: true,
			},
		)
		expect(diningOnly.res.status).toBe(403)
		// Only a literal true counts.
		const stringy = await consent(
			'c_cus_v',
			{ channel: 'sms', ...ON },
			{ ...CUSTOMERS_ONLY, canUpdateMarketingConsent: 'true' },
		)
		expect(stringy.res.status).toBe(403)
		expect(await row('cus_v', 'sms')).toBeUndefined()
	})

	it('404s unknown, erased and cross-organization people', async () => {
		expect(
			(await consent('c_nope', { channel: 'sms', ...ON })).res.status,
		).toBe(404)
		expect((await consent('x_bad', { channel: 'sms', ...ON })).res.status).toBe(
			404,
		)
		const other = await consent(
			'c_cus_v',
			{ channel: 'sms', ...ON },
			MANAGER,
			ORG_B,
		)
		expect(other.res.status).toBe(404)
		expect(await row('cus_v', 'sms')).toBeUndefined()

		const eraser = await token(MANAGER, ORG, { canDelete: true })
		expect(
			(await call('/c_cus_v/erase', eraser, { method: 'POST' })).status,
		).toBe(200)
		expect(
			(await consent('c_cus_v', { channel: 'sms', ...ON })).res.status,
		).toBe(404)
	})

	it('a guest-only person without a customer record is 409 no_customer; a booking shadow takes the consent', async () => {
		const withDining: Claims = { ...MANAGER, peopleDining: 'full' }
		const none = await consent(
			'g_gst_only',
			{ channel: 'sms', ...ON },
			withDining,
		)
		expect(none.res.status).toBe(409)
		expect(none.body.error).toBe('no_customer')

		const shadow = await consent(
			'g_gst_shadow',
			{ channel: 'sms', ...ON },
			withDining,
		)
		expect(shadow.res.status).toBe(200)
		expect(shadow.body.deliverable).toBe(false)
		expect((await row('cus_shadow', 'sms'))!.source).toBe('staff')
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers).all()).toHaveLength(3)
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
		expect(routes.length).toBeGreaterThanOrEqual(15)
		expect(routes).toContainEqual({ method: 'GET', path: '/summary' })
		expect(routes).toContainEqual({
			method: 'POST',
			path: '/c_cus_v/consent',
		})
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
