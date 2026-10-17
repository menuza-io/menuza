import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	rsvHolds,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	dateAhead,
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import { createHold } from './rsv-hold-service.ts'
import { bookFromHold } from './rsv-public-booking-service.ts'

const TEST_DIR = fs.mkdtempSync(
	path.join(os.tmpdir(), 'rsv-public-concurrency-test-'),
)
process.env.TENANT_DB_DIR = TEST_DIR

const ORG_ID = 'org_rsv_public_race'
const DAY = dateAhead(12)

function tokenHash(n: number | string) {
	return `hash_${n}`.padEnd(64, '0')
}

function bookingInput(n: number) {
	return {
		guest: {
			firstName: `Racer${n}`,
			lastName: 'Guest',
			phone: `+1415555${String(3000 + n)}`,
			email: null,
			locale: 'en',
		},
		smsOptIn: false,
		marketing: false,
	}
}

async function holdFor(n: number, localMin = 19 * 60) {
	return createHold({
		orgId: ORG_ID,
		locationId: PUBLIC_LOC,
		slot: { date: DAY, localMin, partySize: 2 },
		tokenHash: tokenHash(n),
		source: 'web',
		ipHash: `ip_${n}`,
	})
}

describe('Public booking concurrency on a real SQLite file', () => {
	beforeAll(async () => {
		await seedPublicOrg(ORG_ID, { seedContext: false })
		const db = await getTenantDb(ORG_ID)
		// One table can seat a party of two: the last-table race.
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_4'))
		await db.delete(rsvTables).where(eq(rsvTables.id, 'tbl_pub_12'))
	})

	afterAll(async () => {
		await destroyTenantDb(ORG_ID)
		fs.rmSync(TEST_DIR, { recursive: true, force: true })
	})

	it('lets exactly one of ten concurrent holds take the last table', async () => {
		const attempts = Array.from({ length: 10 }, (_, i) =>
			holdFor(i).then(
				() => 'ok' as const,
				(error: { status?: number; code?: string }) => error,
			),
		)
		const results = await Promise.all(attempts)
		const winners = results.filter((r) => r === 'ok')
		const losers = results.filter((r) => r !== 'ok') as Array<{
			status?: number
			code?: string
		}>
		expect(winners).toHaveLength(1)
		for (const loser of losers) {
			expect(loser.status).toBe(409)
			expect(loser.code).toBe('slot_unavailable')
		}
		const db = await getTenantDb(ORG_ID)
		const active = await db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.tableId, 'tbl_pub_2'),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all()
		expect(active).toHaveLength(1)
		const liveHolds = await db
			.select()
			.from(rsvHolds)
			.where(eq(rsvHolds.status, 'active'))
			.all()
		expect(liveHolds).toHaveLength(1)
	})

	it('converts one hold exactly once under concurrent bookings', async () => {
		const db = await getTenantDb(ORG_ID)
		const hold = await holdFor('convert', 21 * 60 - 30).catch(() => null)
		expect(hold).not.toBeNull()
		const attempts = Array.from({ length: 8 }, (_, i) =>
			bookFromHold({
				orgId: ORG_ID,
				holdTokenHash: tokenHash('convert'),
				input: bookingInput(i),
				client: 'web',
				channel: 'online',
				customerId: null,
				ipHash: `ip_convert_${i}`,
				idempotencyKey: `convert-key-${i}-abcdefgh`,
				requestHash: `request_hash_${i}`,
			}).then(
				(value) => ({ ok: true as const, value }),
				(error: { status?: number }) => ({ ok: false as const, error }),
			),
		)
		const results = await Promise.all(attempts)
		const winners = results.filter((r) => r.ok)
		expect(winners).toHaveLength(1)
		for (const loser of results.filter((r) => !r.ok)) {
			expect([409, 410]).toContain(
				(loser as { error: { status?: number } }).error.status,
			)
		}
		const rows = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.businessDate, DAY))
			.all()
		expect(rows.filter((r) => r.localStartMin === 21 * 60 - 30)).toHaveLength(1)
		const holdRow = await db
			.select()
			.from(rsvHolds)
			.where(eq(rsvHolds.tokenHash, tokenHash('convert')))
			.get()
		expect(holdRow!.status).toBe('converted')
	})

	it('replays the winner idempotently while the rest are refused', async () => {
		const hold = await createHold({
			orgId: ORG_ID,
			locationId: PUBLIC_LOC,
			slot: { date: dateAhead(13), localMin: 18 * 60, partySize: 2 },
			tokenHash: tokenHash('replay'),
			source: 'web',
			ipHash: 'ip_replay',
		})
		expect(hold.holdId).toBeTruthy()
		const params = {
			orgId: ORG_ID,
			holdTokenHash: tokenHash('replay'),
			input: bookingInput(99),
			client: 'web',
			channel: 'online' as const,
			customerId: null,
			ipHash: 'ip_replay',
			idempotencyKey: 'replay-key-abcdefgh',
			requestHash: 'request_hash_replay',
		}
		const first = await bookFromHold(params)
		const replays = await Promise.all(
			Array.from({ length: 5 }, () => bookFromHold(params)),
		)
		for (const replay of replays) {
			expect(replay.reservationId).toBe(first.reservationId)
		}
		const db = await getTenantDb(ORG_ID)
		const rows = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.businessDate, dateAhead(13)))
			.all()
		expect(rows).toHaveLength(1)
	})
})
