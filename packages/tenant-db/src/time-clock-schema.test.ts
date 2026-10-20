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
	kioskAttempts,
	kioskDevices,
	kioskPairingCodes,
	laborPolicies,
	staffMembers,
	timeBreaks,
	timeEntries,
	timeEntryEdits,
	timePunches,
	timesheetPeriods,
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

describe('time clock schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-clock-'))
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

	async function member() {
		const [row] = await db
			.insert(staffMembers)
			.values({ firstName: 'Rana', lastName: 'Khalid' })
			.returning()
		return row!
	}

	async function entry(
		staffId: string,
		overrides: Partial<schema.TimeEntry> = {},
	) {
		const [row] = await db
			.insert(timeEntries)
			.values({
				staffId,
				scopeId: 'loc-1',
				clockInAt: 1_000_000,
				timeZone: 'America/Chicago',
				localDate: '2026-03-02',
				...overrides,
			})
			.returning()
		return row!
	}

	it('creates every time clock table additively', async () => {
		const rows = await db.all<{ name: string }>(
			sql`select name from sqlite_master where type = 'table'`,
		)
		const names = rows.map((r) => r.name)
		for (const table of [
			'labor_policies',
			'time_punches',
			'time_entries',
			'time_breaks',
			'time_entry_edits',
			'timesheet_periods',
			'kiosk_devices',
			'kiosk_pairing_codes',
			'kiosk_attempts',
		]) {
			expect(names).toContain(table)
		}
	})

	describe('labor_policies', () => {
		const policy = (scopeKey: string, scopeId: string | null) => ({
			scopeKey,
			scopeId,
		})

		it('allows one row per scope and exactly one organization default', async () => {
			await db.insert(laborPolicies).values(policy('*', null))
			await db.insert(laborPolicies).values(policy('loc-1', 'loc-1'))
			await db.insert(laborPolicies).values(policy('loc-2', 'loc-2'))
			await expectRejectsWith(
				db.insert(laborPolicies).values(policy('*', null)),
				/UNIQUE constraint failed/i,
			)
			await expectRejectsWith(
				db.insert(laborPolicies).values(policy('loc-1', 'loc-1')),
				/UNIQUE constraint failed/i,
			)
		})

		it('defaults to neutral rules and leaves the overtime aggregation choice unset', async () => {
			const [row] = await db
				.insert(laborPolicies)
				.values(policy('loc-1', 'loc-1'))
				.returning()
			expect(row).toMatchObject({
				weekStartsOn: 1,
				workdayStartMinute: 0,
				lateGraceMinutes: 5,
				preventEarlyMinutes: null,
				allowUnscheduled: true,
				autoClockOutMinutes: null,
				roundingMode: 'none',
				dailyOvertimeMinutes: null,
				weeklyOvertimeMinutes: null,
				holidayMultiplierBp: 10000,
				geofenceMode: 'off',
				requirePhoto: false,
				timesheetApprovalMode: 'none',
				aggregateOvertimeAcrossScopes: null,
				rulePack: 'generic',
				version: 1,
				timeTrackingEnabled: true,
			})
			expect(row!.holidayDates).toEqual([])
			expect(row!.breakRules).toEqual({ rules: [], autoDeduction: null })
		})
	})

	describe('time_punches', () => {
		const punch = (staffId: string, id = 'p-1') => ({
			id,
			staffId,
			scopeId: 'loc-1',
			kind: 'clock_in' as const,
			clientAt: 1,
			serverAt: 2,
			source: 'kiosk' as const,
			outcome: 'accepted' as const,
			timeZone: 'America/Chicago',
			localDate: '2026-03-02',
		})

		it('uses the client uuid as primary key, so a replay cannot insert twice', async () => {
			const s = await member()
			await db.insert(timePunches).values(punch(s.id))
			await expectRejectsWith(
				db.insert(timePunches).values(punch(s.id)),
				/UNIQUE constraint failed/i,
			)
		})

		it('is append-only', async () => {
			const s = await member()
			await db.insert(timePunches).values(punch(s.id))
			await expectRejectsWith(
				db.update(timePunches).set({ kind: 'clock_out' }),
				/append-only/,
			)
			await expectRejectsWith(
				db.update(timePunches).set({ outcome: 'rejected_policy' }),
				/append-only/,
			)
			await expectRejectsWith(db.delete(timePunches), /append-only/)
			const rows = await db.select().from(timePunches)
			expect(rows).toHaveLength(1)
			expect(rows[0]!.kind).toBe('clock_in')
		})

		it('refuses a punch for a person who does not exist', async () => {
			await db.run(sql`pragma foreign_keys = on`)
			await expectRejectsWith(
				db.insert(timePunches).values(punch('missing-staff')),
				/FOREIGN KEY/i,
			)
		})
	})

	describe('time_entries', () => {
		it('allows one open entry per person across scopes', async () => {
			const s = await member()
			await entry(s.id)
			await expectRejectsWith(
				entry(s.id, { scopeId: 'loc-2', clockInAt: 2_000_000 }),
				/UNIQUE constraint failed/i,
			)
		})

		it('allows a new open entry once the previous one closed or was voided', async () => {
			const s = await member()
			const first = await entry(s.id)
			await db
				.update(timeEntries)
				.set({ clockOutAt: 2_000_000, status: 'closed' })
				.where(eq(timeEntries.id, first.id))
			const second = await entry(s.id, { clockInAt: 3_000_000 })
			await db
				.update(timeEntries)
				.set({ voidedAt: 4_000_000 })
				.where(eq(timeEntries.id, second.id))
			await entry(s.id, { clockInAt: 5_000_000 })
		})

		it('different people can each have an open entry', async () => {
			const a = await member()
			const b = await member()
			await entry(a.id)
			await entry(b.id)
		})

		it('refuses an entry that ends before it starts', async () => {
			const s = await member()
			await expectRejectsWith(
				entry(s.id, { clockInAt: 2_000_000, clockOutAt: 1_000_000 }),
				/ends before it starts/,
			)
			const open = await entry(s.id)
			await expectRejectsWith(
				db
					.update(timeEntries)
					.set({ clockOutAt: 1 })
					.where(eq(timeEntries.id, open.id)),
				/ends before it starts/,
			)
		})

		it('allows a nullable shift id (the schedule is independent of the clock)', async () => {
			const s = await member()
			const row = await entry(s.id)
			expect(row.shiftId).toBeNull()
			expect(row.status).toBe('open')
			expect(row.issues).toEqual([])
			expect(row.regularMinutes).toBe(0)
		})

		it('is never deleted', async () => {
			const s = await member()
			await entry(s.id)
			await expectRejectsWith(db.delete(timeEntries), /cannot be deleted/)
		})

		it('is immutable while locked and editable again once unlocked', async () => {
			const s = await member()
			const row = await entry(s.id, { clockOutAt: 2_000_000 })
			await db
				.update(timeEntries)
				.set({ status: 'approved', approvedBy: 'op-1', approvedAt: 5 })
				.where(eq(timeEntries.id, row.id))
			await db
				.update(timeEntries)
				.set({ status: 'locked', lockedBy: 'op-1', lockedAt: 6 })
				.where(eq(timeEntries.id, row.id))

			for (const patch of [
				{ clockOutAt: 3_000_000 },
				{ clockInAt: 500_000 },
				{ regularMinutes: 99 },
				{ cashTipsMinor: 100 },
				{ status: 'closed' as const },
				{ voidedAt: 7 },
				{ issues: ['late'] },
				{ status: 'approved' as const, clockOutAt: 3_000_000 },
			]) {
				await expectRejectsWith(
					db.update(timeEntries).set(patch).where(eq(timeEntries.id, row.id)),
					/locked/,
				)
			}

			// Only the unlock transition is allowed.
			await db
				.update(timeEntries)
				.set({ status: 'approved', lockedBy: null, lockedAt: null })
				.where(eq(timeEntries.id, row.id))
			await db
				.update(timeEntries)
				.set({ clockOutAt: 3_000_000 })
				.where(eq(timeEntries.id, row.id))
		})
	})

	describe('time_breaks', () => {
		it('allows one open break per entry, and none of them deleted', async () => {
			const s = await member()
			const e = await entry(s.id)
			await db.insert(timeBreaks).values({ entryId: e.id, startAt: 1_100_000 })
			await expectRejectsWith(
				db.insert(timeBreaks).values({ entryId: e.id, startAt: 1_200_000 }),
				/UNIQUE constraint failed/i,
			)
			await expectRejectsWith(db.delete(timeBreaks), /cannot be deleted/)
		})

		it('refuses a break that ends before it starts', async () => {
			const s = await member()
			const e = await entry(s.id)
			await expectRejectsWith(
				db
					.insert(timeBreaks)
					.values({ entryId: e.id, startAt: 1_200_000, endAt: 1_100_000 }),
				/ends before it starts/,
			)
		})

		it('cannot be added to or changed on a locked entry', async () => {
			const s = await member()
			const e = await entry(s.id, { clockOutAt: 2_000_000 })
			const [brk] = await db
				.insert(timeBreaks)
				.values({ entryId: e.id, startAt: 1_100_000, endAt: 1_200_000 })
				.returning()
			await db
				.update(timeEntries)
				.set({ status: 'locked', lockedBy: 'op', lockedAt: 1 })
				.where(eq(timeEntries.id, e.id))
			await expectRejectsWith(
				db
					.insert(timeBreaks)
					.values({ entryId: e.id, startAt: 1_300_000, endAt: 1_400_000 }),
				/locked/,
			)
			await expectRejectsWith(
				db
					.update(timeBreaks)
					.set({ endAt: 1_250_000 })
					.where(eq(timeBreaks.id, brk!.id)),
				/locked/,
			)
		})
	})

	describe('time_entry_edits', () => {
		const edit = (entryId: string, reason: string) => ({
			entryId,
			staffId: 's',
			scopeId: 'loc-1',
			editorId: 'op-1',
			via: 'manager',
			action: 'update',
			reason,
			before: { clockOutAt: 1 },
			after: { clockOutAt: 2 },
		})

		it('requires a non-blank reason', async () => {
			const s = await member()
			const e = await entry(s.id)
			for (const reason of ['', '   ', '\n\t']) {
				await expectRejectsWith(
					db.insert(timeEntryEdits).values(edit(e.id, reason)),
					/requires a reason/,
				)
			}
			await db.insert(timeEntryEdits).values(edit(e.id, 'Forgot to clock out'))
		})

		it('is append-only', async () => {
			const s = await member()
			const e = await entry(s.id)
			await db.insert(timeEntryEdits).values(edit(e.id, 'Fix'))
			await expectRejectsWith(
				db.update(timeEntryEdits).set({ reason: 'Other' }),
				/append-only/,
			)
			await expectRejectsWith(db.delete(timeEntryEdits), /append-only/)
		})
	})

	describe('kiosk devices', () => {
		const device = (secretHash: string, scopeId = 'loc-1') => ({
			scopeId,
			name: 'Front counter',
			secretHash,
			pairedBy: 'op-1',
		})

		it('stores only a unique secret hash', async () => {
			await db.insert(kioskDevices).values(device('h1'))
			await expectRejectsWith(
				db.insert(kioskDevices).values(device('h1')),
				/UNIQUE constraint failed/i,
			)
		})

		it('binds a device to its scope and secret for life', async () => {
			const [row] = await db
				.insert(kioskDevices)
				.values(device('h1'))
				.returning()
			await expectRejectsWith(
				db
					.update(kioskDevices)
					.set({ scopeId: 'loc-2' })
					.where(eq(kioskDevices.id, row!.id)),
				/immutable/,
			)
			await expectRejectsWith(
				db
					.update(kioskDevices)
					.set({ secretHash: 'h2' })
					.where(eq(kioskDevices.id, row!.id)),
				/immutable/,
			)
			// Renaming and seen-at updates are fine.
			await db
				.update(kioskDevices)
				.set({ name: 'Bar', lastSeenAt: 5 })
				.where(eq(kioskDevices.id, row!.id))
		})

		it('revocation is permanent', async () => {
			const [row] = await db
				.insert(kioskDevices)
				.values(device('h1'))
				.returning()
			await db
				.update(kioskDevices)
				.set({ revokedAt: 10, revokedBy: 'op-1' })
				.where(eq(kioskDevices.id, row!.id))
			await expectRejectsWith(
				db
					.update(kioskDevices)
					.set({ revokedAt: null })
					.where(eq(kioskDevices.id, row!.id)),
				/immutable/,
			)
		})

		it('cascades attempt counters with the device', async () => {
			await db.run(sql`pragma foreign_keys = on`)
			const [row] = await db
				.insert(kioskDevices)
				.values(device('h1'))
				.returning()
			await db.insert(kioskAttempts).values({ deviceId: row!.id, failures: 3 })
			await db.delete(kioskDevices).where(eq(kioskDevices.id, row!.id))
			expect(await db.select().from(kioskAttempts)).toHaveLength(0)
		})
	})

	describe('kiosk pairing codes', () => {
		const code = (codeHash: string) => ({
			codeHash,
			scopeId: 'loc-1',
			deviceName: 'Front counter',
			createdBy: 'op-1',
			expiresAt: 600_000,
		})

		it('is unique by hash and single use', async () => {
			const [row] = await db
				.insert(kioskPairingCodes)
				.values(code('c1'))
				.returning()
			await expectRejectsWith(
				db.insert(kioskPairingCodes).values(code('c1')),
				/UNIQUE constraint failed/i,
			)
			await db
				.update(kioskPairingCodes)
				.set({ usedAt: 5, deviceId: 'd1' })
				.where(eq(kioskPairingCodes.id, row!.id))
			await expectRejectsWith(
				db
					.update(kioskPairingCodes)
					.set({ usedAt: null })
					.where(eq(kioskPairingCodes.id, row!.id)),
				/single use/,
			)
		})

		it('cannot have its expiry extended or its scope changed', async () => {
			const [row] = await db
				.insert(kioskPairingCodes)
				.values(code('c2'))
				.returning()
			await expectRejectsWith(
				db
					.update(kioskPairingCodes)
					.set({ expiresAt: 9_999_999_999 })
					.where(eq(kioskPairingCodes.id, row!.id)),
				/single use/,
			)
			await expectRejectsWith(
				db
					.update(kioskPairingCodes)
					.set({ scopeId: 'loc-2' })
					.where(eq(kioskPairingCodes.id, row!.id)),
				/single use/,
			)
		})
	})

	describe('timesheet_periods', () => {
		it('is unique per scope and range', async () => {
			const base = { startDate: '2026-03-02', endDate: '2026-03-08' }
			await db
				.insert(timesheetPeriods)
				.values({ ...base, scopeKey: '*', scopeId: null })
			await db
				.insert(timesheetPeriods)
				.values({ ...base, scopeKey: 'loc-1', scopeId: 'loc-1' })
			await expectRejectsWith(
				db
					.insert(timesheetPeriods)
					.values({ ...base, scopeKey: '*', scopeId: null }),
				/UNIQUE constraint failed/i,
			)
		})
	})
})
