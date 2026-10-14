import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BUILTIN_LABOR_POLICY,
	businessDateOf,
	MANAGER_ALERT_KINDS,
	managerAlertEventSchema,
	type LaborPolicyFields,
	type ManagerAlertEvent,
} from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	laborPolicies,
	notificationOutbox,
	provisionTenantDb,
	staffAuditLog,
	staffingSettings,
	staffMembers,
	timeBreaks,
	timeEntries,
	timeEntryEdits,
	type TenantDatabase,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import { policyFieldsToColumns } from './labor-policy-service.ts'
import { type ScheduledShift } from './schedule-seam.ts'
import {
	managerEventId,
	MAX_STAFF_EMAILS_PER_TICK,
	registerStaffTickTask,
	resetStaffTickTasks,
	resetTickLocks,
	runStaffTickForOrg,
	type StaffEmailSender,
	type TickDeps,
} from './staff-tick-service.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const LOC = 'loc-1'
const LOC_OTHER = 'loc-2'
const ZONE = 'America/Chicago'
// Monday 2026-03-02 09:00 in Chicago (CST, before the March change).
const T0 = Date.UTC(2026, 2, 2, 15, 0, 0)

type Harness = {
	db: TenantDatabase
	now: { value: number }
	emails: Array<{ to: string; subject: string; html: string; text: string }>
	alerts: ManagerAlertEvent[]
	deps: Partial<TickDeps>
	flags: {
		enabled: boolean
		timeclock: boolean
		scheduling: boolean
		hiring: boolean
	}
	shifts: { list: ScheduledShift[] | undefined }
	emailResult: { value: Awaited<ReturnType<StaffEmailSender>> }
	alertResult: { value: Awaited<ReturnType<TickDeps['notifyManagers']>> }
	emailOn: { value: boolean }
}

let directory: string
let h: Harness

async function addStaff(
	overrides: Partial<typeof staffMembers.$inferInsert> = {},
) {
	const [row] = await h.db
		.insert(staffMembers)
		.values({
			firstName: 'Rana',
			lastName: 'Khalid',
			email: 'rana@example.com',
			status: 'active',
			...overrides,
		})
		.returning()
	return row!
}

async function setPolicy(
	patch: Partial<LaborPolicyFields>,
	scope = '*',
): Promise<void> {
	const fields: LaborPolicyFields = { ...BUILTIN_LABOR_POLICY, ...patch }
	await h.db.insert(laborPolicies).values({
		scopeKey: scope,
		scopeId: scope === '*' ? null : scope,
		...policyFieldsToColumns(fields),
	})
}

async function addEntry(input: {
	staffId: string
	clockInAt: number
	clockOutAt?: number | null
	scopeId?: string
	overtimeExempt?: boolean
	shiftId?: string | null
}) {
	const [row] = await h.db
		.insert(timeEntries)
		.values({
			staffId: input.staffId,
			scopeId: input.scopeId ?? LOC,
			clockInAt: input.clockInAt,
			clockOutAt: input.clockOutAt ?? null,
			timeZone: ZONE,
			localDate: businessDateOf(input.clockInAt, ZONE, 0),
			status: input.clockOutAt == null ? 'open' : 'closed',
			overtimeExempt: input.overtimeExempt ?? false,
			shiftId: input.shiftId ?? null,
			rateMinor: 1500,
			currency: 'USD',
		})
		.returning()
	return row!
}

async function outbox() {
	return h.db.select().from(notificationOutbox)
}

function tick(at?: number) {
	if (at !== undefined) h.now.value = at
	return runStaffTickForOrg(ORG_A, { db: h.db, deps: h.deps })
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-tick-'))
	stubStaffEnv(directory, 'us')
	vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
	await provisionTenantDb(ORG_A)
	await provisionTenantDb(ORG_B)
	resetTickLocks()
	resetStaffTickTasks()

	const now = { value: T0 }
	const emails: Harness['emails'] = []
	const alerts: Harness['alerts'] = []
	const flags = {
		enabled: true,
		timeclock: true,
		scheduling: true,
		hiring: true,
	}
	const shifts: Harness['shifts'] = { list: undefined }
	const emailResult: Harness['emailResult'] = { value: { status: 'success' } }
	const alertResult: Harness['alertResult'] = {
		value: {
			status: 'delivered',
			result: { inApp: 1, emailed: 1 },
		},
	}
	const emailOn = { value: true }
	h = {
		db: await getTenantDb(ORG_A),
		now,
		emails,
		alerts,
		flags,
		shifts,
		emailResult,
		alertResult,
		emailOn,
		deps: {
			now: () => now.value,
			getFeatures: async () => ({ features: { ...flags }, dataRegion: 'us' }),
			getScope: async () => ({ name: 'Downtown', timeZone: ZONE }),
			listShifts: async () => shifts.list,
			sendEmail: async (input) => {
				emails.push(input)
				return emailResult.value
			},
			notifyManagers: async (event) => {
				alerts.push(event)
				return alertResult.value
			},
			emailEnabled: () => emailOn.value,
		},
	}
})

afterEach(async () => {
	for (const id of [ORG_A, ORG_B]) {
		try {
			await destroyTenantDb(id)
		} catch {
			// already gone
		}
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
	resetStaffTickTasks()
})

describe('when the tick does nothing', () => {
	it('skips an organization with no staff without asking the App anything', async () => {
		const getFeatures = vi.fn(h.deps.getFeatures!)
		const result = await runStaffTickForOrg(ORG_A, {
			db: h.db,
			deps: { ...h.deps, getFeatures },
		})
		expect(result).toMatchObject({ status: 'skipped', reason: 'no_staff' })
		expect(getFeatures).not.toHaveBeenCalled()
	})

	it('does nothing when the flags cannot be confirmed (fails closed)', async () => {
		await addStaff()
		const result = await runStaffTickForOrg(ORG_A, {
			db: h.db,
			deps: { ...h.deps, getFeatures: async () => null },
		})
		expect(result).toMatchObject({ status: 'skipped', reason: 'flags_unknown' })
		expect(await outbox()).toHaveLength(0)
	})

	it('does nothing while the master flag is off, whatever the data says', async () => {
		const person = await addStaff()
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			autoClockOutMinutes: 60,
		})
		await addEntry({ staffId: person.id, clockInAt: T0 })
		h.flags.enabled = false
		h.flags.timeclock = true
		const result = await tick(T0 + 40 * HOUR)
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'staffing_disabled',
		})
		expect(await outbox()).toHaveLength(0)
		const [entry] = await h.db.select().from(timeEntries)
		expect(entry!.clockOutAt).toBeNull()
		expect(h.emails).toHaveLength(0)
		expect(h.alerts).toHaveLength(0)
	})

	it('refuses an organization whose data lives in another region', async () => {
		await addStaff()
		const result = await runStaffTickForOrg(ORG_A, {
			db: h.db,
			deps: {
				...h.deps,
				getFeatures: async () => ({
					features: {
						enabled: true,
						timeclock: true,
						scheduling: true,
						hiring: true,
					},
					dataRegion: 'ksa',
				}),
			},
		})
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'region_mismatch',
		})
	})

	it('reports a missing database instead of creating one', async () => {
		const result = await runStaffTickForOrg('clw9x0a12000008l00nodb', {
			deps: h.deps,
		})
		expect(result).toMatchObject({ status: 'skipped', reason: 'no_database' })
	})

	it('runs only one tick per organization at a time', async () => {
		await addStaff()
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const slow = runStaffTickForOrg(ORG_A, {
			db: h.db,
			deps: {
				...h.deps,
				getFeatures: async () => {
					await gate
					return { features: { ...h.flags }, dataRegion: 'us' }
				},
			},
		})
		const second = await runStaffTickForOrg(ORG_A, { db: h.db, deps: h.deps })
		expect(second).toMatchObject({ status: 'skipped', reason: 'busy' })
		release()
		expect((await slow).status).toBe('ran')
		// The lock is released afterwards.
		expect((await tick()).status).toBe('ran')
	})

	it('runs the timeclock tasks only while the timeclock flag is on', async () => {
		const person = await addStaff()
		await setPolicy({ missedClockOutReminderMinutes: 30 })
		await addEntry({ staffId: person.id, clockInAt: T0 })
		h.flags.timeclock = false
		const result = await tick(T0 + 24 * HOUR)
		expect(result.status).toBe('ran')
		expect(result.tasks.map((t) => t.name)).not.toContain('missed_clock_out')
		expect(await outbox()).toHaveLength(0)
	})
})

describe('missed clock-out', () => {
	beforeEach(async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
	})

	it('reminds the person and tells managers once the entry is overdue', async () => {
		const person = await addStaff()
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })

		// An unscheduled entry is measured from the long-shift mark (12h), not from
		// clock-in, so nobody is reminded 30 minutes after starting.
		await tick(T0 + 30 * MIN)
		expect(await outbox()).toHaveLength(0)
		await tick(T0 + 12 * HOUR + 29 * MIN)
		expect(await outbox()).toHaveLength(0)

		const result = await tick(T0 + 12 * HOUR + 30 * MIN)
		expect(
			result.tasks.find((t) => t.name === 'missed_clock_out')?.queued,
		).toBe(2)
		const rows = await outbox()
		expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
			[
				`manager.missed_clock_out:${entry.id}`,
				`missed_clock_out_reminder:${entry.id}`,
			].sort(),
		)
		// Delivered in the same pass.
		expect(h.emails).toHaveLength(1)
		expect(h.emails[0]!.to).toBe('rana@example.com')
		expect(h.emails[0]!.subject).toBe('Did you forget to clock out?')
		expect(h.alerts).toHaveLength(1)
		expect(h.alerts[0]).toMatchObject({
			orgId: ORG_A,
			kind: 'missed_clock_out',
			scopeId: LOC,
			count: 1,
		})
		expect((await outbox()).every((r) => r.status === 'sent')).toBe(true)
	})

	it('is idempotent: ticking again queues and sends nothing new', async () => {
		const person = await addStaff()
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 13 * HOUR)
		await tick(T0 + 13 * HOUR + 5 * MIN)
		await tick(T0 + 14 * HOUR)
		expect(await outbox()).toHaveLength(2)
		expect(h.emails).toHaveLength(1)
		expect(h.alerts).toHaveLength(1)
	})

	it('measures from the shift end when the entry belongs to a scheduled shift', async () => {
		const person = await addStaff()
		const shiftEnd = T0 + 5 * HOUR
		await addEntry({ staffId: person.id, clockInAt: T0, shiftId: 'shift-1' })
		const matchShift = vi.fn(async () => ({
			id: 'shift-1',
			startAt: T0,
			endAt: shiftEnd,
			positionId: null,
		}))
		const run = (at: number) => {
			h.now.value = at
			return runStaffTickForOrg(ORG_A, {
				db: h.db,
				deps: { ...h.deps, matchShift },
			})
		}
		await run(shiftEnd + 29 * MIN)
		expect(await outbox()).toHaveLength(0)
		await run(shiftEnd + 30 * MIN)
		expect(await outbox()).toHaveLength(2)
	})

	it('does not email a person with no address, but still tells managers', async () => {
		const person = await addStaff({ email: null })
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 13 * HOUR)
		const kinds = (await outbox()).map((r) => r.kind)
		expect(kinds).toEqual(['manager.missed_clock_out'])
		expect(h.emails).toHaveLength(0)
		expect(h.alerts).toHaveLength(1)
	})

	it('ignores closed entries and voided ones', async () => {
		const person = await addStaff()
		await addEntry({
			staffId: person.id,
			clockInAt: T0,
			clockOutAt: T0 + 8 * HOUR,
		})
		await tick(T0 + 30 * HOUR)
		expect(await outbox()).toHaveLength(0)
	})

	it('is off unless the policy sets it', async () => {
		await h.db.delete(laborPolicies)
		await setPolicy({ missedClockOutReminderMinutes: null })
		const person = await addStaff()
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 40 * HOUR)
		expect(await outbox()).toHaveLength(0)
	})
})

describe('automatic clock-out', () => {
	beforeEach(async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			autoClockOutMinutes: 60,
			longShiftMinutes: 720,
		})
	})

	it('is off by default: a forgotten entry stays open and is only reminded about', async () => {
		await h.db.delete(laborPolicies)
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		const person = await addStaff()
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 72 * HOUR)
		const [entry] = await h.db.select().from(timeEntries)
		expect(entry!.clockOutAt).toBeNull()
		expect((await outbox()).map((r) => r.kind)).toContain(
			'manager.missed_clock_out',
		)
	})

	it('closes the entry at the expected end, flags it, and leaves a trail', async () => {
		const person = await addStaff()
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })

		await tick(T0 + 12 * HOUR + 29 * MIN)
		const [stillOpen] = await h.db.select().from(timeEntries)
		expect(stillOpen!.clockOutAt).toBeNull()
		expect(await outbox()).toHaveLength(0)

		// The reminder (12h30) and the automatic close (13h) are both due now;
		// the close covers it, so only its own notices are queued.
		const result = await tick(T0 + 13 * HOUR)
		expect(result.tasks.find((t) => t.name === 'auto_clock_out')).toMatchObject(
			{
				closed: 1,
				queued: 2,
			},
		)
		const [closed] = await h.db
			.select()
			.from(timeEntries)
			.where(eq(timeEntries.id, entry.id))
		expect(closed!.clockOutAt).toBe(T0 + 12 * HOUR)
		expect(closed!.clockOutKind).toBe('auto')
		expect(closed!.status).toBe('needs_review')
		expect(closed!.issues).toContain('auto_clock_out')
		expect(closed!.version).toBe(entry.version + 1)

		const [edit] = await h.db
			.select()
			.from(timeEntryEdits)
			.where(eq(timeEntryEdits.entryId, entry.id))
		expect(edit).toMatchObject({
			via: 'auto_clock_out',
			action: 'auto_clock_out',
			editorId: 'staff-tick',
			staffId: person.id,
		})
		expect(edit!.reason.length).toBeGreaterThan(0)
		const audit = (await h.db.select().from(staffAuditLog)).find(
			(row) => row.action === 'timeclock.entry.auto_clock_out',
		)
		expect(audit).toMatchObject({
			actorKind: 'system',
			actorId: 'staff-tick',
			entityId: entry.id,
		})

		// Its own notices cover it: no separate missed clock-out reminder.
		const kinds = (await outbox()).map((r) => r.kind).sort()
		expect(kinds).toEqual(['auto_clock_out_notice', 'manager.auto_clock_out'])
		expect(h.emails.map((m) => m.subject)).toEqual([
			'You were clocked out automatically',
		])
	})

	it('reminds first when the reminder is due before the automatic close', async () => {
		const person = await addStaff()
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 12 * HOUR + 40 * MIN)
		expect((await outbox()).map((r) => r.kind).sort()).toEqual([
			'manager.missed_clock_out',
			'missed_clock_out_reminder',
		])
		expect((await h.db.select().from(timeEntries))[0]!.clockOutAt).toBeNull()
		await tick(T0 + 13 * HOUR)
		const [closed] = await h.db
			.select()
			.from(timeEntries)
			.where(eq(timeEntries.id, entry.id))
		expect(closed!.clockOutAt).toBe(T0 + 12 * HOUR)
		expect((await outbox()).map((r) => r.kind).sort()).toEqual([
			'auto_clock_out_notice',
			'manager.auto_clock_out',
			'manager.missed_clock_out',
			'missed_clock_out_reminder',
		])
	})

	it('is idempotent and never closes the same entry twice', async () => {
		const person = await addStaff()
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 13 * HOUR)
		await tick(T0 + 14 * HOUR)
		await tick(T0 + 20 * HOUR)
		expect(await h.db.select().from(timeEntryEdits)).toHaveLength(1)
		expect(await outbox()).toHaveLength(2)
		expect(h.emails).toHaveLength(1)
	})

	it('ends an open break at the same instant', async () => {
		const person = await addStaff()
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })
		await h.db.insert(timeBreaks).values({
			entryId: entry.id,
			kind: 'meal',
			paid: false,
			startAt: T0 + 4 * HOUR,
		})
		await tick(T0 + 13 * HOUR)
		const [brk] = await h.db.select().from(timeBreaks)
		expect(brk!.endAt).toBe(T0 + 12 * HOUR)
		const [closed] = await h.db.select().from(timeEntries)
		expect(closed!.clockOutAt).toBe(T0 + 12 * HOUR)
	})

	it('never records a clock-out before an open break started', async () => {
		const person = await addStaff()
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })
		await h.db.insert(timeBreaks).values({
			entryId: entry.id,
			kind: 'meal',
			paid: false,
			startAt: T0 + 12 * HOUR + 20 * MIN,
		})
		await tick(T0 + 13 * HOUR)
		const [closed] = await h.db.select().from(timeEntries)
		expect(closed!.clockOutAt).toBe(T0 + 12 * HOUR + 20 * MIN)
	})

	it('leaves a person who already clocked out alone', async () => {
		const person = await addStaff()
		await addEntry({
			staffId: person.id,
			clockInAt: T0,
			clockOutAt: T0 + 8 * HOUR,
		})
		await tick(T0 + 40 * HOUR)
		expect(await h.db.select().from(timeEntryEdits)).toHaveLength(0)
		const [entry] = await h.db.select().from(timeEntries)
		expect(entry!.clockOutKind).toBeNull()
	})

	it("uses each scope's own policy", async () => {
		const person = await addStaff()
		const other = await addStaff({ firstName: 'Omar', email: null })
		await setPolicy(
			{ autoClockOutMinutes: null, longShiftMinutes: 720 },
			LOC_OTHER,
		)
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await addEntry({ staffId: other.id, clockInAt: T0, scopeId: LOC_OTHER })
		await tick(T0 + 20 * HOUR)
		const rows = await h.db.select().from(timeEntries)
		expect(rows.find((r) => r.scopeId === LOC)!.clockOutAt).not.toBeNull()
		expect(rows.find((r) => r.scopeId === LOC_OTHER)!.clockOutAt).toBeNull()
	})
})

describe('overtime approaching', () => {
	const overtime = { thresholdMinutes: 40 * 60, multiplierBp: 15_000 }
	// Mon..Thu 09:00-18:00 Chicago = 36 hours, then Friday's open entry.
	const day = (n: number) => T0 + n * 24 * HOUR

	async function week(staffId: string, scopeId = LOC) {
		for (let i = 0; i < 4; i++) {
			await addEntry({
				staffId,
				scopeId,
				clockInAt: day(i),
				clockOutAt: day(i) + 9 * HOUR,
			})
		}
		return addEntry({ staffId, scopeId, clockInAt: day(4) })
	}

	beforeEach(async () => {
		await setPolicy({ weeklyOvertime: overtime, overtimeAlertMinutes: 60 })
	})

	it('alerts once when within the window, and again when reached', async () => {
		const person = await addStaff()
		await week(person.id)

		await tick(day(4) + 3 * HOUR) // 36h + 3h = 39h: 1h short, inside the window
		expect((await outbox()).map((r) => r.kind)).toEqual([
			'manager.overtime_approaching',
		])
		expect(h.alerts.map((a) => a.kind)).toEqual(['overtime_approaching'])

		await tick(day(4) + 3 * HOUR + 20 * MIN)
		expect(await outbox()).toHaveLength(1)

		await tick(day(4) + 4 * HOUR) // 40h
		const kinds = (await outbox()).map((r) => r.kind).sort()
		expect(kinds).toEqual([
			'manager.overtime_approaching',
			'manager.overtime_reached',
		])
		await tick(day(4) + 5 * HOUR)
		expect(await outbox()).toHaveLength(2)
		expect(h.alerts.map((a) => a.kind)).toEqual([
			'overtime_approaching',
			'overtime_reached',
		])
	})

	it('stays quiet while far from the threshold', async () => {
		const person = await addStaff()
		await week(person.id)
		await tick(day(4) + 2 * HOUR) // 38h
		expect(await outbox()).toHaveLength(0)
	})

	it('never alerts for exempt staff', async () => {
		const person = await addStaff()
		for (let i = 0; i < 4; i++) {
			await addEntry({
				staffId: person.id,
				clockInAt: day(i),
				clockOutAt: day(i) + 9 * HOUR,
				overtimeExempt: true,
			})
		}
		await addEntry({
			staffId: person.id,
			clockInAt: day(4),
			overtimeExempt: true,
		})
		await tick(day(4) + 5 * HOUR)
		expect(await outbox()).toHaveLength(0)
	})

	it('is off when the policy has no window or no overtime rule', async () => {
		await h.db.delete(laborPolicies)
		await setPolicy({ weeklyOvertime: overtime, overtimeAlertMinutes: null })
		const person = await addStaff()
		await week(person.id)
		await tick(day(4) + 5 * HOUR)
		expect(await outbox()).toHaveLength(0)

		await h.db.delete(laborPolicies)
		await setPolicy({
			weeklyOvertime: null,
			dailyOvertime: null,
			overtimeAlertMinutes: 60,
		})
		await tick(day(4) + 6 * HOUR)
		expect(await outbox()).toHaveLength(0)
	})

	it('starts a new alert for the next week', async () => {
		const person = await addStaff()
		await week(person.id)
		await tick(day(4) + 4 * HOUR)
		const before = (await outbox()).length
		// Friday's entry is closed, then the following Monday week begins: same
		// person, new period key.
		await h.db
			.update(timeEntries)
			.set({ clockOutAt: day(4) + 8 * HOUR, status: 'closed' })
			.where(eq(timeEntries.clockInAt, day(4)))
		const next = day(7)
		for (let i = 0; i < 4; i++) {
			await addEntry({
				staffId: person.id,
				clockInAt: next + i * 24 * HOUR,
				clockOutAt: next + i * 24 * HOUR + 9 * HOUR,
			})
		}
		await addEntry({ staffId: person.id, clockInAt: next + 4 * 24 * HOUR })
		await tick(next + 4 * 24 * HOUR + 4 * HOUR)
		expect((await outbox()).length).toBeGreaterThan(before)
	})
})

describe('scheduled shifts (through the schedule seam)', () => {
	const START = Date.UTC(2026, 2, 2, 23, 0, 0) // 17:00 Chicago
	const END = START + 4 * HOUR
	const shiftFor = (
		staffId: string,
		patch: Partial<ScheduledShift> = {},
	): ScheduledShift => ({
		id: 'shift-1',
		staffId,
		scopeId: LOC,
		startAt: START,
		endAt: END,
		positionId: null,
		...patch,
	})

	it('reports the schedule as unavailable instead of guessing', async () => {
		await addStaff()
		h.shifts.list = undefined
		const result = await tick(START + HOUR)
		const names = Object.fromEntries(result.tasks.map((t) => [t.name, t]))
		expect(names.no_clock_in).toMatchObject({
			status: 'skipped',
			reason: 'schedule_unavailable',
		})
		expect(names.pre_shift).toMatchObject({
			status: 'skipped',
			reason: 'schedule_unavailable',
		})
	})

	describe('no clock-in alert', () => {
		it('alerts managers 15 minutes after the start, once', async () => {
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			await tick(START + 14 * MIN)
			expect(await outbox()).toHaveLength(0)
			await tick(START + 15 * MIN)
			expect((await outbox()).map((r) => r.dedupeKey)).toEqual([
				`manager.no_clock_in:shift-1:${person.id}`,
			])
			await tick(START + 30 * MIN)
			await tick(START + 3 * HOUR)
			expect(await outbox()).toHaveLength(1)
			expect(h.alerts).toHaveLength(1)
			expect(h.alerts[0]).toMatchObject({
				kind: 'no_clock_in',
				count: 1,
				scopeId: LOC,
			})
		})

		it('honours the configured delay', async () => {
			await setPolicy({ noClockInAlertMinutes: 30 })
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			await tick(START + 29 * MIN)
			expect(await outbox()).toHaveLength(0)
			await tick(START + 30 * MIN)
			expect(await outbox()).toHaveLength(1)
		})

		it('is off when the policy says so', async () => {
			await setPolicy({ noClockInAlertMinutes: null })
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			await tick(START + 2 * HOUR)
			expect(await outbox()).toHaveLength(0)
		})

		it('does not alert for someone who clocked in, or who clocked in a little early', async () => {
			const person = await addStaff()
			const early = await addStaff({ firstName: 'Omar', email: null })
			h.shifts.list = [
				shiftFor(person.id),
				shiftFor(early.id, { id: 'shift-2' }),
			]
			await addEntry({ staffId: person.id, clockInAt: START + 3 * MIN })
			await addEntry({ staffId: early.id, clockInAt: START - 20 * MIN })
			await tick(START + HOUR)
			expect(
				(await outbox()).filter((r) => r.kind === 'manager.no_clock_in'),
			).toHaveLength(0)
		})

		it('does not alert after the shift is over, or for someone who is no longer active', async () => {
			const gone = await addStaff({ status: 'terminated' })
			const person = await addStaff({ firstName: 'Omar', email: null })
			h.shifts.list = [
				shiftFor(gone.id),
				shiftFor(person.id, { id: 'shift-2' }),
			]
			await tick(END + MIN)
			expect(await outbox()).toHaveLength(0)
			await tick(START + HOUR)
			expect((await outbox()).map((r) => r.dedupeKey)).toEqual([
				`manager.no_clock_in:shift-2:${person.id}`,
			])
		})

		it('groups people at one scope into one alert with a count', async () => {
			const a = await addStaff({ firstName: 'Ann', email: null })
			const b = await addStaff({ firstName: 'Bo', email: null })
			const c = await addStaff({ firstName: 'Cy', email: null })
			h.shifts.list = [
				shiftFor(a.id, { id: 's-a' }),
				shiftFor(b.id, { id: 's-b' }),
				shiftFor(c.id, { id: 's-c', scopeId: LOC_OTHER }),
			]
			await tick(START + 20 * MIN)
			const byScope = Object.fromEntries(
				h.alerts.map((alert) => [alert.scopeId, alert.count]),
			)
			expect(byScope).toEqual({ [LOC]: 2, [LOC_OTHER]: 1 })
		})

		it('needs the scheduling flag as well as the timeclock flag', async () => {
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			h.flags.scheduling = false
			const result = await tick(START + HOUR)
			expect(result.tasks.map((t) => t.name)).not.toContain('no_clock_in')
			expect(await outbox()).toHaveLength(0)
		})
	})

	describe('pre-shift reminder', () => {
		it('emails the person four hours ahead by default, once', async () => {
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			await tick(START - 4 * HOUR - MIN)
			expect(await outbox()).toHaveLength(0)
			await tick(START - 4 * HOUR)
			expect(h.emails).toHaveLength(1)
			expect(h.emails[0]!.subject).toMatch(
				/^Reminder: your shift starts at 5:00\sPM$/,
			)
			expect(h.emails[0]!.text).toContain('Downtown')
			await tick(START - 2 * HOUR)
			await tick(START - HOUR)
			expect(h.emails).toHaveLength(1)
			expect((await outbox())[0]!.dedupeKey).toBe(
				`shift_reminder:shift-1:${person.id}`,
			)
		})

		it('does not send once the shift has started, and skips people with no address', async () => {
			const person = await addStaff()
			const silent = await addStaff({ firstName: 'Omar', email: null })
			h.shifts.list = [
				shiftFor(person.id),
				shiftFor(silent.id, { id: 'shift-2' }),
			]
			await tick(START + MIN)
			expect(await outbox()).toHaveLength(0)
			await tick(START - 3 * HOUR)
			expect((await outbox()).map((r) => r.staffId)).toEqual([person.id])
		})

		it('honours the policy lead time and an off switch', async () => {
			await setPolicy({ preShiftReminderMinutes: 60 })
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			await tick(START - 2 * HOUR)
			expect(await outbox()).toHaveLength(0)
			await tick(START - 60 * MIN)
			expect(await outbox()).toHaveLength(1)

			await h.db.delete(notificationOutbox)
			await h.db.delete(laborPolicies)
			await setPolicy({ preShiftReminderMinutes: null })
			await tick(START - 30 * MIN)
			expect(await outbox()).toHaveLength(0)
		})

		it('needs the scheduling flag', async () => {
			const person = await addStaff()
			h.shifts.list = [shiftFor(person.id)]
			h.flags.scheduling = false
			await tick(START - 3 * HOUR)
			expect(await outbox()).toHaveLength(0)
		})
	})
})

describe('delivery', () => {
	async function queueMissedClockOut() {
		const person = await addStaff()
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })
		return { person, entry }
	}

	it('retries a failed email with backoff and gives up after eight attempts', async () => {
		await queueMissedClockOut()
		h.emailResult.value = {
			status: 'error',
			error: { message: 'x', statusCode: 503 },
		}
		let at = T0 + 13 * HOUR
		await tick(at)
		let [row] = (await outbox()).filter(
			(r) => r.kind === 'missed_clock_out_reminder',
		)
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'email_http_503',
		})
		expect(row!.nextAttemptAt).toBe(at + 5 * MIN)

		// Not due yet: no new attempt.
		await tick(at + 4 * MIN)
		expect(h.emails).toHaveLength(1)

		for (let attempt = 2; attempt <= 8; attempt++) {
			at = row!.nextAttemptAt
			await tick(at)
			;[row] = (await outbox()).filter(
				(r) => r.kind === 'missed_clock_out_reminder',
			)
		}
		expect(row).toMatchObject({ status: 'failed', attempts: 8 })
		const sentCount = h.emails.length
		await tick(at + 24 * HOUR)
		expect(h.emails).toHaveLength(sentCount)
	})

	it('recovers when the provider comes back', async () => {
		await queueMissedClockOut()
		h.emailResult.value = { status: 'error', error: { message: 'x' } }
		await tick(T0 + 13 * HOUR)
		h.emailResult.value = { status: 'success' }
		await tick(T0 + 13 * HOUR + 5 * MIN)
		const row = (await outbox()).find(
			(r) => r.kind === 'missed_clock_out_reminder',
		)!
		expect(row.status).toBe('sent')
		expect(row.sentAt).toBe(T0 + 13 * HOUR + 5 * MIN)
	})

	it('treats a provider that throws as a retry, not a crash', async () => {
		await queueMissedClockOut()
		const result = await runStaffTickForOrg(ORG_A, {
			db: h.db,
			deps: {
				...h.deps,
				now: () => T0 + 13 * HOUR,
				sendEmail: async () => {
					throw new Error('boom: rana@example.com')
				},
			},
		})
		expect(result.status).toBe('ran')
		const row = (await outbox()).find(
			(r) => r.kind === 'missed_clock_out_reminder',
		)!
		expect(row.status).toBe('pending')
		// The error text is never stored: it can quote an address.
		expect(row.lastError).toBe('email_error')
	})

	it('drops staff email while the kill switch is off, and does not send a backlog later', async () => {
		await queueMissedClockOut()
		h.emailOn.value = false
		await tick(T0 + 13 * HOUR)
		expect(h.emails).toHaveLength(0)
		const row = (await outbox()).find(
			(r) => r.kind === 'missed_clock_out_reminder',
		)!
		expect(row).toMatchObject({
			status: 'skipped',
			lastError: 'email_disabled',
		})
		h.emailOn.value = true
		await tick(T0 + 14 * HOUR)
		expect(h.emails).toHaveLength(0)
		// Manager alerts are the App's to deliver and are not stopped here.
		expect(h.alerts).toHaveLength(1)
	})

	it('skips a terminated person without sending', async () => {
		const { person } = await queueMissedClockOut()
		// Someone else is still active, so the organization is still ticking.
		await addStaff({ firstName: 'Omar', email: null })
		await h.db
			.update(staffMembers)
			.set({ status: 'terminated' })
			.where(eq(staffMembers.id, person.id))
		// The reminder was queued while active; terminate before delivery.
		await h.db.insert(notificationOutbox).values({
			kind: 'time_card_edited',
			staffId: person.id,
			scopeId: LOC,
			dedupeKey: 'time_card_edited:e1',
			payload: {
				entryId: 'e1',
				localDate: '2026-03-02',
				hoursDeltaMinutes: -30,
			},
			nextAttemptAt: T0,
			createdAt: T0,
		})
		await tick(T0 + 13 * HOUR)
		expect(h.emails).toHaveLength(0)
		const reasons = (await outbox())
			.filter((r) => r.kind === 'time_card_edited')
			.map((r) => r.lastError)
		expect(reasons).toEqual(['staff_inactive'])
	})

	it('drops a message that waited too long', async () => {
		const person = await addStaff()
		await setPolicy({})
		await h.db.insert(notificationOutbox).values({
			kind: 'missed_clock_out_reminder',
			staffId: person.id,
			scopeId: LOC,
			dedupeKey: 'old',
			payload: { clockInAt: T0, scopeId: LOC },
			nextAttemptAt: T0,
			createdAt: T0,
		})
		await h.db.insert(notificationOutbox).values({
			kind: 'manager.no_clock_in',
			staffId: person.id,
			scopeId: LOC,
			dedupeKey: 'old-alert',
			payload: {},
			nextAttemptAt: T0,
			createdAt: T0,
		})
		await tick(T0 + 25 * HOUR)
		expect(h.emails).toHaveLength(0)
		expect(h.alerts).toHaveLength(0)
		expect((await outbox()).map((r) => r.lastError)).toEqual(['stale', 'stale'])
	})

	it('delivers the existing time-card-edited notice to the person', async () => {
		const person = await addStaff()
		await setPolicy({})
		await h.db.insert(notificationOutbox).values({
			kind: 'time_card_edited',
			staffId: person.id,
			scopeId: LOC,
			dedupeKey: 'time_card_edited:e1',
			payload: {
				entryId: 'e1',
				editId: 'ed1',
				action: 'update',
				localDate: '2026-03-02',
				hoursDeltaMinutes: -90,
				reducedHours: true,
			},
			nextAttemptAt: T0,
			createdAt: T0,
		})
		await tick(T0 + 5 * MIN)
		expect(h.emails).toHaveLength(1)
		expect(h.emails[0]!.subject).toBe('Your time card was updated')
		expect(h.emails[0]!.text).toContain('-1 h 30 min')
		expect(h.emails[0]!.text).toContain('Mon, Mar 2')
	})

	it('sends Arabic to a person whose locale is Arabic, with their Arabic first name', async () => {
		const person = await addStaff({ locale: 'ar', firstNameAr: 'رنا' })
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await tick(T0 + 13 * HOUR)
		const email = h.emails[0]!
		expect(email.subject).toBe('هل نسيت تسجيل الانصراف؟')
		expect(email.html).toContain('dir="rtl"')
		expect(email.html).toContain('lang="ar"')
		expect(email.text).toContain('رنا')
	})

	it('says as little as possible at the minimal content level', async () => {
		const person = await addStaff({ firstName: 'Rana', lastName: 'Khalid' })
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		await addEntry({ staffId: person.id, clockInAt: T0 })
		await h.db
			.insert(staffingSettings)
			.values({ id: 'org', contactLevel: 'minimal' })
		await tick(T0 + 13 * HOUR)
		const email = h.emails[0]!
		expect(email.subject).toBe('An update about your time')
		for (const leak of ['Rana', 'Khalid', 'Downtown', '9:00', 'AM', 'PM']) {
			expect(email.text).not.toContain(leak)
			expect(email.html).not.toContain(leak)
		}
	})

	it('sends no marketing context and plain hex colors only', async () => {
		await queueMissedClockOut()
		await tick(T0 + 13 * HOUR)
		const { html } = h.emails[0]!
		expect(html).not.toMatch(/oklch|var\(--|<script/i)
		expect(html).toMatch(/#[0-9a-f]{6}/)
		// `sendEmail` receives only recipient, subject and bodies (no `context`).
		expect(Object.keys(h.emails[0]!).sort()).toEqual([
			'html',
			'subject',
			'text',
			'to',
			'toName',
		])
	})

	it('caps the emails sent in one tick and leaves the rest for the next', async () => {
		await setPolicy({})
		const total = MAX_STAFF_EMAILS_PER_TICK + 5
		const people = []
		for (let i = 0; i < total; i++) {
			people.push(
				await addStaff({ firstName: `P${i}`, email: `p${i}@example.com` }),
			)
		}
		await h.db.insert(notificationOutbox).values(
			people.map((p, i) => ({
				kind: 'time_card_edited',
				staffId: p.id,
				scopeId: LOC,
				dedupeKey: `time_card_edited:${i}`,
				payload: {
					entryId: `e${i}`,
					localDate: '2026-03-02',
					hoursDeltaMinutes: 10,
				},
				nextAttemptAt: T0,
				createdAt: T0,
			})),
		)
		await tick(T0 + MIN)
		expect(h.emails).toHaveLength(MAX_STAFF_EMAILS_PER_TICK)
		await tick(T0 + 2 * MIN)
		expect(h.emails).toHaveLength(total)
	})

	it('does not deliver kinds whose flag is off, and sends them if it comes back', async () => {
		const person = await addStaff()
		await setPolicy({})
		await h.db.insert(notificationOutbox).values({
			kind: 'shift_reminder',
			staffId: person.id,
			scopeId: LOC,
			dedupeKey: 'shift_reminder:s:p',
			payload: {
				shiftId: 's',
				startAt: T0 + 3 * HOUR,
				endAt: T0 + 7 * HOUR,
				scopeId: LOC,
			},
			nextAttemptAt: T0,
			createdAt: T0,
		})
		h.flags.scheduling = false
		await tick(T0 + MIN)
		expect(h.emails).toHaveLength(0)
		expect((await outbox())[0]!.status).toBe('pending')
		h.flags.scheduling = true
		await tick(T0 + 2 * MIN)
		expect(h.emails).toHaveLength(1)
	})

	it('purges finished rows after a month and keeps recent ones', async () => {
		const person = await addStaff()
		await setPolicy({})
		const old = T0 - 31 * 24 * HOUR
		await h.db.insert(notificationOutbox).values([
			{
				kind: 'time_card_edited',
				staffId: person.id,
				dedupeKey: 'a',
				status: 'sent',
				createdAt: old,
				nextAttemptAt: old,
			},
			{
				kind: 'time_card_edited',
				staffId: person.id,
				dedupeKey: 'b',
				status: 'sent',
				createdAt: T0 - 24 * HOUR,
				nextAttemptAt: T0,
			},
			{
				kind: 'time_card_edited',
				staffId: person.id,
				dedupeKey: 'c',
				status: 'pending',
				createdAt: old,
				nextAttemptAt: T0 + 99 * HOUR,
			},
		])
		await tick(T0)
		expect((await outbox()).map((r) => r.dedupeKey).sort()).toEqual(['b', 'c'])
	})
})

describe('manager alerts across the plane boundary', () => {
	const PEOPLE = [
		{ firstName: 'Rana', lastName: 'Khalid' },
		{ firstName: 'Omar', lastName: 'Haddad' },
	]

	it('carries only an organization, a kind, a scope and a count: no names, times, ids or pay', async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			autoClockOutMinutes: 60,
			longShiftMinutes: 720,
			weeklyOvertime: { thresholdMinutes: 60, multiplierBp: 15000 },
			overtimeAlertMinutes: 30,
		})
		const staff = []
		for (const name of PEOPLE) {
			staff.push(
				await addStaff({ ...name, email: `${name.firstName}@example.com` }),
			)
		}
		for (const person of staff) {
			await addEntry({ staffId: person.id, clockInAt: T0 })
		}
		await tick(T0 + 13 * HOUR)

		expect(h.alerts.length).toBeGreaterThan(0)
		const kinds = new Set(h.alerts.map((a) => a.kind))
		expect(kinds.size).toBeGreaterThan(0)
		const serialized = JSON.stringify(h.alerts)
		for (const alert of h.alerts) {
			expect(Object.keys(alert).sort()).toEqual([
				'count',
				'eventId',
				'kind',
				'orgId',
				'scopeId',
			])
			expect(managerAlertEventSchema.safeParse(alert).success).toBe(true)
			expect(MANAGER_ALERT_KINDS).toContain(alert.kind)
			expect(alert.orgId).toBe(ORG_A)
			expect(alert.count).toBeGreaterThanOrEqual(1)
		}
		for (const person of staff) {
			for (const secret of [
				person.id,
				person.firstName,
				person.lastName,
				String(T0),
				String(T0 + 12 * HOUR),
				'1500',
				'USD',
				'@example.com',
			]) {
				expect(serialized).not.toContain(secret)
			}
		}
	})

	it('batches the people of one kind and scope into one event with a count', async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		for (let i = 0; i < 3; i++) {
			const person = await addStaff({ firstName: `P${i}`, email: null })
			await addEntry({ staffId: person.id, clockInAt: T0 + i * MIN })
		}
		await tick(T0 + 13 * HOUR)
		expect(h.alerts).toHaveLength(1)
		expect(h.alerts[0]).toMatchObject({ kind: 'missed_clock_out', count: 3 })
	})

	it('retries a failed delivery with the same event id', async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		const person = await addStaff({ email: null })
		await addEntry({ staffId: person.id, clockInAt: T0 })
		h.alertResult.value = { status: 'retry', code: 'http_503' }
		await tick(T0 + 13 * HOUR)
		const [row] = await outbox()
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'http_503',
		})
		h.alertResult.value = {
			status: 'delivered',
			result: { inApp: 1, emailed: 0 },
		}
		await tick(T0 + 13 * HOUR + 5 * MIN)
		expect(h.alerts).toHaveLength(2)
		expect(h.alerts[1]!.eventId).toBe(h.alerts[0]!.eventId)
		expect((await outbox())[0]!.status).toBe('sent')
	})

	it('marks a rejected alert failed and does not retry it', async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		const person = await addStaff({ email: null })
		await addEntry({ staffId: person.id, clockInAt: T0 })
		h.alertResult.value = { status: 'rejected', code: 'http_400' }
		await tick(T0 + 13 * HOUR)
		await tick(T0 + 14 * HOUR)
		expect(h.alerts).toHaveLength(1)
		expect((await outbox())[0]).toMatchObject({
			status: 'failed',
			lastError: 'http_400',
		})
	})

	it('records an alert the App skipped (flag off, nobody to tell) as skipped, not sent', async () => {
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			longShiftMinutes: 720,
		})
		const person = await addStaff({ email: null })
		await addEntry({ staffId: person.id, clockInAt: T0 })
		h.alertResult.value = {
			status: 'delivered',
			result: { inApp: 0, emailed: 0, skipped: 'no_recipients' },
		}
		await tick(T0 + 13 * HOUR)
		expect((await outbox())[0]).toMatchObject({
			status: 'skipped',
			lastError: 'no_recipients',
		})
		await tick(T0 + 14 * HOUR)
		expect(h.alerts).toHaveLength(1)
	})

	it('derives a stable event id from the rows it covers, in any order', () => {
		const a = managerEventId(['b', 'a', 'c'])
		expect(a).toBe(managerEventId(['c', 'b', 'a']))
		expect(a).not.toBe(managerEventId(['a', 'b']))
		expect(a).toMatch(/^[a-f0-9]{32}$/)
	})
})

describe('hooks from later slices', () => {
	it('runs a registered task behind its flag and isolates its failures', async () => {
		await addStaff()
		const ran: string[] = []
		registerStaffTickTask({
			name: 'onboarding_reminders',
			requires: 'hiring',
			run: async (ctx) => {
				ran.push(ctx.orgId)
				const queued = await ctx.enqueue({
					kind: 'manager.no_clock_in',
					staffId: 'x',
					scopeId: LOC,
					dedupeKey: 'hook-1',
					payload: {},
				})
				return { queued: queued ? 1 : 0 }
			},
		})
		registerStaffTickTask({
			name: 'broken',
			requires: 'enabled',
			run: async () => {
				throw new Error('nope')
			},
		})
		const result = await tick()
		expect(ran).toEqual([ORG_A])
		expect(
			result.tasks.find((t) => t.name === 'onboarding_reminders'),
		).toMatchObject({
			status: 'ok',
			queued: 1,
		})
		expect(result.tasks.find((t) => t.name === 'broken')).toMatchObject({
			status: 'error',
			reason: 'task_failed',
		})
		// A second pass queues nothing new (the hook's dedupe key holds).
		const again = await tick()
		expect(
			again.tasks.find((t) => t.name === 'onboarding_reminders')?.queued,
		).toBe(0)

		h.flags.hiring = false
		const off = await tick()
		expect(off.tasks.map((t) => t.name)).not.toContain('onboarding_reminders')
		expect(ran).toHaveLength(2)
	})

	it('refuses a second task with the same name', () => {
		const task = {
			name: 'dup',
			requires: 'enabled' as const,
			run: async () => {},
		}
		registerStaffTickTask(task)
		expect(() => registerStaffTickTask(task)).toThrow(/already registered/)
	})
})

describe('follow-up hint for timers', () => {
	it('asks for a follow-up while something is open or queued, and goes quiet otherwise', async () => {
		const person = await addStaff()
		await setPolicy({})
		expect((await tick()).needsFollowUp).toBe(false)

		const entry = await addEntry({ staffId: person.id, clockInAt: T0 })
		expect((await tick(T0 + HOUR)).needsFollowUp).toBe(true)

		await h.db
			.update(timeEntries)
			.set({ clockOutAt: T0 + 2 * HOUR, status: 'closed' })
			.where(eq(timeEntries.id, entry.id))
		expect((await tick(T0 + 3 * HOUR)).needsFollowUp).toBe(false)

		await h.db.insert(notificationOutbox).values({
			kind: 'time_card_edited',
			staffId: person.id,
			dedupeKey: 'pending-1',
			payload: { localDate: '2026-03-02' },
			nextAttemptAt: T0 + 99 * HOUR,
			createdAt: T0,
		})
		expect((await tick(T0 + 4 * HOUR)).needsFollowUp).toBe(true)
	})

	it('does not wake for a message its flags can never deliver, and expires it', async () => {
		const person = await addStaff()
		await setPolicy({})
		h.flags.scheduling = false
		await h.db.insert(notificationOutbox).values({
			kind: 'shift_reminder',
			staffId: person.id,
			dedupeKey: 'orphan-1',
			payload: { startAt: T0 + 99 * HOUR },
			nextAttemptAt: T0,
			createdAt: T0,
		})
		expect((await tick(T0 + HOUR)).needsFollowUp).toBe(false)
		expect((await outbox())[0]!.status).toBe('pending')

		await tick(T0 + 9 * 24 * HOUR)
		const [row] = await outbox()
		expect(row!.status).toBe('skipped')
		expect(row!.lastError).toBe('stale')
	})

	it('keeps asking while a shift is coming up', async () => {
		const person = await addStaff()
		h.shifts.list = [
			{
				id: 's',
				staffId: person.id,
				scopeId: LOC,
				startAt: T0 + 20 * HOUR,
				endAt: T0 + 24 * HOUR,
				positionId: null,
			},
		]
		expect((await tick(T0)).needsFollowUp).toBe(true)
	})
})

describe('residency of what the tick returns', () => {
	it('returns counts and codes only', async () => {
		const person = await addStaff({ firstName: 'Rana', lastName: 'Khalid' })
		await setPolicy({
			missedClockOutReminderMinutes: 30,
			autoClockOutMinutes: 60,
			longShiftMinutes: 720,
		})
		await addEntry({ staffId: person.id, clockInAt: T0 })
		const result = await tick(T0 + 13 * HOUR)
		const serialized = JSON.stringify(result)
		for (const secret of [
			person.id,
			'Rana',
			'Khalid',
			'rana@example.com',
			String(T0),
		]) {
			expect(serialized).not.toContain(secret)
		}
	})
})
