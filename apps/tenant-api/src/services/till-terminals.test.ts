import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { posOrderRequestSchema } from '@repo/common/pos-orders'
import { buildClockSlipDoc } from '@repo/common/print-ticket'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posHeldUploads,
	posOrders,
	posShifts,
	printDevices,
	printJobs,
	provisionTenantDb,
	qrSettings,
	qrTabPayments,
	qrTabRefunds,
	qrTables,
	qrTabs,
	runTenantTransaction,
	staffAuditLog,
	staffMembers,
	timeEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bookTabProviderRefundInTx } from './order-refund-book.ts'
import {
	expireStaleAutoPrints,
	queueClockSlipPrint,
	queueShiftReportPrint,
} from './pos-auto-print.ts'
import {
	PairingKindMismatch,
	createReplacementCode,
	redeemPairingCode,
	upsertPosOrder,
} from './pos-service.ts'
import {
	assignStaffRole,
	createRole,
	deleteRole,
	withRoleCheck,
} from './pos-roles-service.ts'
import { closeForgottenTabs, payTabSplit } from './qr-tab-lifecycle.ts'

const hmacSecret = 'test-hmac-secret-that-is-long-enough-32'

describe('till terminals (#230 #173 #278 #424 #389)', () => {
	const orgId = 'org_till_terminals'
	let tmp: string
	let db: TenantDatabase

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'till-'))
		process.env.TENANT_DB_DIR = tmp
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tmp, { recursive: true, force: true })
	})

	function order(overrides: Record<string, unknown> = {}) {
		const nowIso = new Date().toISOString()
		const paymentId = crypto.randomUUID()
		return posOrderRequestSchema.parse({
			id: crypto.randomUUID(),
			number: '100',
			businessDate: '2026-11-26',
			revision: 1,
			status: 'paid',
			orderType: 'dine_in',
			orderSource: 'counter',
			customerPhone: null,
			customerName: null,
			tableLabel: '4',
			staff: { id: 'staff-1', name: 'Sam' },
			signIn: 'online',
			voidedBy: null,
			locationId: 'loc-1',
			currency: 'USD',
			lines: [
				{
					id: 'line-1',
					itemId: 'item-1',
					name: 'Tea',
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 500,
					instructions: '',
					options: [],
				},
			],
			totals: {
				subtotalCents: 500,
				adjustmentCents: 0,
				taxCents: 0,
				tipCents: 0,
				totalCents: 500,
			},
			payments: [
				{
					id: paymentId,
					method: 'card',
					amountCents: 500,
					tenderedCents: 500,
					at: nowIso,
					staff: { id: 'staff-1', name: 'Sam' },
					reference: null,
				},
			],
			catalogFetchedAt: nowIso,
			createdAt: nowIso,
			...overrides,
		})
	}

	it('flags a refund the role cannot do and keeps the sale (#230)', async () => {
		await db.insert(posDevices).values({
			id: 'dev-1',
			label: 'Front',
			terminalCode: 'T1',
			locationId: 'loc-1',
			secretHash: 'h',
			pairedBy: 'op',
			signInRequired: true,
		})
		await db.insert(staffMembers).values({
			id: 'staff-1',
			firstName: 'Sam',
			lastName: 'Lee',
		})
		const created = await createRole(db, {
			name: 'Server',
			permissions: ['take_orders', 'take_payment'],
			createdBy: 'op',
		})
		expect(created.ok).toBe(true)
		if (!created.ok) return
		await assignStaffRole(db, {
			staffId: 'staff-1',
			roleId: created.id,
			assignedBy: 'op',
		})
		const sale = order({ performedActions: ['refund'] })
		const [device] = await db.select().from(posDevices)
		const review = await withRoleCheck(db, device!, sale, {
			reviewReason: null,
			serverTotalCents: null,
			locationName: null,
		})
		expect(review.reviewReason).toBe('role_not_permitted')
		const stored = await upsertPosOrder(db, device!, sale, review)
		expect(stored.ok).toBe(true)
		const [row] = await db.select().from(posOrders)
		expect(row?.reviewReason).toBe('role_not_permitted')
		expect(row?.totalCents).toBe(500)
		const audit = await db.select().from(staffAuditLog)
		expect(audit.some((entry) => entry.action === 'pos.role.created')).toBe(
			true,
		)
		expect(audit.some((entry) => entry.action === 'pos.role.assigned')).toBe(
			true,
		)
		const removed = await deleteRole(db, {
			id: created.id,
			deletedBy: 'op',
		})
		expect(removed).toEqual({ ok: false, error: 'in_use' })
	})

	it('copies a kitchen tablet and refuses the old one (#173)', async () => {
		await db.insert(posDevices).values({
			id: 'old-1',
			label: 'Grill',
			terminalCode: 'K1',
			locationId: 'loc-1',
			scopeId: 'main',
			secretHash: 'old-secret',
			pairedBy: 'op',
			terminalKind: 'kitchen',
			permissionAllow: JSON.stringify(['kitchen_screen', 'view_kitchen']),
			deviceSettings: JSON.stringify({ kdsStationId: 'grill' }),
		})
		await db.insert(posHeldUploads).values({
			deviceId: 'old-1',
			error: 'offline',
			payload: '{}',
		})
		const code = await createReplacementCode(db, {
			orgId,
			deviceId: 'old-1',
			createdBy: 'op',
		})
		expect(code?.heldUploads).toBe(1)
		expect(code?.kind).toBe('kitchen')
		await expect(
			redeemPairingCode(db, orgId, code!.code, Date.now(), 'till'),
		).rejects.toBeInstanceOf(PairingKindMismatch)
		const [still] = await db
			.select()
			.from(posDevices)
			.where(eq(posDevices.id, 'old-1'))
		expect(still?.revokedAt).toBeNull()
		const paired = await redeemPairingCode(
			db,
			orgId,
			code!.code,
			Date.now(),
			'kitchen',
		)
		expect(paired?.device.label).toBe('Grill')
		expect(paired?.device.terminalCode).toBe('K1')
		const rows = await db.select().from(posDevices)
		const old = rows.find((row) => row.id === 'old-1')
		const next = rows.find((row) => row.id !== 'old-1')
		expect(old?.revokedAt).not.toBeNull()
		expect(next?.deviceSettings).toContain('grill')
		expect(next?.permissionAllow).toContain('kitchen_screen')
		expect(next?.terminalKind).toBe('kitchen')
	})

	it('prints the shift report when the setting is on and a fault does not block (#278)', async () => {
		await db.insert(posDevices).values({
			id: 'dev-1',
			label: 'Front',
			terminalCode: 'T1',
			locationId: 'loc-1',
			secretHash: 'h',
			pairedBy: 'op',
			printShiftOnClose: true,
			printClockSlip: true,
		})
		await db.insert(posShifts).values({
			id: 'shift-1',
			deviceId: 'dev-1',
			businessDate: '2026-11-26',
			revision: 1,
			status: 'closed',
			openedAt: Date.now() - 1000,
			openingFloatCents: 0,
		})
		await db.insert(printDevices).values({
			id: 'prn-1',
			locationId: 'loc-1',
			name: 'Counter',
			secretHash: 'p',
			protocol: 'star_cloudprnt',
			createdBy: 'op',
		})
		const printed = await queueShiftReportPrint(db, {
			deviceId: 'dev-1',
			locationId: 'loc-1',
			enabled: true,
			shiftId: 'shift-1',
			businessDate: '2026-11-26',
			terminal: 'Front',
			lines: [{ label: 'Counted', value: '0' }],
		})
		expect(printed.mode).toBe('queued')
		const jobs = await db.select().from(printJobs)
		expect(jobs).toHaveLength(1)
		await db
			.update(printJobs)
			.set({ createdAt: Date.now() - 11 * 60 * 1000 })
			.where(eq(printJobs.id, jobs[0]!.id))
		const expired = await expireStaleAutoPrints(db)
		expect(expired.dropped).toBe(1)
		const [shift] = await db.select().from(posShifts)
		expect(shift?.autoPrintStatus).toBe('dropped')

		const off = await queueShiftReportPrint(db, {
			deviceId: 'dev-1',
			locationId: 'loc-1',
			enabled: false,
			shiftId: 'shift-1',
			businessDate: '2026-11-26',
			terminal: 'Front',
			lines: [],
		})
		expect(off.mode).toBe('off')

		await db.insert(staffMembers).values({
			id: 'staff-slip',
			firstName: 'Sam',
			lastName: 'Lee',
		})
		await db.insert(timeEntries).values({
			id: 'entry-1',
			staffId: 'staff-slip',
			scopeId: 'main',
			clockInAt: Date.now(),
			timeZone: 'UTC',
			localDate: '2026-11-26',
		})
		const slip = buildClockSlipDoc({
			firstName: 'Sam',
			action: 'out',
			atLabel: '18:00',
			shiftTotalLabel: '8h 0m',
		})
		expect(JSON.stringify(slip)).not.toMatch(/pay rate|wage|salary|hourly/i)
		const queued = await queueClockSlipPrint(db, {
			deviceId: 'dev-1',
			enabled: true,
			entryId: 'entry-1',
			firstName: 'Sam',
			action: 'out',
			atLabel: '18:00',
			shiftTotalLabel: '8h 0m',
		})
		expect(queued.mode).toBe('queued')
		const quiet = await queueClockSlipPrint(db, {
			deviceId: 'dev-1',
			enabled: false,
			entryId: 'entry-1',
			firstName: 'Sam',
			action: 'in',
			atLabel: '09:00',
		})
		expect(quiet.mode).toBe('off')
	})

	it('closes an idle tab, skips a payment in progress, and splits 100 in three (#424 #389)', async () => {
		await db.insert(qrSettings).values({
			id: 'default',
			autoCloseHours: 2,
			splitMaxParts: 4,
		})
		await db.insert(qrTables).values([
			{ id: 'table-1', locationId: 'loc-1', label: '1' },
			{ id: 'table-2', locationId: 'loc-1', label: '2' },
			{ id: 'table-3', locationId: 'loc-1', label: '3' },
		])
		const hour = 60 * 60 * 1000
		const now = Date.now()
		await db.insert(qrTabs).values([
			{
				id: 'idle',
				tableId: 'table-1',
				locationId: 'loc-1',
				tableLabel: '1',
				tabNumber: 'T-1',
				openedDay: '2026-11-26',
				currency: 'USD',
				totalCents: 100,
				status: 'open',
				openedAt: now - 5 * hour,
				lastRoundAt: now - 3 * hour,
			},
			{
				id: 'paying',
				tableId: 'table-2',
				locationId: 'loc-1',
				tableLabel: '2',
				tabNumber: 'T-2',
				openedDay: '2026-11-26',
				currency: 'USD',
				totalCents: 100,
				status: 'open',
				paymentStatus: 'pending',
				paymentSessionId: 'sess-live',
				openedAt: now - 5 * hour,
			},
			{
				id: 'split',
				tableId: 'table-3',
				locationId: 'loc-1',
				tableLabel: '3',
				tabNumber: 'T-3',
				openedDay: '2026-11-26',
				currency: 'USD',
				totalCents: 100,
				status: 'open',
			},
		])
		const closed = await closeForgottenTabs(db, { now })
		expect(closed.closed).toBe(1)
		expect(closed.skipped).toBe(1)
		const [idle] = await db
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, 'idle'))
		expect(idle?.status).toBe('closed')
		expect(idle?.closedByActor).toBe('auto')
		const [paying] = await db
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, 'paying'))
		expect(paying?.status).toBe('open')

		const first = await payTabSplit(db, {
			tabId: 'split',
			parts: 3,
			sessionId: 's1',
			processor: 'connect',
		})
		expect(first.ok).toBe(true)
		if (!first.ok) return
		expect(first.closed).toBe(false)
		expect(first.amounts).toEqual([33, 33, 34])
		const second = await payTabSplit(db, {
			tabId: 'split',
			parts: 3,
			sessionId: 's2',
			processor: 'connect',
		})
		expect(second.ok && second.closed).toBe(false)
		const failed = await payTabSplit(db, {
			tabId: 'split',
			parts: 3,
			sessionId: 's-fail',
			processor: 'connect',
			ok: false,
		})
		expect(failed.ok && failed.closed).toBe(false)
		const third = await payTabSplit(db, {
			tabId: 'split',
			parts: 3,
			sessionId: 's3',
			processor: 'connect',
		})
		expect(third.ok && third.closed).toBe(true)
		const payments = await db
			.select()
			.from(qrTabPayments)
			.where(eq(qrTabPayments.tabId, 'split'))
		const succeeded = payments.filter((row) => row.splitStatus === 'succeeded')
		expect(succeeded.reduce((sum, row) => sum + row.amountCents, 0)).toBe(100)
		const last = succeeded.find((row) => row.amountCents === 34)!
		await runTenantTransaction(db, async (tx) => {
			const [tab] = await tx
				.select()
				.from(qrTabs)
				.where(eq(qrTabs.id, 'split'))
			const booked = await bookTabProviderRefundInTx(tx, tab!, {
				amount: { amountCents: 34 },
				note: null,
				idempotencyKey: 'refund-last',
				origin: 'operator',
				actorId: 'op',
				now,
				tabPaymentId: last.id,
			})
			expect(booked.ok).toBe(true)
		})
		const refunds = await db.select().from(qrTabRefunds)
		expect(refunds).toHaveLength(1)
		expect(refunds[0]?.tabPaymentId).toBe(last.id)
		expect(refunds[0]?.amountCents).toBe(34)
		const untouched = await db
			.select()
			.from(qrTabPayments)
			.where(eq(qrTabPayments.tabId, 'split'))
		expect(untouched.filter((row) => row.amountCents === 33)).toHaveLength(2)
	})
})
