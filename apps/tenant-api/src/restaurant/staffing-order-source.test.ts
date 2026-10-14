import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { organizationCatalog } from '@repo/reports'
import { isStaffingReportSubject } from '@repo/reports/token'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { loadLaborSettings } from '../services/labor-data.ts'
import {
	getOrderSource,
	registerOrderSource,
} from '../services/order-source.ts'
import {
	registerRestaurantOrderSource,
	restaurantOrderSource,
} from './staffing-order-source.ts'
import {
	activeReportCatalog,
	restaurantReportCatalog,
} from './staffing-report-catalog.ts'

const orgId = 'clw9x0a12000008l00staffsrc1'
const LOC_A = 'loc-a'
const LOC_B = 'loc-b'
// 2026-03-02 (a Monday) 12:00 UTC.
const NOON = Date.UTC(2026, 2, 2, 12, 0, 0) / 1000
const BUCKET = 15 * 60

describe('restaurant order source', () => {
	let tempDir: string
	let db: TenantDatabase
	let sequence = 0

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-source-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
	})

	afterEach(async () => {
		registerOrderSource(null)
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function insert(
		values: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		sequence += 1
		await db.insert(restaurantOrders).values({
			orgId,
			number: `n-${sequence}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC_A,
			locationName: '{"en":"A"}',
			contactName: 'Guest',
			contactPhone: '+15550009999',
			currency: 'usd',
			subtotalCents: 1000,
			taxCents: 100,
			tipCents: 150,
			totalCents: 1250,
			lines: [],
			idempotencyKey: `k-${sequence}`,
			requestHash: 'h',
			receiptTokenHash: `r-${sequence}`,
			createdAt: new Date(NOON * 1000),
			...values,
		})
	}

	const window = {
		fromSeconds: NOON - 3600,
		toSeconds: NOON + 3600,
		alignSeconds: 0,
	}

	it('buckets counted orders of one location by currency and fulfillment', async () => {
		await insert()
		await insert({ subtotalCents: 500, tipCents: 50 })
		await insert({ fulfillment: 'delivery', currency: 'sar' })
		await insert({ locationId: LOC_B })
		// Left out: cancelled, unpaid online, outside the window.
		await insert({ status: 'cancelled' })
		await insert({ paymentMethod: 'online', paymentStatus: 'pending' })
		await insert({ createdAt: new Date((NOON + 7200) * 1000) })

		const rows = await restaurantOrderSource.loadBuckets(db, LOC_A, window)
		const bucket = Math.floor(NOON / BUCKET)
		expect(rows.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
			{
				bucket,
				currency: 'SAR',
				fulfillment: 'delivery',
				orders: 1,
				subtotalMinor: 1000,
				tipMinor: 150,
			},
			{
				bucket,
				currency: 'USD',
				fulfillment: 'pickup',
				orders: 2,
				subtotalMinor: 1500,
				tipMinor: 200,
			},
		])
		expect(
			await restaurantOrderSource.loadBuckets(db, 'nobody', window),
		).toEqual([])
	})

	it('counts booked orders by local hour for a scheduled window', async () => {
		const scheduled = new Date((NOON + 1800) * 1000)
		await insert({ scheduledFor: scheduled })
		await insert({ scheduledFor: scheduled })
		await insert({ scheduledFor: scheduled, locationId: LOC_B })
		await insert({ scheduledFor: scheduled, status: 'cancelled' })
		await insert()

		const booked = await restaurantOrderSource.loadBooked(db, LOC_A, {
			fromSeconds: NOON,
			toSeconds: NOON + 7200,
			timeZone: 'UTC',
		})
		expect(booked).toEqual([{ date: '2026-03-02', hour: 12, orders: 2 }])
	})

	it('makes online orders the starting sales source once registered', async () => {
		expect((await loadLaborSettings(db, LOC_A)).salesSource).toBe('manual')
		expect(getOrderSource()).toBeNull()
		registerRestaurantOrderSource()
		expect(getOrderSource()).toBe(restaurantOrderSource)
		expect((await loadLaborSettings(db, LOC_A)).salesSource).toBe(
			'online_orders',
		)
	})

	it('words the report catalog by location only for restaurants', () => {
		expect(activeReportCatalog()).toBe(organizationCatalog)
		registerRestaurantOrderSource()
		expect(activeReportCatalog()).toBe(restaurantReportCatalog)
		const text = JSON.stringify(
			restaurantReportCatalog.subjects.filter((s) =>
				isStaffingReportSubject(s.id),
			),
		)
		expect(text).not.toMatch(/workplace/i)
		expect(text).toMatch(/location/i)
	})
})
