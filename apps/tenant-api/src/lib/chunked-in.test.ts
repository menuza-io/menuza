import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvGuests,
	rsvLocationSettings,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chunkIds, MAX_IN_CHUNK, queryInChunks } from './chunked-in.ts'
import { withReservationWrite } from './reservations-write.ts'
import { serializeReservationsForBook } from '../services/rsv-day-feed-service.ts'

const ORG_ID = 'clw9x0a12000008l00rsvc001'
const LOC_ID = 'loc_chunk'
const DATE = '2026-06-15'
const DO_PARAM_LIMIT = 100

describe('chunked IN lists', () => {
	it('never emits a chunk above the bound and preserves every id', () => {
		const ids = Array.from({ length: 401 }, (_, i) => `id_${i}`)
		const chunks = chunkIds(ids)
		expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(
			MAX_IN_CHUNK,
		)
		expect(chunks.flat()).toEqual(ids)
		expect(chunkIds([])).toEqual([])
	})

	it('merges rows from every chunk', async () => {
		const seen: number[] = []
		const rows = await queryInChunks(
			Array.from({ length: 200 }, (_, i) => i),
			async (chunk) => {
				seen.push(chunk.length)
				return chunk
			},
		)
		expect(rows).toHaveLength(200)
		expect(seen).toEqual([90, 90, 20])
	})
})

describe('reservation reads and writes stay under 100 bound parameters', () => {
	let dbDir: string

	beforeEach(async () => {
		dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-chunk-test-'))
		vi.stubEnv('TENANT_DB_DIR', dbDir)
		vi.stubEnv('DATA_REGION', 'us')
		await provisionTenantDb(ORG_ID)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG_ID).catch(() => {})
		fs.rmSync(dbDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('sweeps, reconciles and serializes 160 reservations', async () => {
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvLocationSettings).values({
			locationId: LOC_ID,
			enabled: true,
			onlineEnabled: true,
			timeZone: 'America/New_York',
		})
		await db
			.insert(rsvAreas)
			.values({ id: 'area_c', locationId: LOC_ID, name: 'Main' })
		await db.insert(rsvTables).values({
			id: 'tbl_c',
			locationId: LOC_ID,
			areaId: 'area_c',
			label: 'T1',
			minCovers: 1,
			maxCovers: 4,
		})
		const now = Date.parse('2026-06-15T12:00:00Z')
		for (let i = 0; i < 160; i++) {
			await db.insert(rsvGuests).values({
				id: `g_${i}`,
				firstName: 'G',
				lastName: String(i),
				phoneE164: `+1212555${String(1000 + i)}`,
			})
			await db.insert(rsvReservations).values({
				id: `r_${i}`,
				locationId: LOC_ID,
				guestId: `g_${i}`,
				confirmationCode: `CODE${String(i).padStart(4, '0')}`,
				businessDate: DATE,
				localStartMin: 1200,
				timeZone: 'America/New_York',
				startAt: now + 10_000_000 + i,
				endAt: now + 15_000_000 + i,
				durationMin: 90,
				partySize: 2,
				status: 'pending_payment',
				paymentExpiresAt: now - 500,
			})
			await db.insert(rsvTableOccupancies).values({
				locationId: LOC_ID,
				tableId: 'tbl_c',
				kind: 'reservation',
				reservationId: `r_${i}`,
				startAt: now + 10_000_000 + i,
				endAt: now + 15_000_000 + i,
				active: true,
				overbook: true,
			})
		}

		// Reject any statement with more than 100 bound parameters, the way a
		// Durable Object's SQLite does.
		const client = (
			db as unknown as {
				$client: {
					execute: (...a: unknown[]) => unknown
					transaction: (...a: unknown[]) => Promise<{
						execute: (...a: unknown[]) => unknown
					}>
				}
			}
		).$client
		const check = (stmt: unknown) => {
			const args = (stmt as { args?: unknown[] })?.args
			if (Array.isArray(args) && args.length > DO_PARAM_LIMIT) {
				throw new Error(`too many SQL variables (${args.length})`)
			}
		}
		const execute = client.execute.bind(client)
		const transaction = client.transaction.bind(client)
		client.execute = (stmt: unknown, ...rest: unknown[]) => {
			check(stmt)
			return execute(stmt, ...rest)
		}
		client.transaction = async (...a: unknown[]) => {
			const tx = await transaction(...a)
			const txExecute = tx.execute.bind(tx)
			tx.execute = (stmt: unknown, ...rest: unknown[]) => {
				check(stmt)
				return txExecute(stmt, ...rest)
			}
			return tx
		}

		await withReservationWrite(
			{ orgId: ORG_ID, locationId: LOC_ID, dates: [DATE], now },
			async (_tx, helpers) => {
				expect(helpers.swept.expiredPendingPayments).toBe(160)
			},
		)

		const rows = await db.select().from(rsvReservations).all()
		expect(rows).toHaveLength(160)
		const serialized = await serializeReservationsForBook(db, rows)
		expect(serialized).toHaveLength(160)
	})
})
