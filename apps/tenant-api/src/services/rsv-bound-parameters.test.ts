import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	registerTenantDb,
	rsvAreas,
	rsvGuests,
	rsvLocationSettings,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
	schema as tenantSchema,
	unregisterTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertRowsInChunks } from '../lib/chunked-in.ts'
import {
	createBlockForLocation,
	createSectionLayoutForLocation,
} from './rsv-setup-service.ts'

/**
 * Durable Object SQLite rejects statements with more than 100 bound
 * parameters. Libsql accepts them, so these tests wrap the driver and refuse
 * the same statements the Durable Object would.
 */
const MAX_PARAMS = 100

function enforceParamLimit(client: Client): { maxSeen: () => number } {
	let max = 0
	const check = (stmt: unknown) => {
		const args = (stmt as { args?: unknown[] | Record<string, unknown> })?.args
		const count = Array.isArray(args)
			? args.length
			: args
				? Object.keys(args).length
				: 0
		max = Math.max(max, count)
		if (count > MAX_PARAMS) {
			throw new Error(
				`too many SQL variables: ${count} bound parameters (limit ${MAX_PARAMS})`,
			)
		}
	}
	const wrap = (target: {
		execute: (...a: never[]) => unknown
		batch?: (...a: never[]) => unknown
	}) => {
		const execute = target.execute.bind(target)
		target.execute = (async (stmt: unknown, ...rest: unknown[]) => {
			check(stmt)
			return (execute as (...a: unknown[]) => unknown)(stmt, ...rest)
		}) as never
		if (target.batch) {
			const batch = target.batch.bind(target)
			target.batch = (async (stmts: unknown[], ...rest: unknown[]) => {
				for (const s of stmts) check(s)
				return (batch as (...a: unknown[]) => unknown)(stmts, ...rest)
			}) as never
		}
	}
	wrap(client as never)
	const transaction = client.transaction.bind(client)
	client.transaction = (async (...args: Parameters<Client['transaction']>) => {
		const tx = await transaction(...args)
		wrap(tx as never)
		return tx
	}) as Client['transaction']
	return { maxSeen: () => max }
}

const ORG = 'org_bound_params'
const LOC = 'loc_bound'
let tempDir: string
let db: TenantDatabase
let rawClient: Client
let limit: { maxSeen: () => number }

function useTenantDb() {
	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-bound-params-'))
		vi.stubEnv('TENANT_DB_DIR', tempDir)
		vi.stubEnv('DATA_REGION', 'us')
		await provisionTenantDb(ORG)
		const client = createClient({
			url: `file:${path.join(tempDir, `tenant_${ORG}.db`)}`,
		})
		rawClient = client
		limit = enforceParamLimit(client)
		db = drizzle(client, { schema: tenantSchema }) as unknown as TenantDatabase
		registerTenantDb(ORG, db)
		db = await getTenantDb(ORG)

		await db.insert(rsvLocationSettings).values({
			locationId: LOC,
			timeZone: 'UTC',
			dayStartMin: 0,
			intervalMin: 30,
			enabled: true,
			onlineEnabled: true,
			version: 1,
		})
		await db
			.insert(rsvAreas)
			.values({ id: 'area_big', locationId: LOC, name: 'Big room', sort: 0 })
		await insertRowsInChunks(
			rsvTables,
			Array.from({ length: 150 }, (_, i) => {
				const id = `t${String(i).padStart(3, '0')}`
				return {
					id: `tbl_${id}`,
					locationId: LOC,
					areaId: 'area_big',
					label: id,
					minCovers: 1,
					maxCovers: 4,
					resetBufferMin: 0,
				}
			}),
			(chunk) => db.insert(rsvTables).values(chunk),
		)
	})

	afterEach(async () => {
		unregisterTenantDb(ORG, db)
		rawClient.close()
		await destroyTenantDb(ORG)
		fs.rmSync(tempDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})
}

describe('statements stay under the Durable Object bound-parameter limit', () => {
	useTenantDb()
	it('the test driver rejects a statement with more than 100 parameters', async () => {
		const client = createClient({ url: 'file::memory:' })
		enforceParamLimit(client)
		const marks = Array.from({ length: 101 }, () => '?').join(',')
		await expect(
			client.execute({
				sql: `select ${marks}`,
				args: Array.from({ length: 101 }, (_, i) => i),
			}),
		).rejects.toThrow(/too many SQL variables/)
	})

	it('saves a section layout whose section holds 100 tables', async () => {
		const tableIds = Array.from(
			{ length: 100 },
			(_, i) => `tbl_t${String(i).padStart(3, '0')}`,
		)
		const created = await createSectionLayoutForLocation(db, {
			locationId: LOC,
			actorId: 'usr_test',
			name: 'Everything',
			sections: [{ name: 'All', colorToken: 'blue', tableIds }],
		})
		expect(created.layout.sections[0]!.tableIds).toHaveLength(100)
		expect(limit.maxSeen()).toBeLessThanOrEqual(MAX_PARAMS)
	})

	it('blocks an area of 150 tables that holds more than 100 bookings', async () => {
		const base = Date.parse('2031-05-04T18:00:00Z')
		await db.insert(rsvGuests).values({
			id: 'guest_bp',
			firstName: 'Big',
			lastName: 'Party',
			phoneE164: '+12125550111',
		})
		for (let i = 0; i < 120; i++) {
			const tableId = `tbl_t${String(i).padStart(3, '0')}`
			const id = `res_bp_${i}`
			await db.insert(rsvReservations).values({
				id,
				locationId: LOC,
				guestId: 'guest_bp',
				confirmationCode: `BP${String(i).padStart(6, '0')}`,
				businessDate: '2031-05-04',
				localStartMin: 1140,
				timeZone: 'UTC',
				startAt: base + 3_600_000,
				endAt: base + 3_600_000 + 5_400_000,
				durationMin: 90,
				partySize: 2,
				status: 'booked',
				assignment: 'soft',
			})
			await db.insert(rsvTableOccupancies).values({
				id: `occ_bp_${i}`,
				locationId: LOC,
				tableId,
				kind: 'reservation',
				reservationId: id,
				startAt: base + 3_600_000,
				endAt: base + 3_600_000 + 5_400_000,
				active: true,
			})
		}
		const created = await createBlockForLocation(db, {
			actorId: 'usr_test',
			locationId: LOC,
			areaId: 'area_big',
			businessDate: '2031-05-04',
			startAt: base,
			endAt: base + 6 * 3_600_000,
			reason: 'Private event',
		})
		expect(created).toBeTruthy()
		const occupied = await db
			.select({ id: rsvTableOccupancies.id })
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.kind, 'block'))
			.all()
		expect(occupied.length).toBe(150)
		expect(limit.maxSeen()).toBeLessThanOrEqual(MAX_PARAMS)
	})
})

describe('insertRowsInChunks', () => {
	it('keeps every multi-row insert under the parameter budget', async () => {
		const rows = Array.from({ length: 250 }, (_, i) => ({
			id: `r${i}`,
			a: 1,
			b: 2,
			c: 3,
		}))
		const sizes: number[] = []
		await insertRowsInChunks(rsvTables, rows, async (chunk) => {
			sizes.push(chunk.length)
		})
		expect(sizes.reduce((n, s) => n + s, 0)).toBe(250)
		// rsv_tables has 19 columns: 4 rows x 19 = 76 parameters per statement.
		expect(Math.max(...sizes)).toBe(4)
	})
})
