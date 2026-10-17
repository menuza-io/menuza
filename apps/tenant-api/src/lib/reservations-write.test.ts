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
	withSetupWrite,
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

	it('maps rsv_table_occupancies overlap trigger aborts to 409 conflict', async () => {
		const now = 1_750_000_000_000

		await withReservationWrite(
			{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE], now },
			async (tx) => {
				await tx.insert(rsvHolds).values({
					id: 'hold_occ_1',
					locationId: LOC_ID,
					tokenHash: 'hash_occ_1',
					businessDate: DATE,
					localStartMin: 1140,
					startAt: 10_000,
					endAt: 20_000,
					partySize: 2,
					status: 'active',
					expiresAt: now + 420_000,
				})
				await tx.insert(rsvTableOccupancies).values({
					id: 'occ_1',
					locationId: LOC_ID,
					tableId: 'tbl_1',
					kind: 'hold',
					holdId: 'hold_occ_1',
					startAt: 10_000,
					endAt: 20_000,
					active: true,
					overbook: false,
				})
			},
		)

		await expect(
			withReservationWrite(
				{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE], now },
				async (tx) => {
					await tx.insert(rsvHolds).values({
						id: 'hold_occ_2',
						locationId: LOC_ID,
						tokenHash: 'hash_occ_2',
						businessDate: DATE,
						localStartMin: 1140,
						startAt: 15_000,
						endAt: 25_000,
						partySize: 2,
						status: 'active',
						expiresAt: now + 420_000,
					})
					await tx.insert(rsvTableOccupancies).values({
						id: 'occ_2',
						locationId: LOC_ID,
						tableId: 'tbl_1',
						kind: 'hold',
						holdId: 'hold_occ_2',
						startAt: 15_000,
						endAt: 25_000,
						active: true,
						overbook: false,
					})
				},
			),
		).rejects.toMatchObject({
			status: 409,
			code: 'conflict',
		} satisfies Partial<HttpError>)
	})

	it("withSetupWrite locks on the org id so it serializes with that org's reservation writes", async () => {
		const db = await getTenantDb(ORG_ID)
		const order: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})

		const setup = withSetupWrite(db, async () => {
			order.push('start:setup')
			await gate
			order.push('end:setup')
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		const reservation = withReservationWrite(
			{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE] },
			async () => {
				order.push('start:reservation')
			},
		)
		await new Promise((resolve) => setTimeout(resolve, 25))
		expect(order).toEqual(['start:setup'])
		release()
		await Promise.all([setup, reservation])
		expect(order).toEqual(['start:setup', 'end:setup', 'start:reservation'])
	})

	it("withSetupWrite does not serialize against another org's writes", async () => {
		const otherOrg = 'clw9x0a12000008l00rsvw02'
		await provisionTenantDb(otherOrg)
		try {
			const db = await getTenantDb(ORG_ID)
			let release!: () => void
			const gate = new Promise<void>((resolve) => {
				release = resolve
			})
			const setup = withSetupWrite(db, async () => {
				await gate
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			let otherRan = false
			await withReservationWrite({ orgId: otherOrg }, async () => {
				otherRan = true
			})
			expect(otherRan).toBe(true)
			release()
			await setup
		} finally {
			await destroyTenantDb(otherOrg)
		}
	})

	it('withSetupWrite rolls back every row when the mutation fails part-way', async () => {
		const db = await getTenantDb(ORG_ID)
		await expect(
			withSetupWrite(db, async (tx) => {
				await tx.insert(rsvAreas).values({
					id: 'area_partial',
					locationId: LOC_ID,
					name: 'Partial',
				})
				await tx.insert(rsvTables).values({
					id: 'tbl_partial',
					locationId: LOC_ID,
					areaId: 'area_partial',
					label: 'P1',
					minCovers: 1,
					maxCovers: 2,
				})
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')

		expect(
			await db
				.select()
				.from(rsvAreas)
				.where(eq(rsvAreas.id, 'area_partial'))
				.all(),
		).toEqual([])
		expect(
			await db
				.select()
				.from(rsvTables)
				.where(eq(rsvTables.id, 'tbl_partial'))
				.all(),
		).toEqual([])
	})
})
