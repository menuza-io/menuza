import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destroyTenantDb, getTenantDb, provisionTenantDb } from './index.ts'

const ORG_ID = 'clw9x0a12000008l00busy01'

describe('tenant DB busy timeout', () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-busy-'))
		vi.stubEnv('TENANT_DB_DIR', dir)
		vi.stubEnv('DATA_REGION', 'us')
	})

	afterEach(async () => {
		await destroyTenantDb(ORG_ID).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('keeps the busy timeout on the primary connection but never adds it to extra connections', async () => {
		await provisionTenantDb(ORG_ID)
		const db = await getTenantDb(ORG_ID)
		const first = await db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)
		expect(Number((first as { timeout: number }).timeout)).toBe(30_000)
		// A connection opened lazily after a transaction must not busy-wait: the
		// synchronous driver would block the event loop (see db.server.ts).
		await db.transaction(async (tx) => {
			await tx.run(sql`SELECT 1`)
		})
		const after = await db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`)
		expect(Number((after as { timeout: number }).timeout)).toBeLessThan(30_000)
	})

	it('keeps foreign keys enforced on every connection, including one opened after a transaction', async () => {
		await provisionTenantDb(ORG_ID)
		const db = await getTenantDb(ORG_ID)
		const enforced = async () =>
			Number(
				(
					(await db.get(sql`PRAGMA foreign_keys`)) as {
						foreign_keys: number
					}
				).foreign_keys,
			)
		expect(await enforced()).toBe(1)
		await db.transaction(async (tx) => {
			await tx.run(sql`SELECT 1`)
		})
		// Cascades and SET NULL (erasure relies on them) must still fire.
		expect(await enforced()).toBe(1)
	})
})
