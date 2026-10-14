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
	notificationOutbox,
	staffMembers,
	staffingSettings,
	timeEntries,
	timeEntryEdits,
} from './schema.ts'

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

const HOUR = 3_600_000

describe('time card review schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-review-'))
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

	async function member(firstName = 'Rana') {
		const [row] = await db
			.insert(staffMembers)
			.values({ firstName, lastName: 'Khalid' })
			.returning()
		return row!
	}

	async function card(
		staffId: string,
		from: number,
		to: number | null,
		overrides: Partial<schema.TimeEntry> = {},
	) {
		const [row] = await db
			.insert(timeEntries)
			.values({
				staffId,
				scopeId: 'loc-1',
				clockInAt: from,
				clockOutAt: to,
				timeZone: 'America/Chicago',
				localDate: '2026-03-02',
				...overrides,
			})
			.returning()
		return row!
	}

	it('adds the review, note, anchor, outbox and edit-delta columns additively', async () => {
		const columns = await db.all<{ name: string }>(
			sql`select name from pragma_table_info('time_entries')`,
		)
		const names = columns.map((c) => c.name)
		for (const name of ['reviewed_by', 'reviewed_at', 'manager_note']) {
			expect(names).toContain(name)
		}
		const edits = await db.all<{ name: string }>(
			sql`select name from pragma_table_info('time_entry_edits')`,
		)
		expect(edits.map((c) => c.name)).toContain('hours_delta_minutes')
		const settings = await db.all<{ name: string }>(
			sql`select name from pragma_table_info('staffing_settings')`,
		)
		expect(settings.map((c) => c.name)).toContain('pay_period_anchor')
		const tables = await db.all<{ name: string }>(
			sql`select name from sqlite_master where type = 'table'`,
		)
		expect(tables.map((t) => t.name)).toContain('notification_outbox')
	})

	describe('one person never has overlapping cards', () => {
		it('refuses an insert that overlaps a closed card', async () => {
			const s = await member()
			await card(s.id, 10 * HOUR, 18 * HOUR)
			for (const [from, to] of [
				[12 * HOUR, 14 * HOUR],
				[8 * HOUR, 11 * HOUR],
				[17 * HOUR, 20 * HOUR],
				[9 * HOUR, 19 * HOUR],
				[10 * HOUR, 18 * HOUR],
			] as const) {
				await expectRejectsWith(card(s.id, from, to), /time entries overlap/)
			}
		})

		it('allows cards that touch end to start, and other people at the same time', async () => {
			const a = await member('A')
			const b = await member('B')
			await card(a.id, 10 * HOUR, 12 * HOUR)
			await card(a.id, 12 * HOUR, 14 * HOUR)
			await card(a.id, 8 * HOUR, 10 * HOUR)
			await card(b.id, 10 * HOUR, 12 * HOUR)
		})

		it('treats an open card as running forever', async () => {
			const s = await member()
			await card(s.id, 10 * HOUR, null)
			await expectRejectsWith(
				card(s.id, 20 * HOUR, 21 * HOUR),
				/time entries overlap/,
			)
			// Before the open card started is fine.
			await card(s.id, 6 * HOUR, 9 * HOUR)
			// Two open cards are the unique index's business, not this guard's.
			await expectRejectsWith(
				card(s.id, 30 * HOUR, null),
				/UNIQUE constraint failed/i,
			)
		})

		it('ignores voided cards', async () => {
			const s = await member()
			const first = await card(s.id, 10 * HOUR, 12 * HOUR)
			await db
				.update(timeEntries)
				.set({ voidedAt: 1 })
				.where(eq(timeEntries.id, first.id))
			await card(s.id, 10 * HOUR, 12 * HOUR)
		})

		it('refuses an update that moves a card onto another', async () => {
			const s = await member()
			const earlier = await card(s.id, 10 * HOUR, 12 * HOUR)
			const later = await card(s.id, 14 * HOUR, 16 * HOUR)
			await expectRejectsWith(
				db
					.update(timeEntries)
					.set({ clockInAt: 11 * HOUR })
					.where(eq(timeEntries.id, later.id)),
				/time entries overlap/,
			)
			// Reopening the earlier card would run it over the later one.
			await expectRejectsWith(
				db
					.update(timeEntries)
					.set({ clockOutAt: null })
					.where(eq(timeEntries.id, earlier.id)),
				/time entries overlap/,
			)
			await db
				.update(timeEntries)
				.set({ clockOutAt: 17 * HOUR })
				.where(eq(timeEntries.id, later.id))
		})

		it('refuses to restore a voided card on top of another', async () => {
			const s = await member()
			const first = await card(s.id, 10 * HOUR, 12 * HOUR)
			await db
				.update(timeEntries)
				.set({ voidedAt: 1 })
				.where(eq(timeEntries.id, first.id))
			await card(s.id, 11 * HOUR, 13 * HOUR)
			await expectRejectsWith(
				db
					.update(timeEntries)
					.set({ voidedAt: null })
					.where(eq(timeEntries.id, first.id)),
				/time entries overlap/,
			)
		})
	})

	describe('a locked card also freezes the review mark and the note', () => {
		async function locked() {
			const s = await member()
			const row = await card(s.id, 10 * HOUR, 12 * HOUR)
			await db
				.update(timeEntries)
				.set({ status: 'approved', approvedBy: 'op-1', approvedAt: 5 })
				.where(eq(timeEntries.id, row.id))
			await db
				.update(timeEntries)
				.set({ status: 'locked', lockedBy: 'op-1', lockedAt: 6 })
				.where(eq(timeEntries.id, row.id))
			return row
		}

		it('refuses a note, a review mark, and every older frozen field', async () => {
			const row = await locked()
			for (const patch of [
				{ managerNote: 'sneaky' },
				{ reviewedBy: 'op-2', reviewedAt: 9 },
				{ cashTipsMinor: 1 },
				{ clockOutAt: 13 * HOUR },
				{ voidedAt: 9 },
			]) {
				await expectRejectsWith(
					db.update(timeEntries).set(patch).where(eq(timeEntries.id, row.id)),
					/locked/,
				)
			}
		})

		it('allows exactly the unlock transition, and the note afterwards', async () => {
			const row = await locked()
			await db
				.update(timeEntries)
				.set({ status: 'approved', lockedBy: null, lockedAt: null })
				.where(eq(timeEntries.id, row.id))
			await db
				.update(timeEntries)
				.set({ managerNote: 'checked' })
				.where(eq(timeEntries.id, row.id))
		})
	})

	describe('the edit log stays append-only with a delta column', () => {
		it('stores the hours delta and still refuses updates, deletes and blank reasons', async () => {
			const s = await member()
			const row = await card(s.id, 10 * HOUR, 12 * HOUR)
			const [edit] = await db
				.insert(timeEntryEdits)
				.values({
					entryId: row.id,
					staffId: s.id,
					scopeId: 'loc-1',
					editorId: 'op-1',
					via: 'manager',
					action: 'update',
					reason: 'Left early',
					hoursDeltaMinutes: -45,
				})
				.returning()
			expect(edit!.hoursDeltaMinutes).toBe(-45)
			await expectRejectsWith(
				db
					.update(timeEntryEdits)
					.set({ hoursDeltaMinutes: 0 })
					.where(eq(timeEntryEdits.id, edit!.id)),
				/append-only/,
			)
			await expectRejectsWith(db.delete(timeEntryEdits), /append-only/)
			await expectRejectsWith(
				db.insert(timeEntryEdits).values({
					entryId: row.id,
					staffId: s.id,
					scopeId: 'loc-1',
					editorId: 'op-1',
					via: 'manager',
					action: 'update',
					reason: ' \t ',
				}),
				/requires a reason/,
			)
		})
	})

	describe('notification_outbox', () => {
		it('de-duplicates on the dedupe key, so a retried edit never notifies twice', async () => {
			const s = await member()
			const values = {
				kind: 'time_card_edited',
				staffId: s.id,
				dedupeKey: 'time_card_edited:edit-1',
			}
			await db.insert(notificationOutbox).values(values)
			await expectRejectsWith(
				db.insert(notificationOutbox).values(values),
				/UNIQUE constraint failed/i,
			)
			const [row] = await db.select().from(notificationOutbox)
			expect(row).toMatchObject({ status: 'pending', attempts: 0 })
		})
	})

	it('keeps the pay period anchor optional on the settings row', async () => {
		await db.insert(staffingSettings).values({ id: 'org' })
		const [row] = await db.select().from(staffingSettings)
		expect(row!.payPeriod).toBe('weekly')
		expect(row!.payPeriodAnchor).toBeNull()
	})
})
