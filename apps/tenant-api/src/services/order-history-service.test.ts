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
import { runChunkedCsvExport } from '@repo/reports/export'
import {
	exportOrderHistoryChunk,
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

	it('searches by card last four only when caller holds payments access (#423)', async () => {
		await seedOrder({
			number: 'CARD-1',
			cardBrand: 'visa',
			cardLast4: '4242',
		})
		await seedOrder({
			number: 'CARD-2',
			cardBrand: 'mastercard',
			cardLast4: '9911',
		})

		// Permitted caller finds by explicit cardLast4 and by q
		const byFilter = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { cardLast4: '4242' },
			canSearchCard: true,
		})
		expect(byFilter.ok).toBe(true)
		if (byFilter.ok) {
			expect(byFilter.data.orders.map((o) => o.number)).toEqual(['CARD-1'])
		}

		const byQuery = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { q: '9911' },
			canSearchCard: true,
		})
		expect(byQuery.ok).toBe(true)
		if (byQuery.ok) {
			expect(byQuery.data.orders.map((o) => o.number)).toEqual(['CARD-2'])
		}

		// Caller without payments access cannot match orders by card last4 via q
		const denied = await queryOrderHistory({
			orgId,
			locationIds: null,
			query: { q: '4242' },
			canSearchCard: false,
		})
		expect(denied.ok).toBe(true)
		if (denied.ok) {
			expect(denied.data.orders).toHaveLength(0)
		}
	})
	it('exports in chunks with the same file as the one-shot export (#386)', async () => {
		for (let i = 0; i < 7; i += 1) {
			await seedOrder({
				number: `C-${i}`,
				totalCents: 1000 + i,
				createdAt: new Date(Date.now() - i * 60_000),
			})
		}
		const oneShot = await exportOrderHistoryCsv({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: true,
		})
		expect(oneShot.ok).toBe(true)

		const result = await runChunkedCsvExport({
			fetchChunk: async (cursor) => {
				const chunk = await exportOrderHistoryChunk({
					orgId,
					locationIds: null,
					query: {},
					includeCustomerPii: true,
					cursor: cursor ?? undefined,
					chunkRows: 3,
				})
				if (!chunk.ok) throw new Error(chunk.failure.code)
				return chunk.data
			},
			yieldTurn: async () => {},
		})
		expect(result.status).toBe('done')
		if (result.status !== 'done' || !oneShot.ok) return
		expect(result.rowCount).toBe(7)
		expect(await result.blob.text()).toBe(oneShot.data.csv)
	})

	it('cuts a chunked export at the row cap, keeps scope, and says so (#386)', async () => {
		for (let i = 0; i < 5; i += 1) {
			await seedOrder({
				number: `K-${i}`,
				locationId: i < 4 ? 'loc-1' : 'loc-2',
			})
		}
		const capped = await exportOrderHistoryChunk({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: false,
			chunkRows: 2,
			maxRows: 3,
		})
		if (!capped.ok) throw new Error('chunk failed')
		expect(capped.data.truncated).toBe(true)
		expect(capped.data.total).toBe(3)
		expect(capped.data.matching).toBe(5)
		const second = await exportOrderHistoryChunk({
			orgId,
			locationIds: null,
			query: {},
			includeCustomerPii: false,
			chunkRows: 2,
			maxRows: 3,
			cursor: capped.data.nextCursor!,
		})
		if (!second.ok) throw new Error('chunk failed')
		expect(second.data.rows).toHaveLength(1)
		expect(second.data.nextCursor).toBeNull()
		expect(second.data.footer?.flat().join(' ')).toContain('truncated to 3 rows')

		const scoped = await exportOrderHistoryChunk({
			orgId,
			locationIds: ['loc-2'],
			query: {},
			includeCustomerPii: false,
		})
		if (!scoped.ok) throw new Error('chunk failed')
		expect(scoped.data.matching).toBe(1)
		expect(scoped.data.header).not.toContain('Guest Name')
	})
})
