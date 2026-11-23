import { Hono } from 'hono'
import { createReportDefinition } from '@repo/reports'
import { mintOperatorAnalyticsToken } from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	type PublishedOrganization,
} from '../lib/origin.ts'
import { analyticsRoutes } from '../routes/analytics.ts'
import {
	ALL_GRANTS,
	BASE,
	cid,
	makeClient,
	mintToken,
	setupTenantEnv,
} from '../routes/inventory-test-utils.ts'
import { operatorInventoryRoutes } from '../routes/operator-inventory.ts'
import { queryDeliveriesReport } from './inventory-deliveries-report.ts'

const ORG = 'clw9x0a12000008l00invrep1'
const LOC_A = 'loc_rep_a'
const LOC_B = 'loc_rep_b'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
	findActiveOrganizationById: vi.fn(),
}))

vi.mock('../lib/reservations-context.ts', () => ({
	getReservationsContext: vi.fn(async () => ({
		locations: [
			{ id: LOC_A, name: 'Riyadh Main' },
			{ id: LOC_B, name: 'Jeddah Branch' },
		],
	})),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

let env: ReturnType<typeof setupTenantEnv>
let full: string

beforeAll(async () => {
	env = setupTenantEnv('inv-del-rep')
	const orgRecord = {
		id: ORG,
		slug: 'inv-rep',
		name: 'Inv Rep',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
	orgs.set(ORG, orgRecord as PublishedOrganization)
	vi.mocked(findActiveOrganizationById).mockResolvedValue(
		orgRecord as Awaited<ReturnType<typeof findActiveOrganizationById>>,
	)
	await provisionTenantDb(ORG)
	full = await mintToken(ORG, { grants: ALL_GRANTS })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('inventory-deliveries-report & analytics inventory_deliveries (#507)', () => {
	it('computes identical totals between accountant-export and POST /analytics/query inventory_deliveries, including credits and cash market purchases', async () => {
		const supRes = await call('POST', `${BASE}/suppliers`, {
			token: full,
			body: {
				clientId: cid('sup'),
				name: 'Almarai',
				currency: 'SAR',
				vatNumber: '310000000100003',
			},
		})
		expect(supRes.status).toBe(200)
		const supplierId = supRes.body.id as string

		const dairyRes = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'Milk',
				category: 'dairy',
				kind: 'bought',
				baseUnit: 'ml',
			},
		})
		const produceRes = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'Mint',
				category: 'produce',
				kind: 'bought',
				baseUnit: 'g',
			},
		})
		const milkId = dairyRes.body.id as string
		const mintId = produceRes.body.id as string

		// 1) Normal priced delivery at LOC_A: 100.00 net + 15.00 VAT = 115.00
		const d1 = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC_A,
				supplierId,
				currency: 'SAR',
				invoiceNumber: 'INV-1',
				invoiceDate: '2026-11-20',
				vatMinor: 1500,
				totalMinor: 11500,
				zatcaReference: 'ZATCA-1',
				paid: false,
				lines: [{ itemId: milkId, quantity: 1000, lineTotalMinor: 10000 }],
			},
		})
		expect(d1.status, JSON.stringify(d1.body)).toBe(200)

		// 2) Supplier credit note at LOC_A: -20.00 net - 3.00 VAT = -23.00
		const d2 = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC_A,
				supplierId,
				currency: 'SAR',
				invoiceNumber: 'CR-1',
				invoiceDate: '2026-11-20',
				vatMinor: 300,
				totalMinor: 2300,
				isCredit: true,
				creditForDeliveryId: d1.body.delivery.id,
				paid: false,
				lines: [{ itemId: milkId, quantity: 200, lineTotalMinor: 2000 }],
			},
		})
		expect(d2.status, JSON.stringify(d2.body)).toBe(200)

		// 3) Cash market purchase at LOC_B: 50.00 net, paid=true
		const d3 = await call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('del'),
				locationId: LOC_B,
				supplierId: null,
				currency: 'SAR',
				isCashPurchase: true,
				paid: true,
				invoiceDate: '2026-11-20',
				lines: [{ itemId: mintId, quantity: 500, lineTotalMinor: 5000 }],
			},
		})
		expect(d3.status, JSON.stringify(d3.body)).toBe(200)

		const db = await getTenantDb(ORG)
		const report = await queryDeliveriesReport(db, {
			from: '2026-11-20',
			to: '2026-11-20',
			locationId: 'all',
		})
		expect(report.totals).toEqual({
			count: 3,
			netMinor: 13000,
			vatMinor: 1200,
			totalMinor: 14200,
			paidMinor: 5000,
			unpaidMinor: 9200,
		})
		expect(report.categoryTotals).toEqual({
			dairy: 8000,
			produce: 5000,
		})

		const exportRes = await call(
			'GET',
			`${BASE}/purchasing/accountant-export?from=2026-11-20&to=2026-11-20&locationId=all&format=json`,
			{ token: full },
		)
		expect(exportRes.status).toBe(200)
		expect(exportRes.body.totals).toEqual(report.totals)

		// Run Analytics query for `inventory_deliveries` and verify exact match!
		const analyticsSecret = 'analytics-internal-token-1234567890'
		const prevSecret = process.env.OPERATOR_ANALYTICS_TOKEN
		const prevRegion = process.env.DATA_REGION
		process.env.OPERATOR_ANALYTICS_TOKEN = analyticsSecret
		process.env.DATA_REGION = 'us'
		try {
			const { token } = await mintOperatorAnalyticsToken({
				signingSecret: analyticsSecret,
				userId: 'user_1',
				orgId: ORG,
				role: 'admin',
				subjects: ['inventory_deliveries'],
				scopeIds: null,
			})
			const sumDef = createReportDefinition({
				subject: 'inventory_deliveries',
				timeframe: { field: 'receivedAt', preset: 'all_time' },
				visualization: {
					chartStyle: 'single_number',
					measure: 'sum',
					valueField: 'totalMinor',
				},
				settings: { title: 'Deliveries Total', timezone: 'UTC' },
			})
			const analyticsRes = await analyticsRoutes.request('/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ definition: sumDef }),
			})
			expect(analyticsRes.status).toBe(200)
			const analyticsBody = (await analyticsRes.json()) as {
				total: number
				value: number
			}
			expect(analyticsBody.total).toBe(3)
			expect(Math.round(analyticsBody.value * 100)).toBe(
				exportRes.body.totals.totalMinor,
			)

			// Location-scoped token only sees LOC_A (11500 - 2300 = 9200).
			const { token: scopedAnalyticsToken } = await mintOperatorAnalyticsToken({
				signingSecret: analyticsSecret,
				userId: 'user_1',
				orgId: ORG,
				role: 'operator',
				subjects: ['inventory_deliveries'],
				scopeIds: [LOC_A],
			})
			const scopedRes = await analyticsRoutes.request('/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${scopedAnalyticsToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ definition: sumDef }),
			})
			expect(scopedRes.status).toBe(200)
			const scopedBody = (await scopedRes.json()) as { value: number }
			expect(Math.round(scopedBody.value * 100)).toBe(9200)

			// Token without `inventory_deliveries` permission is refused with 403.
			const { token: noGrantToken } = await mintOperatorAnalyticsToken({
				signingSecret: analyticsSecret,
				userId: 'user_1',
				orgId: ORG,
				role: 'operator',
				subjects: [],
				scopeIds: null,
			})
			const denied = await analyticsRoutes.request('/query', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${noGrantToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ definition: sumDef }),
			})
			expect(denied.status).toBe(403)
		} finally {
			process.env.OPERATOR_ANALYTICS_TOKEN = prevSecret ?? ''
			process.env.DATA_REGION = prevRegion ?? ''
		}
	})
})
