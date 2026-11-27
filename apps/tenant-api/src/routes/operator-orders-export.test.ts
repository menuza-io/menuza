import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { runChunkedCsvExport } from '@repo/reports/export'
import {
	destroyTenantDb,
	formExportAudit,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { operatorOrderRoutes } from './operator-orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const ORG = 'org_orders_export'
const secret = 'test-operator-token-very-long-and-secure-12345'

describe('GET /operator/orders/export?chunk=1 (#386)', () => {
	let directory: string
	let app: Hono

	const mint = (extra: Record<string, unknown> = {}) =>
		new SignJWT({
			orgId: ORG,
			role: 'operator',
			scope: 'orders:read',
			...extra,
		})
			.setSubject('user_manager_1')
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(secret))

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-export-'))
		process.env.TENANT_DB_DIR = directory
		process.env.DATA_REGION = 'us'
		process.env.TENANT_OPERATOR_TOKEN = secret
		vi.mocked(findActiveOrganizationById).mockResolvedValue({
			id: ORG,
			slug: ORG,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as never)
		await provisionTenantDb(ORG)
		const db = await getTenantDb(ORG)
		for (let i = 0; i < 5; i += 1) {
			await db.insert(restaurantOrders).values({
				id: `ord_${i}`,
				orgId: ORG,
				number: `E-${i}`,
				status: 'completed',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				fulfillment: 'pickup',
				locationId: 'loc-1',
				locationName: 'Downtown',
				contactName: 'Secret Guest',
				contactPhone: '+15551230000',
				currency: 'USD',
				subtotalCents: 1000,
				taxCents: 0,
				totalCents: 1000,
				lines: [],
				idempotencyKey: `idem_${i}`,
				requestHash: 'h',
				receiptTokenHash: `r_${i}`,
				createdAt: new Date(Date.now() - i * 60_000),
			} as typeof restaurantOrders.$inferInsert)
		}
		app = new Hono()
		app.route('/operator/orders', operatorOrderRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
	})

	async function request(query: string, jwt: string | null) {
		return app.request(`/operator/orders/export?${query}`, {
			headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
		})
	}

	it('pages the export, matches the one-shot file and leaves one audit row', async () => {
		const jwt = await mint({ linkCustomers: true })
		const oneShot = await (await request('', jwt)).text()
		const result = await runChunkedCsvExport({
			fetchChunk: async (cursor) => {
				const qs = ['chunk=1', 'chunkRows=2', cursor ? `cursor=${cursor}` : '']
					.filter(Boolean)
					.join('&')
				const res = await request(qs, jwt)
				expect(res.status).toBe(200)
				return res.json()
			},
			yieldTurn: async () => {},
		})
		if (result.status !== 'done') throw new Error('expected done')
		expect(await result.blob.text()).toBe(oneShot)
		expect(result.rowCount).toBe(5)
		const db = await getTenantDb(ORG)
		const audits = await db.select().from(formExportAudit)
		expect(audits).toHaveLength(1)
		expect(audits[0]).toMatchObject({
			kind: 'orders',
			operatorId: 'user_manager_1',
			rowCount: 5,
		})
		expect(JSON.stringify(audits[0])).not.toContain('Secret Guest')
	})

	it('leaves guest names and phones out without the customer grant', async () => {
		const res = await request('chunk=1', await mint())
		const body = (await res.json()) as { header: string[]; rows: string[][] }
		expect(body.header).not.toContain('Guest Name')
		expect(JSON.stringify(body.rows)).not.toContain('Secret Guest')
	})

	it('refuses a missing token', async () => {
		expect((await request('chunk=1', null)).status).toBe(401)
	})
})
