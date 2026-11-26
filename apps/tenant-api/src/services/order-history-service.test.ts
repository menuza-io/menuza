import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	exportOrderHistoryCsv,
	queryOrderHistory,
} from './order-history-service.ts'

describe('order history search, filter and CSV export (#224)', () => {
	const orgId = `org-history-${crypto.randomUUID().slice(0, 8)}`
	let tmpDir: string
	let prevDbDir: string | undefined

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menuza-history-'))
		prevDbDir = process.env.TENANT_DB_DIR
		process.env.TENANT_DB_DIR = tmpDir
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		if (prevDbDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevDbDir
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	async function seedOrder(
		overrides: Partial<typeof restaurantOrders.$inferInsert>,
	) {
		const db = await getTenantDb(orgId)
		const id = crypto.randomUUID()
		await db.insert(restaurantOrders).values({
			id,
			orgId,
			number: '1001',
			locale: 'en',
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: 'loc-1',
			locationName: 'Downtown',
			locationTimezone: 'America/New_York',
			contactName: 'Jane Doe',
			contactPhone: '+15551112222',
			currency: 'USD',
			subtotalCents: 2000,
			taxCents: 200,
			deliveryFeeCents: 0,
			serviceFeeCents: 100,
			tipCents: 300,
			totalCents: 2600,
			lines: [{ itemName: 'Margherita Pizza', quantity: 1, totalCents: 2000 }],
			idempotencyKey: `idem-${id}`,
			requestHash: 'h',
			receiptTokenHash: 'rh',
			...overrides,
		})
		return id
	}

	it('finds an order from three months ago by number, guest name, phone, or dish', async () => {
		const threeMonthsAgo = new Date(Date.now() - 95 * 86_400_000)
		await seedOrder({
			number: '8842',
			contactName: 'Fatima Al-Mansoor',
			contactPhone: '+15558675309',
			lines: [
				{ itemName: 'Truffle Shawarma Wrap', quantity: 2, totalCents: 2400 },
			],
			createdAt: threeMonthsAgo,
		})
		await seedOrder({
			number: '9999',
			contactName: 'Other Guest',
			contactPhone: '+15550000000',
			lines: [{ itemName: 'Caesar Salad', quantity: 1, totalCents: 1200 }],
		})

		for (const q of ['8842', 'Fatima', '867-5309', 'Shawarma']) {
			const res = await queryOrderHistory({
				orgId,
				locationIds: null,
				query: { q },
			})
			expect(res.ok).toBe(true)
			if (res.ok) {
				expect(res.data.orders).toHaveLength(1)
				expect(res.data.orders[0]?.number).toBe('8842')
			}
		}
	})

	it('enforces location scope, filters, cursor stability, and 366-day max range', async () => {
		await seedOrder({
			number: 'L1-A',
			locationId: 'loc-1',
			fulfillment: 'delivery',
			totalCents: 5000,
			taxExemptRef: 'EX-100',
		})
		await seedOrder({
			number: 'L1-B',
			locationId: 'loc-1',
			fulfillment: 'pickup',
			totalCents: 1500,
		})
		await seedOrder({
			number: 'L2-A',
			locationId: 'loc-2',
			fulfillment: 'delivery',
			totalCents: 9000,
		})

		// Location-scoped operator on loc-1 cannot see loc-2
		const scoped = await queryOrderHistory({
			orgId,
			locationIds: ['loc-1'],
			query: {},
		})
		expect(scoped.ok).toBe(true)
		if (scoped.ok) {
			expect(scoped.data.orders.map((o) => o.number).sort()).toEqual([
				'L1-A',
				'L1-B',
			])
		}

		// Explicitly requesting loc-2 returns empty for loc-1 operator
		const crossLoc = await queryOrderHistory({
			orgId,
			locationIds: ['loc-1'],
			query: { locationId: 'loc-2' },
		})
		expect(crossLoc.ok).toBe(true)
		if (crossLoc.ok) expect(crossLoc.data.orders).toHaveLength(0)

		// Tax-exempt filter
		const exemptOnly = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { taxExempt: 'true' },
		})
		expect(exemptOnly.ok).toBe(true)
		if (exemptOnly.ok) {
			expect(exemptOnly.data.orders.map((o) => o.number)).toEqual(['L1-A'])
		}

		// Pagination with limit=1 and sort=total_desc
		const p1 = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { limit: 1, sort: 'total_desc' },
		})
		expect(p1.ok).toBe(true)
		if (!p1.ok) return
		expect(p1.data.orders[0]?.number).toBe('L2-A')
		expect(p1.data.nextCursor).toBeTruthy()
		const p2 = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { limit: 1, sort: 'total_desc', cursor: p1.data.nextCursor! },
		})
		expect(p2.ok).toBe(true)
		if (p2.ok) expect(p2.data.orders[0]?.number).toBe('L1-A')

		// Date range > 366 days refused
		const tooWide = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { from: '2025-01-01', to: '2026-06-01' },
		})
		expect(tooWide.ok).toBe(false)
		if (!tooWide.ok) {
			expect(tooWide.failure.status).toBe(422)
			expect(tooWide.failure.code).toBe('date_range_too_large')
		}
	})

	it('exports formula-safe CSV with totals row, PII gating, currency guard, and truncation notice', async () => {
		await seedOrder({
			number: '101',
			contactName: '=HYPERLINK("http://evil")',
			contactPhone: '+15551234567',
			subtotalCents: 1000,
			taxCents: 100,
			serviceFeeCents: 50,
			tipCents: 200,
			totalCents: 1350,
			currency: 'USD',
		})
		await seedOrder({
			number: '102',
			contactName: 'Bob Smith',
			contactPhone: '+15559876543',
			subtotalCents: 2000,
			taxCents: 200,
			serviceFeeCents: 0,
			tipCents: 0,
			totalCents: 2200,
			currency: 'USD',
		})

		// Without customer read grant: PII omitted, totals row present
		const noPii = await exportOrderHistoryCsv({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: false,
		})
		expect(noPii.ok).toBe(true)
		if (!noPii.ok) return
		expect(noPii.data.csv).not.toContain('Guest Name')
		expect(noPii.data.csv).not.toContain('Bob Smith')
		expect(noPii.data.csv).toContain('Totals,')
		expect(noPii.data.csv).toContain('35.50') // 13.50 + 22.00

		// With customer read grant: formula-safe neutralization applied
		const withPii = await exportOrderHistoryCsv({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: true,
		})
		expect(withPii.ok).toBe(true)
		if (!withPii.ok) return
		expect(withPii.data.csv).toContain('Guest Name,Guest Phone')
		expect(withPii.data.csv).toContain("'=HYPERLINK")

		// Truncation notice when cut
		const cut = await exportOrderHistoryCsv({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: false,
			maxRows: 1,
		})
		expect(cut.ok).toBe(true)
		if (cut.ok) {
			expect(cut.data.truncated).toBe(true)
			expect(cut.data.csv).toContain('Export truncated to 1 rows')
		}

		// Mixed currencies: NO totals row
		await seedOrder({ number: '103', currency: 'SAR', totalCents: 5000 })
		const mixed = await exportOrderHistoryCsv({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: false,
		})
		expect(mixed.ok).toBe(true)
		if (mixed.ok) {
			expect(mixed.data.csv).not.toContain('Totals,')
		}
	})
})
