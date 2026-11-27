import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { csvLines, runChunkedCsvExport } from '@repo/reports/export'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	formExportAudit,
	getTenantDb,
	loyaltyBalances,
	loyaltyLedger,
	loyaltyMembers,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { emailConsentHash } from '../services/marketing-audience.ts'
import { exportPeopleChunk } from '../services/people-export-service.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import {
	customerIdsByPhone,
	loadCustomerOrderHistory,
} from '../services/report-records.ts'
import { operatorPeopleRoutes } from './operator-people.ts'

const SECRET = 'test-operator-secret-key-for-people-routes-32chars!!'
const ORG = 'org_people_export_a'
const ORG_B = 'org_people_export_b'
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
const CUSTOMERS: Claims = { scope: 'people', peopleCustomers: true }
const FULL: Claims = {
	scope: 'people',
	peopleCustomers: true,
	peopleDining: 'full',
}
const HOST: Claims = { scope: 'people', peopleDining: 'flags' }

async function token(claims: Claims = CUSTOMERS, orgId = ORG) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

async function call(pathname: string, jwt: string | null) {
	return app.request(`/operator/people${pathname}`, {
		headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
	})
}

let seq = 0
async function addOrder(opts: {
	customerId: string | null
	phone: string
	totalCents: number
	currency?: string
	status?: 'completed' | 'cancelled'
	at?: number
	paymentMethod?: 'handoff' | 'online'
	paymentStatus?: string
}) {
	seq += 1
	const db = await getTenantDb(ORG)
	await db.insert(restaurantOrders).values({
		id: `ord_x_${seq}`,
		orgId: ORG,
		number: `X-${seq}`,
		customerId: opts.customerId,
		status: opts.status ?? 'completed',
		paymentMethod: opts.paymentMethod ?? 'handoff',
		paymentStatus: opts.paymentStatus ?? 'unpaid',
		fulfillment: 'pickup',
		locationId: 'loc_x',
		locationName: 'Downtown',
		contactName: 'x',
		contactPhone: opts.phone,
		currency: opts.currency ?? 'usd',
		subtotalCents: opts.totalCents,
		taxCents: 0,
		totalCents: opts.totalCents,
		lines: [],
		idempotencyKey: `idem_x_${seq}`,
		requestHash: `hash_x_${seq}`,
		receiptTokenHash: `rcpt_x_${seq}`,
		createdAt: new Date(opts.at ?? Date.now()),
	} as typeof restaurantOrders.$inferInsert)
}

async function addPoints(
	customerId: string,
	opts: { balance: number; used: number },
) {
	const db = await getTenantDb(ORG)
	const memberId = `mem_${customerId}`
	await db.insert(loyaltyMembers).values({ id: memberId, customerId })
	await db.insert(loyaltyBalances).values({ memberId, points: opts.balance })
	if (opts.used > 0) {
		await db.insert(loyaltyLedger).values({
			memberId,
			type: 'redeem',
			delta: -opts.used,
			eventKey: `redeem:${memberId}`,
			actorKind: 'system',
		})
	}
}

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-people-export-'))
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
	syncEnvFromProcess()
	const db = await getTenantDb(ORG)
	const now = Date.now()
	await db.insert(customers).values([
		{
			id: 'cus_big',
			name: 'Big Spender',
			phone: '+14155550101',
			phoneVerified: true,
			email: 'big@example.com',
			createdAt: new Date(now - 100 * DAY),
		},
		{
			id: 'cus_mid',
			name: 'Mid Spender',
			phone: '+14155550102',
			phoneVerified: true,
			email: 'mid@example.com',
			createdAt: new Date(now - 50 * DAY),
		},
		{
			id: 'cus_small',
			name: '=HYPERLINK("http://evil")',
			phone: '+14155550103',
			phoneVerified: true,
			createdAt: new Date(now - 10 * DAY),
		},
		{
			id: 'cus_none',
			name: 'No Orders',
			phone: '+14155550104',
			phoneVerified: false,
			createdAt: new Date(now - 5 * DAY),
		},
	])
	// Big: 2 counted orders + one cancelled (not a sale). Mid: one, plus a guest
	// checkout with the same number written differently (matched by phone).
	await addOrder({
		customerId: 'cus_big',
		phone: '+14155550101',
		totalCents: 5000,
		at: now - 20 * DAY,
	})
	await addOrder({
		customerId: 'cus_big',
		phone: '+14155550101',
		totalCents: 2500,
		at: now - 3 * DAY,
	})
	await addOrder({
		customerId: 'cus_big',
		phone: '+14155550101',
		totalCents: 99_999,
		status: 'cancelled',
	})
	await addOrder({
		customerId: 'cus_mid',
		phone: '+14155550102',
		totalCents: 4000,
		at: now - 10 * DAY,
	})
	await addOrder({
		customerId: null,
		phone: '(415) 555-0102',
		totalCents: 1500,
		at: now - 2 * DAY,
	})
	await addOrder({
		customerId: 'cus_small',
		phone: '+14155550103',
		totalCents: 900,
		at: now - 8 * DAY,
	})
	await addPoints('cus_big', { balance: 40, used: 10 })
	await addPoints('cus_small', { balance: 700, used: 600 })
	await db.insert(customerSubscriptions).values([
		{
			customerId: 'cus_big',
			topic: 'marketing',
			channel: 'sms',
			source: 'checkout',
			subscribedAt: new Date(),
		},
		{
			customerId: 'cus_mid',
			topic: 'marketing',
			channel: 'email',
			source: 'checkout',
			subscribedAt: new Date(),
			confirmedEmailHash: emailConsentHash('mid@example.com'),
		},
	] as (typeof customerSubscriptions.$inferInsert)[])
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id)
	rmSync(tempDir, { recursive: true, force: true })
})

type ListBody = {
	people: Array<{
		key: string
		name: string
		spend: Array<{ currency: string; minor: number }> | null
		points: { balance: number; used: number } | null
		marketing: { email: boolean; sms: boolean } | null
	}>
	total: number
}
type ExportBody = {
	header: string[]
	rows: string[][]
	nextCursor: string | null
	total: number
	matching: number
	truncated: boolean
	footer: string[][] | null
}

async function list(query: string, claims: Claims = CUSTOMERS) {
	const res = await call(`?${query}`, await token(claims))
	return { res, body: (await res.json()) as ListBody }
}

/** The whole export the way the browser reads it: every chunk, in order. */
async function exportAll(query: string, chunk = 2, claims: Claims = CUSTOMERS) {
	const rows: string[][] = []
	let header: string[] = []
	let cursor: string | null = null
	let last: ExportBody | null = null
	for (let i = 0; i < 50; i += 1) {
		const qs = [query, `chunk=${chunk}`, cursor ? `cursor=${cursor}` : '']
			.filter(Boolean)
			.join('&')
		const res = await call(`/export?${qs}`, await token(claims))
		expect(res.status).toBe(200)
		const body = (await res.json()) as ExportBody
		header = body.header
		rows.push(...body.rows)
		last = body
		cursor = body.nextCursor
		if (!cursor) break
	}
	return { header, rows, last: last! }
}

describe('Customers list sorts (#231)', () => {
	it('sorts by total spend, biggest first, and matches the reports', async () => {
		const { res, body } = await list('sort=total_spend')
		expect(res.status).toBe(200)
		expect(body.people.map((p) => p.key)).toEqual([
			'c_cus_big',
			'c_cus_mid',
			'c_cus_small',
			'c_cus_none',
		])
		const db = await getTenantDb(ORG)
		const history = await loadCustomerOrderHistory(
			db,
			ORG,
			await customerIdsByPhone(db),
		)
		for (const person of body.people) {
			const id = person.key.slice(2)
			const reportCents = history.get(id)?.spentCents ?? 0
			expect(person.spend?.[0]?.minor ?? 0).toBe(reportCents)
		}
		// Cancelled orders are not sales; the guest checkout is matched by phone.
		expect(body.people[0]!.spend).toEqual([{ currency: 'USD', minor: 7500 }])
		expect(body.people[1]!.spend).toEqual([{ currency: 'USD', minor: 5500 }])
	})

	it('sorts by points used and shows the balance', async () => {
		const { body } = await list('sort=points_used')
		expect(body.people.map((p) => p.key).slice(0, 2)).toEqual([
			'c_cus_small',
			'c_cus_big',
		])
		expect(body.people[0]!.points).toEqual({ balance: 700, used: 600 })
		expect(body.people.find((p) => p.key === 'c_cus_none')!.points).toEqual({
			balance: 0,
			used: 0,
		})
	})

	it('shows the marketing badge per row', async () => {
		const { body } = await list('')
		const by = new Map(body.people.map((p) => [p.key, p.marketing]))
		expect(by.get('c_cus_big')).toEqual({ email: false, sms: true })
		expect(by.get('c_cus_mid')).toEqual({ email: true, sms: false })
		expect(by.get('c_cus_none')).toEqual({ email: false, sms: false })
	})

	it('filters by joined and last order dates', async () => {
		const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
		const now = Date.now()
		const joined = await list(
			`joinedFrom=${day(now - 60 * DAY)}&joinedTo=${day(now - 20 * DAY)}`,
		)
		expect(joined.body.people.map((p) => p.key).sort()).toEqual(['c_cus_mid'])
		const ordered = await list(
			`lastOrderFrom=${day(now - 4 * DAY)}&lastOrderTo=${day(now)}`,
		)
		expect(ordered.body.people.map((p) => p.key).sort()).toEqual(['c_cus_big'])
	})

	it('refuses spend sorts and order dates without the customers grant', async () => {
		expect((await list('sort=total_spend', HOST)).res.status).toBe(403)
		expect((await list('lastOrderFrom=2020-01-01', HOST)).res.status).toBe(403)
	})
})

describe('GET /operator/people/export (#231)', () => {
	it('exports exactly the filtered view, in the same order, across chunks', async () => {
		const query = 'sort=total_spend&account=signed_in'
		const listed = await list(query)
		const exported = await exportAll(query, 1)
		expect(exported.rows.map((r) => r[0])).toEqual(
			listed.body.people.map((p) => p.name),
		)
		expect(exported.header).toEqual([
			'Name',
			'Email',
			'Phone',
			'Joined',
			'Last order',
			'Orders',
			'Total spend (USD)',
			'Email subscription',
			'Text subscription',
			'Points balance',
			'Points used',
		])
		const big = exported.rows.find((r) => r[0] === 'Big Spender')!
		expect(big.slice(1)).toEqual([
			'big@example.com',
			'+14155550101',
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			'3', // list orders column: every order of the customer (3 incl. cancelled)
			'75.00',
			'No',
			'Subscribed',
			'40',
			'10',
		])
		// A narrower view exports only its rows.
		const narrow = await exportAll('sort=total_spend&subscribed=sms', 5)
		expect(narrow.rows.map((r) => r[0])).toEqual(['Big Spender'])
	})

	it('writes one audit row with a count and no personal data', async () => {
		await exportAll('', 2)
		const db = await getTenantDb(ORG)
		const audits = await db.select().from(formExportAudit)
		expect(audits).toHaveLength(1)
		expect(audits[0]).toMatchObject({
			kind: 'people',
			operatorId: 'usr_1',
			rowCount: 4,
		})
		const blob = JSON.stringify(audits[0])
		for (const needle of ['Big', 'example.com', '+1415', 'Spender']) {
			expect(blob).not.toContain(needle)
		}
	})

	it('refuses a member without the customer grant, and a missing token', async () => {
		expect((await call('/export', await token(HOST))).status).toBe(403)
		expect((await call('/export', null)).status).toBe(401)
		const db = await getTenantDb(ORG)
		expect(await db.select().from(formExportAudit)).toHaveLength(0)
	})

	it('never reads another organization', async () => {
		const res = await call('/export', await token(CUSTOMERS, ORG_B))
		const body = (await res.json()) as ExportBody
		expect(body.rows).toEqual([])
		expect(body.total).toBe(0)
	})

	it('never exports an erased person', async () => {
		const db = await getTenantDb(ORG)
		await erasePerson(db, { customerId: 'cus_mid' }, { actorId: 'usr_1' })
		const exported = await exportAll('', 10)
		expect(exported.rows.map((r) => r[0]).sort()).not.toContain('Mid Spender')
		expect(JSON.stringify(exported.rows)).not.toContain('mid@example.com')
	})

	it('is formula-safe once written by the shared CSV writer', async () => {
		const result = await runChunkedCsvExport({
			header: ['Name'],
			fetchChunk: async (cursor) => {
				const qs = ['chunk=2', cursor ? `cursor=${cursor}` : '']
					.filter(Boolean)
					.join('&')
				const res = await call(`/export?${qs}`, await token())
				const body = (await res.json()) as ExportBody
				return { ...body, rows: body.rows.map((r) => [r[0]!]) }
			},
			yieldTurn: async () => {},
		})
		if (result.status !== 'done') throw new Error('expected done')
		const text = await result.blob.text()
		expect(text).toContain("'=HYPERLINK")
		expect(text.split('\n').some((line) => line.startsWith('='))).toBe(false)
		expect(csvLines([['=1+1']])).toBe("'=1+1\n")
	})

	it('gives mixed currencies one column each and never adds them', async () => {
		await addOrder({
			customerId: 'cus_big',
			phone: '+14155550101',
			totalCents: 1000,
			currency: 'sar',
		})
		const exported = await exportAll('sort=total_spend', 10)
		expect(exported.header.filter((h) => h.startsWith('Total spend'))).toEqual([
			'Total spend (SAR)',
			'Total spend (USD)',
		])
		const big = exported.rows.find((r) => r[0] === 'Big Spender')!
		expect(big.slice(6, 8)).toEqual(['10.00', '75.00'])
	})

	it('cuts at the row cap and says so', async () => {
		const db = await getTenantDb(ORG)
		const access = {
			actorId: 'usr_1',
			customers: true,
			dining: 'none' as const,
			canUpdateCustomers: false,
			canUpdateDining: false,
			canDelete: false,
		}
		const first = await exportPeopleChunk(
			db,
			access,
			{},
			{
				actorId: 'usr_1',
				chunkRows: 2,
				maxRows: 3,
			},
		)
		expect(first.rows).toHaveLength(2)
		expect(first.truncated).toBe(true)
		expect(first.matching).toBe(4)
		expect(first.total).toBe(3)
		const second = await exportPeopleChunk(
			db,
			access,
			{},
			{
				actorId: 'usr_1',
				chunkRows: 2,
				maxRows: 3,
				cursor: first.nextCursor!,
			},
		)
		expect(second.rows).toHaveLength(1)
		expect(second.nextCursor).toBeNull()
		expect(second.footer?.[0]?.[0]).toContain('cut at 3 rows')
	})

	it('rejects a tampered cursor', async () => {
		const res = await call('/export?cursor=not-a-cursor', await token())
		expect(res.status).toBe(400)
	})
})

describe('a dining-only claim never reads spend', () => {
	it('lists no spend or points for a host-only token', async () => {
		const { res, body } = await list('', FULL)
		expect(res.status).toBe(200)
		expect(body.people.find((p) => p.key === 'c_cus_big')!.spend).toEqual([
			{ currency: 'USD', minor: 7500 },
		])
		const host = await list('', HOST)
		for (const person of host.body.people) {
			expect(person.spend).toBeNull()
			expect(person.points).toBeNull()
			expect(person.marketing).toBeNull()
		}
	})
})
