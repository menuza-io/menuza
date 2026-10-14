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
	scheduleLinks,
	scheduleSettings,
	scheduleWeeks,
	schedulePublications,
	shiftRequests,
	shiftTemplates,
	shifts,
	staffAvailability,
	staffMembers,
	timeOffRequests,
} from './schema.ts'

const HOUR = 3_600_000

/** The driver wraps the SQLite message; the trigger text is on the root cause. */
async function expectRejectsWith(
	promise: PromiseLike<unknown>,
	pattern: RegExp,
) {
	let error: unknown
	try {
		await promise
	} catch (caught) {
		error = caught
	}
	expect(error, 'expected the statement to be rejected').toBeDefined()
	const messages: string[] = []
	for (
		let e = error;
		e instanceof Error;
		e = (e as { cause?: unknown }).cause
	) {
		messages.push(e.message)
	}
	expect(messages.join(' | ')).toMatch(pattern)
}

describe('scheduling schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-schedule-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		db = drizzle(client, { schema })
		const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
		await migrate(db, { migrationsFolder: path.join(pkgRoot, 'drizzle') })
		await db.run(sql`pragma foreign_keys = on`)
	})

	afterEach(() => {
		try {
			client.close()
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	async function person() {
		const [row] = await db
			.insert(staffMembers)
			.values({ firstName: 'Rana', lastName: 'Khalid' })
			.returning()
		return row!
	}

	function shiftValues(overrides: Partial<typeof shifts.$inferInsert> = {}) {
		return {
			scopeId: 'loc-1',
			startsAt: 1_000 * HOUR,
			endsAt: 1_008 * HOUR,
			localDate: '2026-03-02',
			timeZone: 'America/Chicago',
			...overrides,
		}
	}

	it('starts a shift as an open draft with no unpaid break', async () => {
		const [row] = await db.insert(shifts).values(shiftValues()).returning()
		expect(row).toMatchObject({
			staffId: null,
			positionId: null,
			status: 'draft',
			draftPatch: null,
			unpaidBreakMinutes: 0,
			version: 1,
		})
	})

	it('stores a draft patch as JSON and reads it back', async () => {
		const [row] = await db
			.insert(shifts)
			.values(shiftValues({ status: 'published' }))
			.returning()
		await db
			.update(shifts)
			.set({ draftPatch: { staffId: null, notes: 'Cover the pass' } })
			.where(eq(shifts.id, row!.id))
		const [after] = await db.select().from(shifts)
		expect(after!.draftPatch).toEqual({
			staffId: null,
			notes: 'Cover the pass',
		})
	})

	it('refuses a shift that does not end after it starts, on insert and update', async () => {
		await expect(
			db.insert(shifts).values(shiftValues({ endsAt: 1_000 * HOUR })),
		).rejects.toThrow()
		await expect(
			db.insert(shifts).values(shiftValues({ endsAt: 999 * HOUR })),
		).rejects.toThrow()
		const [row] = await db.insert(shifts).values(shiftValues()).returning()
		await expect(
			db
				.update(shifts)
				.set({ endsAt: 1_000 * HOUR })
				.where(eq(shifts.id, row!.id)),
		).rejects.toThrow()
	})

	it('freezes a cancelled shift as history', async () => {
		const [row] = await db
			.insert(shifts)
			.values(shiftValues({ status: 'published' }))
			.returning()
		await db
			.update(shifts)
			.set({ status: 'cancelled', cancelledAt: 5 })
			.where(eq(shifts.id, row!.id))
		await expectRejectsWith(
			db.update(shifts).set({ notes: 'oops' }).where(eq(shifts.id, row!.id)),
			/cancelled/,
		)
	})

	it('requires a real person and position for a shift', async () => {
		await expect(
			db.insert(shifts).values(shiftValues({ staffId: 'nobody' })),
		).rejects.toThrow()
		await expect(
			db.insert(shifts).values(shiftValues({ positionId: 'nothing' })),
		).rejects.toThrow()
	})

	it('keeps one week row per scope and week', async () => {
		await db
			.insert(scheduleWeeks)
			.values({ scopeId: 'loc-1', weekStartDate: '2026-03-02' })
		await expect(
			db
				.insert(scheduleWeeks)
				.values({ scopeId: 'loc-1', weekStartDate: '2026-03-02' }),
		).rejects.toThrow()
		await db
			.insert(scheduleWeeks)
			.values({ scopeId: 'loc-2', weekStartDate: '2026-03-02' })
	})

	it('treats publish history as append-only', async () => {
		const [row] = await db
			.insert(schedulePublications)
			.values({
				scopeId: 'loc-1',
				weekStartDate: '2026-03-02',
				version: 1,
				summary: { created: 3 },
				publishedBy: 'operator-1',
			})
			.returning()
		expect(row).toMatchObject({ notifyMode: 'changed', changes: [] })
		await expectRejectsWith(
			db
				.update(schedulePublications)
				.set({ notifyMode: 'nobody' })
				.where(eq(schedulePublications.id, row!.id)),
			/append-only/,
		)
		await expectRejectsWith(
			db
				.delete(schedulePublications)
				.where(eq(schedulePublications.id, row!.id)),
			/append-only/,
		)
		await expect(
			db.insert(schedulePublications).values({
				scopeId: 'loc-1',
				weekStartDate: '2026-03-02',
				version: 1,
				summary: {},
				publishedBy: 'operator-1',
			}),
		).rejects.toThrow()
	})

	it('names a template once per scope, ignoring case', async () => {
		const slots = [
			{
				weekday: 1,
				startMinute: 540,
				endDayOffset: 0,
				endMinute: 1020,
				positionId: null,
				staffId: null,
				unpaidBreakMinutes: 30,
				notes: null,
			},
		]
		await db
			.insert(shiftTemplates)
			.values({ scopeId: 'loc-1', name: 'Slow week', slots, slotCount: 1 })
		await expect(
			db.insert(shiftTemplates).values({
				scopeId: 'loc-1',
				name: 'SLOW WEEK',
				slots,
				slotCount: 1,
			}),
		).rejects.toThrow()
		await db
			.insert(shiftTemplates)
			.values({ scopeId: 'loc-2', name: 'Slow week', slots, slotCount: 1 })
		const [row] = await db
			.select()
			.from(shiftTemplates)
			.where(eq(shiftTemplates.scopeId, 'loc-1'))
		expect(row!.slots).toEqual(slots)
	})

	it('records availability and time off as pending manager rows by default', async () => {
		const p = await person()
		const [availability] = await db
			.insert(staffAvailability)
			.values({ staffId: p.id, kind: 'weekly', weekday: 1 })
			.returning()
		expect(availability).toMatchObject({
			availability: 'unavailable',
			allDay: true,
			status: 'pending',
			source: 'manager',
		})
		const [off] = await db
			.insert(timeOffRequests)
			.values({ staffId: p.id, startDate: '2026-03-02', endDate: '2026-03-04' })
			.returning()
		expect(off).toMatchObject({
			category: 'unpaid',
			allDay: true,
			status: 'pending',
		})
	})

	it('refuses time off that ends before it starts', async () => {
		const p = await person()
		await expectRejectsWith(
			db.insert(timeOffRequests).values({
				staffId: p.id,
				startDate: '2026-03-04',
				endDate: '2026-03-02',
			}),
			/time off/,
		)
		const [row] = await db
			.insert(timeOffRequests)
			.values({ staffId: p.id, startDate: '2026-03-02', endDate: '2026-03-04' })
			.returning()
		await expectRejectsWith(
			db
				.update(timeOffRequests)
				.set({ endDate: '2026-03-01' })
				.where(eq(timeOffRequests.id, row!.id)),
			/time off/,
		)
	})

	it('allows one pending request per shift and a new one once it is decided', async () => {
		const p = await person()
		const [shift] = await db.insert(shifts).values(shiftValues()).returning()
		const [first] = await db
			.insert(shiftRequests)
			.values({ kind: 'drop', shiftId: shift!.id, requesterStaffId: p.id })
			.returning()
		await expect(
			db
				.insert(shiftRequests)
				.values({ kind: 'cover', shiftId: shift!.id, requesterStaffId: p.id }),
		).rejects.toThrow()
		await db
			.update(shiftRequests)
			.set({ status: 'rejected' })
			.where(eq(shiftRequests.id, first!.id))
		await db
			.insert(shiftRequests)
			.values({ kind: 'cover', shiftId: shift!.id, requesterStaffId: p.id })
	})

	it('gives the schedule settings their defaults', async () => {
		const [row] = await db.insert(scheduleSettings).values({}).returning()
		expect(row).toMatchObject({
			id: 'org',
			minRestMinutes: 480,
			timeOffMinNoticeDays: 0,
		})
	})
	it('stores who a publication meant to tell with the (append-only) row', async () => {
		const [row] = await db
			.insert(schedulePublications)
			.values({
				scopeId: 'loc-1',
				weekStartDate: '2026-03-02',
				version: 1,
				summary: { created: 1 },
				publishedBy: 'user-1',
				notification: {
					mode: 'changed',
					recipients: 2,
					queued: 1,
					notReached: [{ staffId: 's-2', reason: 'no_email' }],
				},
			})
			.returning()
		expect(row!.notification).toEqual({
			mode: 'changed',
			recipients: 2,
			queued: 1,
			notReached: [{ staffId: 's-2', reason: 'no_email' }],
		})
		const [legacy] = await db
			.insert(schedulePublications)
			.values({
				scopeId: 'loc-1',
				weekStartDate: '2026-03-02',
				version: 2,
				summary: {},
				publishedBy: 'user-1',
			})
			.returning()
		expect(legacy!.notification).toBeNull()
		await expect(
			db
				.update(schedulePublications)
				.set({ notification: null })
				.where(eq(schedulePublications.id, row!.id)),
		).rejects.toThrow()
	})

	it('keeps one live schedule link per person and a revoked one as history', async () => {
		const p = await person()
		const link = (tokenHash: string) => ({
			staffId: p.id,
			tokenHash,
			expiresAt: 10_000 * HOUR,
		})
		const [first] = await db
			.insert(scheduleLinks)
			.values(link('hash-1'))
			.returning()
		expect(first).toMatchObject({ lastUsedAt: null, revokedAt: null })
		await expect(
			db.insert(scheduleLinks).values(link('hash-2')),
		).rejects.toThrow()
		await expect(
			db.insert(scheduleLinks).values({ ...link('hash-1'), staffId: p.id }),
		).rejects.toThrow()
		await db
			.update(scheduleLinks)
			.set({ revokedAt: 5 * HOUR, revokedBy: 'user-1' })
			.where(eq(scheduleLinks.id, first!.id))
		await db.insert(scheduleLinks).values(link('hash-2'))
		const all = await db.select().from(scheduleLinks)
		expect(all).toHaveLength(2)
	})

	it('refuses a link for someone who is not on the roster', async () => {
		await expect(
			db.insert(scheduleLinks).values({
				staffId: 'nobody',
				tokenHash: 'h',
				expiresAt: HOUR,
			}),
		).rejects.toThrow()
	})
})
