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
import { laborPolicies, notificationOutbox, staffMembers } from './schema.ts'

describe('clock operations schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-clock-ops-'))
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

	it('gives a new policy the alert defaults and lets each be switched off', async () => {
		const [row] = await db
			.insert(laborPolicies)
			.values({ scopeKey: '*', scopeId: null })
			.returning()
		expect(row).toMatchObject({
			noClockInAlertMinutes: 15,
			preShiftReminderMinutes: 240,
			overtimeAlertMinutes: 60,
		})
		await db
			.update(laborPolicies)
			.set({
				noClockInAlertMinutes: null,
				preShiftReminderMinutes: null,
				overtimeAlertMinutes: null,
			})
			.where(eq(laborPolicies.id, row!.id))
		const [off] = await db.select().from(laborPolicies)
		expect(off).toMatchObject({
			noClockInAlertMinutes: null,
			preShiftReminderMinutes: null,
			overtimeAlertMinutes: null,
		})
	})

	it('keeps one outbox row per dedupe key, so a tick can run twice', async () => {
		const [person] = await db
			.insert(staffMembers)
			.values({ firstName: 'Rana', lastName: 'Khalid' })
			.returning()
		const row = {
			kind: 'manager.no_clock_in',
			staffId: person!.id,
			scopeId: 'loc-1',
			dedupeKey: 'manager.no_clock_in:shift-1:p',
		}
		await db.insert(notificationOutbox).values(row)
		await db.insert(notificationOutbox).values(row).onConflictDoNothing()
		expect(await db.select().from(notificationOutbox)).toHaveLength(1)
	})
})
