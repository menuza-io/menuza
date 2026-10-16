import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvLocationSettings,
	rsvServices,
	rsvTableOccupancies,
	rsvTables,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOperatorReservation } from './rsv-booking-service.ts'

const TEST_DIR = fs.mkdtempSync(
	path.join(os.tmpdir(), 'rsv-book-concurrency-test-'),
)
process.env.TENANT_DB_DIR = TEST_DIR

const ORG_ID = 'org_rsv_concurrency'
const LOC_ID = 'loc_race'
const DATE = '2026-08-22'

describe('Reservations booking concurrency on real SQLite file (VAL-BOOK-006)', () => {
	beforeAll(async () => {
		await provisionTenantDb(ORG_ID)
		const db = await getTenantDb(ORG_ID)
		const now = Date.now()

		await db.insert(rsvLocationSettings).values({
			locationId: LOC_ID,
			timeZone: 'America/New_York',
			dayStartMin: 240,
			intervalMin: 15,
			freezeMin: 30,
			enabled: true,
			version: 1,
			updatedAt: now,
		})

		await db.insert(rsvAreas).values({
			id: 'area_only',
			locationId: LOC_ID,
			name: 'Single Table Room',
			sort: 0,
			onlineBookable: true,
			guestSelectable: true,
		})

		// Exactly ONE 2-top table exists at this location
		await db.insert(rsvTables).values({
			id: 'tbl_last_one',
			locationId: LOC_ID,
			areaId: 'area_only',
			label: 'T1',
			minCovers: 1,
			maxCovers: 2,
			onlineBookable: true,
			resetBufferMin: 15,
		})

		await db.insert(rsvServices).values({
			id: 'svc_dinner',
			locationId: LOC_ID,
			name: 'Dinner',
			daysMask: 127,
			firstSeatingMin: 17 * 60,
			lastSeatingMin: 21 * 60 + 30,
			endMin: 22 * 60,
			onlineEnabled: true,
			sort: 0,
		})
	})

	afterAll(async () => {
		await destroyTenantDb(ORG_ID)
		fs.rmSync(TEST_DIR, { recursive: true, force: true })
	})

	it('allows exactly 1 winner out of 10 concurrent bookings for the last 2-top table and replays winner idempotently', async () => {
		const attempts = Array.from({ length: 10 }, (_, idx) =>
			createOperatorReservation({
				orgId: ORG_ID,
				locationId: LOC_ID,
				actorId: `user_op_${idx}`,
				idempotencyKey: `race-key-${idx}`,
				input: {
					locationId: LOC_ID,
					date: DATE,
					time: '19:30',
					partySize: 2,
					guest: {
						firstName: `Runner`,
						lastName: `Number${idx}`,
						phone: `+1415555020${idx}`,
					},
				},
			}).then(
				(res) => ({ status: 'fulfilled' as const, idx, res }),
				(err) => ({ status: 'rejected' as const, idx, err }),
			),
		)

		const results = await Promise.all(attempts)
		const winners = results.filter((r) => r.status === 'fulfilled')
		const losers = results.filter((r) => r.status === 'rejected')

		expect(winners).toHaveLength(1)
		expect(losers).toHaveLength(9)
		for (const loser of losers) {
			expect((loser.err as { status?: number }).status).toBe(409)
		}

		const winner = winners[0]!
		const db = await getTenantDb(ORG_ID)
		const activeOccs = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.tableId, 'tbl_last_one'))
			.all()
		expect(activeOccs.filter((o) => o.active)).toHaveLength(1)

		// Replay with winner's Idempotency-Key returns the exact same reservation ID
		const replay = await createOperatorReservation({
			orgId: ORG_ID,
			locationId: LOC_ID,
			actorId: `user_op_${winner.idx}`,
			idempotencyKey: `race-key-${winner.idx}`,
			input: {
				locationId: LOC_ID,
				date: DATE,
				time: '19:30',
				partySize: 2,
				guest: {
					firstName: `Runner`,
					lastName: `Number${winner.idx}`,
					phone: `+1415555020${winner.idx}`,
				},
			},
		})
		expect(replay.reservation.id).toBe(winner.res.reservation.id)
	})
})
