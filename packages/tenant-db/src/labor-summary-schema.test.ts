import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from './schema.ts'
import {
	laborScopeSettings,
	salesManualEntries,
	tipPoolSettings,
} from './schema.ts'

describe('labor summary schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-labor-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		db = drizzle(client, { schema })
		const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
		await migrate(db, { migrationsFolder: path.join(pkgRoot, 'drizzle') })
	})

	afterEach(() => {
		try {
			client.close()
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	it('starts a scope on the defaults: manual sales, no standards', async () => {
		const [row] = await db
			.insert(laborScopeSettings)
			.values({ scopeId: 'loc1' })
			.returning()
		expect(row).toMatchObject({
			scopeId: 'loc1',
			salesSource: 'manual',
			ordersPerLaborHour: {},
		})
	})

	it('keeps one sales row per scope and day, but lets another scope share the day', async () => {
		const entry = {
			scopeId: 'loc1',
			businessDate: '2026-03-02',
			netSalesMinor: 120_000,
			currency: 'USD',
		}
		await db.insert(salesManualEntries).values(entry)
		await expect(
			db.insert(salesManualEntries).values({ ...entry, netSalesMinor: 1 }),
		).rejects.toThrow()
		await db.insert(salesManualEntries).values({ ...entry, scopeId: 'loc2' })
		const rows = await db.select().from(salesManualEntries)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ source: 'manual', note: null })
	})

	it('upserts a day in place', async () => {
		const entry = {
			scopeId: 'loc1',
			businessDate: '2026-03-02',
			netSalesMinor: 100,
			currency: 'USD',
		}
		await db.insert(salesManualEntries).values(entry)
		await db
			.insert(salesManualEntries)
			.values({ ...entry, netSalesMinor: 250, source: 'csv' })
			.onConflictDoUpdate({
				target: [salesManualEntries.scopeId, salesManualEntries.businessDate],
				set: { netSalesMinor: 250, source: 'csv' },
			})
		const [row] = await db
			.select()
			.from(salesManualEntries)
			.where(eq(salesManualEntries.scopeId, 'loc1'))
		expect(row).toMatchObject({ netSalesMinor: 250, source: 'csv' })
	})

	it('starts tip pooling conservative: by hours, whole period, no fee, pickup only', async () => {
		const [row] = await db
			.insert(tipPoolSettings)
			.values({ scopeId: 'loc1' })
			.returning()
		expect(row).toMatchObject({
			splitBasis: 'hours',
			cadence: 'period',
			cardFeeBp: 0,
			fulfillment: ['pickup'],
			positionPercentBp: {},
		})
	})
})
