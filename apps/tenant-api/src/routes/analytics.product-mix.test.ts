import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	mintOperatorAnalyticsToken,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { analyticsRoutes } from './analytics.ts'

const SECRET = 'test-product-mix-signing-secret-32-characters!!'
const ORG = 'org_pmix_a'
const ORG_B = 'org_pmix_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono()
app.route('/analytics', analyticsRoutes)

async function token(
	options: {
		orgId?: string
		subjects?: readonly RestrictedReportSubject[]
		locationIds?: readonly string[] | null
		secret?: string
	} = {},
) {
	const { token } = await mintOperatorAnalyticsToken({
		signingSecret: options.secret ?? SECRET,
		userId: 'usr_pmix',
		orgId: options.orgId ?? ORG,
		role: 'operator',
		subjects: options.subjects ?? ['orders', 'product_mix', 'product_mix_options'],
		scopeIds: null,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
	})
	return token
}

const get = async (jwt: string, query = '') =>
	app.request(`/analytics/product-mix?preset=last_30_days${query}`, {
		headers: { Authorization: `Bearer ${jwt}` },
	})

let tempDir: string

async function order(
	orgId: string,
	locationId: string,
	itemId: string,
	cents: number,
	extra: Record<string, unknown> = {},
) {
	const db = await getTenantDb(orgId)
	const n = Math.random().toString(36).slice(2)
	await db.insert(restaurantOrders).values({
		orgId,
		number: `P-${n}`,
		status: 'completed',
		paymentMethod: 'handoff',
		paymentStatus: 'unpaid',
		fulfillment: 'pickup',
		locationId,
		locationName: locationId,
		contactName: 'Guest',
		contactPhone: '+966500000000',
		currency: 'sar',
		subtotalCents: cents,
		taxCents: 0,
		totalCents: cents,
		lines: [
			{
				itemId,
				itemName: itemId,
				variantId: null,
				quantity: 1,
				unitPriceCents: cents,
				taxableUnitCents: cents,
				totalCents: cents,
				taxableCents: cents,
				instructions: null,
				baseUnitCents: 0,
				categoryIds: [],
				categoryId: 'cat_1',
				categoryName: 'Mains',
				menuId: 'menu_1',
				menuName: 'Main',
				options: [],
			},
		],
		idempotencyKey: `idem-${n}`,
		requestHash: 'hash',
		receiptTokenHash: `receipt-${n}`,
		createdAt: new Date(Date.now() - 86_400_000),
		...extra,
	})
}

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'product-mix-route-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.OPERATOR_ANALYTICS_TOKEN = SECRET
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
})

afterEach(async () => {
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(tempDir, { recursive: true, force: true })
	orgs.clear()
})

describe('/analytics/product-mix (#227)', () => {
	it('returns dish rows with the menu and category each dish was sold under', async () => {
		await order(ORG, 'loc_a', 'burger', 5000)
		const res = await get(await token())
		expect(res.status).toBe(200)
		const body = (await res.json()) as any
		expect(body.rows).toHaveLength(1)
		expect(body.rows[0]).toMatchObject({
			kind: 'dish',
			category: 'Mains',
			menu: 'Main',
			item: 'burger',
			salesMinor: 5000,
			currency: 'SAR',
		})
		// Only ids, names and numbers: nothing about the guest.
		expect(JSON.stringify(body)).not.toMatch(/Guest|\+9665/)
	})

	it('narrows by the locations the token covers and by channel, and reads only its own organization', async () => {
		await order(ORG, 'loc_a', 'burger', 5000)
		await order(ORG, 'loc_b', 'fries', 1000)
		await order(ORG, 'loc_a', 'qr-dish', 700, { source: 'qr_table' })
		await order(ORG_B, 'loc_a', 'secret-dish', 9999)
		const scoped = (await (await get(await token({ locationIds: ['loc_a'] }))).json()) as any
		expect(scoped.rows.map((r: any) => r.item).sort()).toEqual(['burger', 'qr-dish'])
		// Asking for a location outside the token never widens it.
		const wider = (await (
			await get(await token({ locationIds: ['loc_a'] }), '&locationIds=loc_b')
		).json()) as any
		expect(wider.rows).toEqual([])
		const channel = (await (await get(await token(), '&channels=online_menu')).json()) as any
		expect(channel.rows.map((r: any) => r.item).sort()).toEqual(['burger', 'fries'])
		const other = (await (await get(await token({ orgId: ORG_B }))).json()) as any
		expect(other.rows.map((r: any) => r.item)).toEqual(['secret-dish'])
	})

	it('refuses a forged token and one without the grant', async () => {
		expect((await get(await token({ secret: 'another-secret-another-secret-123' }))).status).toBe(401)
		expect((await get(await token({ subjects: ['orders'] }))).status).toBe(403)
		expect((await app.request('/analytics/product-mix')).status).toBe(401)
	})
})
