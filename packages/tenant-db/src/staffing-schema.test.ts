import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from './schema.ts'
import {
	staffAssignments,
	staffingSettings,
	staffMembers,
	staffPositions,
} from './schema.ts'

describe('staffing tables', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-staffing-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		db = drizzle(client, { schema })
		await db.run(sql`PRAGMA foreign_keys = ON`)
		const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
		await migrate(db, { migrationsFolder: path.join(pkgRoot, 'drizzle') })
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('builds the roster tables from the full migration chain', async () => {
		const tables = await db.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
		)
		const names = tables.map((table) => table.name)
		for (const name of [
			'staff_members',
			'staff_positions',
			'staff_assignments',
			'staff_events',
			'staffing_settings',
		]) {
			expect(names).toContain(name)
		}
	})

	it('keeps position names unique regardless of case', async () => {
		await db.insert(staffPositions).values({ name: 'Cook' })
		await expect(
			db.insert(staffPositions).values({ name: 'cook' }),
		).rejects.toThrow()
	})

	it('cascades assignments with the staff row but protects positions', async () => {
		const [position] = await db
			.insert(staffPositions)
			.values({ name: 'Server' })
			.returning()
		const [member] = await db
			.insert(staffMembers)
			.values({ firstName: 'Ana' })
			.returning()
		await db.insert(staffAssignments).values({
			staffId: member!.id,
			locationId: 'loc_1',
			positionId: position!.id,
			isPrimary: true,
		})
		await expect(
			db.delete(staffPositions).where(eq(staffPositions.id, position!.id)),
		).rejects.toThrow()
		await db.delete(staffMembers).where(eq(staffMembers.id, member!.id))
		expect(await db.select().from(staffAssignments)).toHaveLength(0)
	})

	it('defaults settings to a Monday week', async () => {
		await db.insert(staffingSettings).values({})
		const [row] = await db.select().from(staffingSettings)
		expect(row).toMatchObject({
			id: 'default',
			weekStart: 'monday',
			lateGraceMinutes: 5,
		})
	})
})
