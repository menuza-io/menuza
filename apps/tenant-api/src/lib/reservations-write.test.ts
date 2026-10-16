import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvDayVersions,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from './http.ts'
import {
	hashIdempotencyPayload,
	withReservationWrite,
} from './reservations-write.ts'

const ORG_ID = 'clw9x0a12000008l00rsvw01'
const LOC_ID = 'loc_soho'
const DATE = '2026-06-15'

describe('withReservationWrite (VAL-FND-019)', () => {
	let dbDir: string

	beforeEach(async () => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-write-test-'))
		vi.stubEnv('TENANT_DB_DIR', dbDir)
		vi.stubEnv('DATA_REGION', 'us')
		await provisionTenantDb(ORG_ID)

		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvLocationSettings).values({
			locationId: LOC_ID,
			enabled: true,
			onlineEnabled: true,
			timeZone: 'America/New_York',
		})
		await db.insert(rsvAreas).values({
			id: 'area_main',
			locationId: LOC_ID,
			name: 'Main Dining',
		})
		await db.insert(rsvTables).values({
			id: 'tbl_1',
			locationId: LOC_ID,
			areaId: 'area_main',
			label: 'T1',
			minCovers: 1,
			maxCovers: 4,
		})
		await db.insert(rsvGuests).values({
			id: 'guest_1',
			firstName: 'Alex',
			lastName: 'Rivera',
			phoneE164: '+12125550199',
		})
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(ORG_ID)
		} catch {
			// ignore
		}
		fs.rmSync(dbDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('executes concurrent writes for the same org sequentially and increments rsv_day_versions atomically', async () => {
		const order: string[] = []

		const writeA = withReservationWrite(
			{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE] },
			async (_tx, helpers) => {
				order.push(`start:A:v${helpers.dayState?.dayVersion ?? 0}`)
				await new Promise((resolve) => setTimeout(resolve, 25))
				order.push('end:A')
				return 'A'
			},
		)

		const writeB = withReservationWrite(
			{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE] },
			async (_tx, helpers) => {
				order.push(`start:B:v${helpers.dayState?.dayVersion ?? 0}`)
				order.push('end:B')
				return 'B'
			},
		)

		const [resA, resB] = await Promise.all([writeA, writeB])
		expect(resA).toBe('A')
		expect(resB).toBe('B')
		expect(order).toEqual(['start:A:v0', 'end:A', 'start:B:v1', 'end:B'])

		const db = await getTenantDb(ORG_ID)
		const dayVersion = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.locationId, LOC_ID))
			.get()
		expect(dayVersion?.version).toBe(2)
	})

	it('replays idempotent retries without re-running the callback and rejects conflicting hashes with 409 idempotency_conflict', async () => {
		let runs = 0
		const payload1 = { locationId: LOC_ID, date: DATE, partySize: 2 }
		const hash1 = hashIdempotencyPayload(payload1)

		const first = await withReservationWrite(
			{
				orgId: ORG_ID,
				locationId: LOC_ID,
				dates: [DATE],
				scope: 'public:hold',
				idempotencyKey: 'idem-key-1',
				requestHash: hash1,
			},
			async () => {
				runs += 1
				return { holdId: 'hold_123', runs }
			},
		)
		expect(first).toEqual({ holdId: 'hold_123', runs: 1 })

		// Matching retry -> returns stored response without re-running callback or bumping day version again
		const second = await withReservationWrite(
			{
				orgId: ORG_ID,
				locationId: LOC_ID,
				dates: [DATE],
				scope: 'public:hold',
				idempotencyKey: 'idem-key-1',
				requestHash: hash1,
			},
			async () => {
				runs += 1
				return { holdId: 'hold_999', runs }
			},
		)
		expect(second).toEqual({ holdId: 'hold_123', runs: 1 })
		expect(runs).toBe(1)

		const db = await getTenantDb(ORG_ID)
		const dayVersion = await db
			.select()
			.from(rsvDayVersions)
			.where(eq(rsvDayVersions.locationId, LOC_ID))
			.get()
		expect(dayVersion?.version).toBe(1)

		// Conflicting payload with same key -> 409 idempotency_conflict
		const conflictingHash = hashIdempotencyPayload({
			locationId: LOC_ID,
			date: DATE,
			partySize: 6,
		})
		await expect(
			withReservationWrite(
				{
					orgId: ORG_ID,
					locationId: LOC_ID,
					dates: [DATE],
					scope: 'public:hold',
					idempotencyKey: 'idem-key-1',
					requestHash: conflictingHash,
				},
				async () => ({ holdId: 'never' }),
			),
		).rejects.toMatchObject({
			status: 409,
			code: 'idempotency_conflict',
		} satisfies Partial<HttpError>)
	})

	it('sweeps expired holds, pending payments, pending requests, and waitlist offers inside the transaction before loading dayState', async () => {
		const now = 1_750_000_000_000
		const db = await getTenantDb(ORG_ID)

		// 1. Expired hold + active occupancy on tbl_1
		await db.insert(rsvHolds).values({
			id: 'hold_exp',
			locationId: LOC_ID,
			tokenHash: 'hash_exp_1',
			businessDate: DATE,
			localStartMin: 1140,
			startAt: now + 3_600_000,
			endAt: now + 9_000_000,
			partySize: 2,
			status: 'active',
			expiresAt: now - 1_000,
		})
		await db.insert(rsvTableOccupancies).values({
			id: 'occ_hold_exp',
			locationId: LOC_ID,
			tableId: 'tbl_1',
			kind: 'hold',
			holdId: 'hold_exp',
			startAt: now + 3_600_000,
			endAt: now + 9_000_000,
			active: true,
		})

		// 2. Expired pending_payment reservation
		await db.insert(rsvReservations).values({
			id: 'res_pay_exp',
			locationId: LOC_ID,
			guestId: 'guest_1',
			confirmationCode: 'PAYEXP01',
			businessDate: DATE,
			localStartMin: 1200,
			timeZone: 'America/New_York',
			startAt: now + 10_000_000,
			endAt: now + 15_400_000,
			durationMin: 90,
			partySize: 2,
			status: 'pending_payment',
			paymentExpiresAt: now - 500,
		})

		// 3. Expired pending_approval reservation
		await db.insert(rsvReservations).values({
			id: 'res_req_exp',
			locationId: LOC_ID,
			guestId: 'guest_1',
			confirmationCode: 'REQEXP01',
			businessDate: DATE,
			localStartMin: 1260,
			timeZone: 'America/New_York',
			startAt: now + 20_000_000,
			endAt: now + 25_400_000,
			durationMin: 90,
			partySize: 4,
			status: 'pending_approval',
			requestDeadlineAt: now - 500,
		})

		// 4. Expired notified waitlist entry
		await db.insert(rsvWaitlistEntries).values({
			id: 'wl_exp',
			locationId: LOC_ID,
			businessDate: DATE,
			displayName: 'Sam Guest',
			partySize: 2,
			status: 'notified',
			responseDeadlineAt: now - 500,
		})

		// Now run withReservationWrite and insert a new occupancy on the exact same slot as hold_exp:
		// because sweepExpiredInTx deactivated occ_hold_exp first, the SQLite overlap trigger allows it!
		const result = await withReservationWrite(
			{
				orgId: ORG_ID,
				locationId: LOC_ID,
				dates: [DATE],
				now,
			},
			async (tx, helpers) => {
				expect(helpers.swept.expiredHolds).toBe(1)
				expect(helpers.swept.expiredPendingPayments).toBe(1)
				expect(helpers.swept.expiredPendingRequests).toBe(1)
				expect(helpers.swept.expiredWaitlistOffers).toBe(1)
				expect(helpers.dayState?.holds).toHaveLength(0)
				expect(helpers.dayState?.occupancies).toHaveLength(0)

				await tx.insert(rsvHolds).values({
					id: 'hold_new',
					locationId: LOC_ID,
					tokenHash: 'hash_new_1',
					businessDate: DATE,
					localStartMin: 1140,
					startAt: now + 3_600_000,
					endAt: now + 9_000_000,
					partySize: 2,
					status: 'active',
					expiresAt: now + 420_000,
				})
				await tx.insert(rsvTableOccupancies).values({
					id: 'occ_hold_new',
					locationId: LOC_ID,
					tableId: 'tbl_1',
					kind: 'hold',
					holdId: 'hold_new',
					startAt: now + 3_600_000,
					endAt: now + 9_000_000,
					active: true,
				})

				return 'booked_after_sweep'
			},
		)

		expect(result).toBe('booked_after_sweep')

		const [expHold, expPay, expReq, expWl] = await Promise.all([
			db.select().from(rsvHolds).where(eq(rsvHolds.id, 'hold_exp')).get(),
			db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, 'res_pay_exp'))
				.get(),
			db
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, 'res_req_exp'))
				.get(),
			db
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, 'wl_exp'))
				.get(),
		])

		expect(expHold?.status).toBe('expired')
		expect(expPay?.status).toBe('expired')
		expect(expReq?.status).toBe('expired')
		expect(expWl?.status).toBe('no_response')
	})
})
