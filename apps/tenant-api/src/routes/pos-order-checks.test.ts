import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	POS_CONTRACT_VERSION,
	posOrderRequestSchema,
} from '@repo/common/pos-orders'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posOrderRevisions,
	posOrders,
	posPayments,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { purgePosGuestNames, upsertPosOrder } from '../services/pos-service.ts'

describe('POS contract v12: phone delivery (#164), tax-exempt (#166), service charge (#397), split checks (#289)', () => {
	const orgId = `org-pos12-${crypto.randomUUID().slice(0, 8)}`
	const locId = 'loc-1'
	const deviceId = 'dev-pos-1'
	let tmpDir: string
	let prevDbDir: string | undefined

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menuza-pos12-'))
		prevDbDir = process.env.TENANT_DB_DIR
		process.env.TENANT_DB_DIR = tmpDir
		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		await db.insert(posDevices).values({
			id: deviceId,
			label: 'Counter 1',
			terminalCode: 'T1',
			locationId: locId,
			secretHash: 'hash',
			pairedBy: 'op-1',
			pairedAt: Date.now(),
		})
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		if (prevDbDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevDbDir
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	async function deviceRow() {
		const db = await getTenantDb(orgId)
		const [dev] = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.id, deviceId))
		return dev!
	}

	function baseOrder(overrides: Record<string, unknown> = {}) {
		const id = crypto.randomUUID()
		const nowIso = new Date().toISOString()
		return {
			id,
			number: '100',
			businessDate: '2026-11-25',
			revision: 1,
			status: 'paid',
			orderType: 'dine_in',
			driveThroughNote: null,
			orderSource: 'counter',
			customerPhone: null,
			pickupAt: null,
			pickupTimeZone: null,
			customerName: null,
			readyTextPhone: null,
			readyTextOptIn: false,
			tableLabel: 'Table 6',
			staff: { id: 'staff-1', name: 'Nadia S.' },
			signIn: 'online',
			voidedBy: null,
			voidedAt: null,
			voidReason: null,
			voidApprovedBy: null,
			locationId: locId,
			currency: 'USD',
			taxRatePercent: 10,
			taxInclusive: false,
			lines: [
				{
					id: 'line-1',
					itemId: 'item-1',
					name: 'Steak',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 2000,
					instructions: '',
					options: [],
				},
			],
			lineVoids: [],
			adjustments: [],
			discountApplications: [],
			totals: {
				subtotalCents: 2000,
				adjustmentCents: 0,
				taxCents: 200,
				tipCents: 0,
				totalCents: 2200,
			},
			payments: [
				{
					id: crypto.randomUUID(),
					method: 'card',
					amountCents: 2200,
					tenderedCents: 2200,
					at: nowIso,
					staff: { id: 'staff-1', name: 'Nadia S.' },
					reference: null,
					shiftId: null,
				},
			],
			refunds: [],
			fiscal: [],
			loyalty: null,
			catalogFetchedAt: nowIso,
			shiftId: null,
			createdAt: nowIso,
			...overrides,
		}
	}

	it('records a phone delivery order (#164), strips address from revisions, and clears it 30 days after close', async () => {
		expect(POS_CONTRACT_VERSION).toBe(12)
		const nowIso = new Date().toISOString()
		const payload = baseOrder({
			orderType: 'delivery',
			orderSource: 'phone',
			tableLabel: null,
			customerName: 'Omar Caller',
			customerPhone: '+15552223333',
			pickupTimeZone: 'America/New_York',
			delivery: {
				quoteToken: 'dq1.secret.sig',
				address: '742 Evergreen Terrace',
				unit: 'Apt 4B',
				notes: 'Ring bell',
				zoneId: 'z-1',
				zoneName: 'Downtown',
				feeCents: 400,
				lat: 40.71,
				lng: -74.0,
				postalCode: '10001',
				minOverrideApprovedBy: { id: 'mgr-1', name: 'Manager M.' },
			},
			totals: {
				subtotalCents: 2000,
				adjustmentCents: 0,
				taxCents: 200,
				tipCents: 0,
				totalCents: 2600,
			},
			payments: [
				{
					id: crypto.randomUUID(),
					method: 'card',
					amountCents: 2600,
					tenderedCents: 2600,
					at: nowIso,
					staff: { id: 'staff-1', name: 'Nadia S.' },
					reference: null,
					shiftId: null,
				},
			],
		})
		const parsed = posOrderRequestSchema.parse(payload)
		const db = await getTenantDb(orgId)
		const dev = await deviceRow()
		const applied = await upsertPosOrder(db, dev, parsed, {
			reviewReason: null,
			serverTotalCents: 2600,
			locationName: 'Downtown',
		})
		expect(applied.ok).toBe(true)

		// Stored on pos_orders with delivery fee and override
		const [stored] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, parsed.id))
		expect(stored?.orderType).toBe('delivery')
		expect(stored?.deliveryAddress).toBe('742 Evergreen Terrace')
		expect(stored?.deliveryFeeCents).toBe(400)
		expect(stored?.deliveryMinOverrideByStaffId).toBe('mgr-1')

		// Address is NEVER stored in pos_order_revisions
		const [rev] = await db
			.select()
			.from(posOrderRevisions)
			.where(eq(posOrderRevisions.orderId, parsed.id))
		const revJson = JSON.stringify(rev?.snapshot ?? {})
		expect(revJson).not.toContain('742 Evergreen Terrace')
		expect(revJson).not.toContain('Apt 4B')
		expect(revJson).not.toContain('dq1.secret.sig')

		// 30 days after close, purgePosGuestNames clears the delivery address
		const clearedCount = await purgePosGuestNames(
			db,
			Date.now() + 31 * 24 * 60 * 60 * 1000,
		)
		expect(clearedCount).toBe(1)
		const [afterPurge] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, parsed.id))
		expect(afterPurge?.deliveryAddress).toBeNull()
		expect(afterPurge?.deliveryUnit).toBeNull()
		expect(afterPurge?.deliveryNotes).toBeNull()
		expect(afterPurge?.deliveryLat).toBeNull()
		expect(afterPurge?.deliveryPostalCode).toBeNull()
		// Non-PII delivery fee and zone stay for reporting
		expect(afterPurge?.deliveryFeeCents).toBe(400)
		expect(afterPurge?.deliveryZoneId).toBe('z-1')
	})

	it('records tax-exempt (#166), service charge & removal audit (#397), and split-check lineShares (#289)', async () => {
		const nowIso = new Date().toISOString()
		const pay1Id = crypto.randomUUID()
		const pay2Id = crypto.randomUUID()
		// 12% dine-in service charge on $20.00 = $2.40 (240c), tax-exempt -> tax 0, total = 2240c
		const payload = baseOrder({
			partySize: 6,
			taxExempt: { ref: 'CERT-8821', org: 'City Youth Center' },
			serviceCharge: {
				label: 'Service charge',
				percentBp: 1200,
				amountCents: 240,
				taxCents: 0,
				taxable: false,
				autoGratuity: true,
				removed: null,
			},
			totals: {
				subtotalCents: 2000,
				adjustmentCents: 0,
				taxCents: 0,
				tipCents: 0,
				totalCents: 2240,
			},
			payments: [
				{
					id: pay1Id,
					method: 'card',
					amountCents: 1120,
					tenderedCents: 1120,
					at: nowIso,
					staff: { id: 'staff-1', name: 'Nadia S.' },
					reference: null,
					shiftId: null,
					checkNumber: 1,
					tipCents: 200,
					loyaltyCustomerId: 'cust-1',
					lineShares: [
						{ lineId: 'line-1', shareNum: 1, shareDen: 2, amountCents: 1000 },
					],
				},
				{
					id: pay2Id,
					method: 'cash',
					amountCents: 1120,
					tenderedCents: 1200,
					at: nowIso,
					staff: { id: 'staff-1', name: 'Nadia S.' },
					reference: null,
					shiftId: null,
					checkNumber: 2,
					tipCents: 150,
					loyaltyCustomerId: 'cust-2',
					lineShares: [
						{ lineId: 'line-1', shareNum: 1, shareDen: 2, amountCents: 1000 },
					],
				},
			],
		})
		const parsed = posOrderRequestSchema.parse(payload)
		const db = await getTenantDb(orgId)
		const dev = await deviceRow()
		await upsertPosOrder(db, dev, parsed, {
			reviewReason: null,
			serverTotalCents: 2240,
			locationName: 'Downtown',
		})

		const [stored] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, parsed.id))
		expect(stored?.taxExemptRef).toBe('CERT-8821')
		expect(stored?.taxExemptOrg).toBe('City Youth Center')
		expect(stored?.partySize).toBe(6)
		expect(stored?.serviceChargeCents).toBe(240)
		expect(stored?.serviceChargeLabel).toBe('Service charge')

		const pays = await db
			.select()
			.from(posPayments)
			.where(eq(posPayments.orderId, parsed.id))
		expect(pays).toHaveLength(2)
		const c1 = pays.find((p) => p.id === pay1Id)
		expect(c1?.checkNumber).toBe(1)
		expect(c1?.tipCents).toBe(200)
		expect(c1?.loyaltyCustomerId).toBe('cust-1')
		expect(c1?.lineShares).toEqual([
			{ lineId: 'line-1', shareNum: 1, shareDen: 2, amountCents: 1000 },
		])

		// Removing service charge records who and why
		const removedOrder = posOrderRequestSchema.parse(
			baseOrder({
				number: '101',
				serviceCharge: {
					label: 'Service charge',
					percentBp: 1200,
					amountCents: 0,
					taxCents: 0,
					taxable: false,
					autoGratuity: false,
					removed: {
						by: { id: 'mgr-2', name: 'Samir K.' },
						reason: 'Guest complaint about wait time',
						at: nowIso,
					},
				},
			}),
		)
		await upsertPosOrder(db, dev, removedOrder, {
			reviewReason: null,
			serverTotalCents: 2200,
			locationName: 'Downtown',
		})
		const [storedRemoved] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, removedOrder.id))
		expect(storedRemoved?.serviceChargeCents).toBe(0)
		expect(storedRemoved?.serviceChargeRemovedByStaffId).toBe('mgr-2')
		expect(storedRemoved?.serviceChargeRemovedByStaffName).toBe('Samir K.')
		expect(storedRemoved?.serviceChargeRemovedReason).toBe(
			'Guest complaint about wait time',
		)
	})
})
