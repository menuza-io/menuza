import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ManagerAlertEvent, managerAlertEventSchema } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	notificationOutbox,
	onboardingTasks,
	provisionTenantDb,
	staffAuditLog,
	staffCertificates,
	staffMembers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { ORG_A, stubStaffEnv } from '../../tests/staff-harness.ts'
import { eraseLinkedUser, exportSubject } from './staff-internal-service.ts'
import {
	resetStaffTickTasks,
	resetTickLocks,
	runStaffTickForOrg,
	type TickDeps,
} from './staff-tick-service.ts'

// 2026-10-14 12:00 UTC: Wednesday.
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)

let directory: string
let db: TenantDatabase
let alerts: ManagerAlertEvent[]
let flags: {
	enabled: boolean
	timeclock: boolean
	scheduling: boolean
	hiring: boolean
}
let deps: Partial<TickDeps>
let now: number
let zone: string

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-tick-'))
	stubStaffEnv(directory, 'us')
	await provisionTenantDb(ORG_A)
	db = await getTenantDb(ORG_A)
	resetTickLocks()
	resetStaffTickTasks()
	alerts = []
	now = NOW
	zone = 'UTC'
	flags = { enabled: true, timeclock: true, scheduling: true, hiring: true }
	deps = {
		now: () => now,
		getFeatures: async () => ({ features: { ...flags }, dataRegion: 'us' }),
		getScope: async () => ({ name: 'Downtown', timeZone: zone }),
		listShifts: async () => undefined,
		sendEmail: async () => ({ status: 'success' }),
		notifyManagers: async (event) => {
			alerts.push(event)
			return { status: 'delivered', result: { inApp: 1, emailed: 1 } }
		},
		emailEnabled: () => true,
	}
})

afterEach(async () => {
	try {
		await destroyTenantDb(ORG_A)
	} catch {
		// already gone
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
	resetStaffTickTasks()
})

const tick = () => runStaffTickForOrg(ORG_A, { db, deps })

async function person(over: Partial<typeof staffMembers.$inferInsert> = {}) {
	const [row] = await db
		.insert(staffMembers)
		.values({
			firstName: 'Sara',
			lastName: 'Ali',
			primaryScopeId: 'loc-1',
			status: 'active',
			...over,
		})
		.returning()
	return row!
}

async function task(
	staffId: string,
	over: Partial<typeof onboardingTasks.$inferInsert> = {},
) {
	const [row] = await db
		.insert(onboardingTasks)
		.values({ staffId, title: 'T', dueDate: '2026-10-14', ...over })
		.returning()
	return row!
}

const outbox = (kind: string) =>
	db.select().from(notificationOutbox).where(eq(notificationOutbox.kind, kind))

describe('onboarding task reminders', () => {
	it('alerts managers once when a task is due, with a count and nothing else', async () => {
		const sara = await person()
		const omar = await person({ firstName: 'Omar' })
		await task(sara.id)
		await task(omar.id, { dueDate: '2026-10-13' })
		await task(sara.id, { dueDate: '2026-10-20' })
		const result = await tick()
		expect(result.status).toBe('ran')
		expect(alerts).toHaveLength(1)
		expect(alerts[0]).toMatchObject({
			kind: 'onboarding_due',
			scopeId: 'loc-1',
			count: 2,
		})
		expect(managerAlertEventSchema.safeParse(alerts[0]).success).toBe(true)
		// No name, task, date or staff id leaves the region.
		const wire = JSON.stringify(alerts)
		for (const secret of ['Sara', 'Omar', sara.id, omar.id, '2026-10', 'T"']) {
			expect(wire).not.toContain(secret)
		}
	})

	it('does not repeat the same stage on later ticks', async () => {
		const sara = await person()
		const first = await task(sara.id)
		await tick()
		await tick()
		await tick()
		expect(alerts).toHaveLength(1)
		const [row] = await db
			.select()
			.from(onboardingTasks)
			.where(eq(onboardingTasks.id, first.id))
		expect(row!.remindedStage).toBe(1)
		expect(await outbox('manager.onboarding_due')).toHaveLength(1)
	})

	it('reminds again once the task has been overdue three days', async () => {
		const sara = await person()
		await task(sara.id, { dueDate: '2026-10-14' })
		await tick()
		expect(alerts).toHaveLength(1)
		now = NOW + 3 * 86_400_000
		await tick()
		expect(alerts).toHaveLength(2)
		expect(alerts[1]).toMatchObject({ kind: 'onboarding_due', count: 1 })
		now = NOW + 10 * 86_400_000
		await tick()
		// Two reminders per task, at most.
		expect(alerts).toHaveLength(2)
	})

	it('goes straight to the overdue reminder for a task already long overdue', async () => {
		const sara = await person()
		const old = await task(sara.id, { dueDate: '2026-09-01' })
		await tick()
		expect(alerts).toHaveLength(1)
		const rows = await outbox('manager.onboarding_due')
		expect(rows).toHaveLength(1)
		expect(rows[0]!.dedupeKey).toBe(
			`manager.onboarding_due:${old.id}:2:2026-09-01`,
		)
	})

	it('ignores finished, skipped, undated and not-yet-due tasks', async () => {
		const sara = await person()
		await task(sara.id, { status: 'done' })
		await task(sara.id, { status: 'skipped', dueDate: '2026-01-01' })
		await task(sara.id, { dueDate: null })
		await task(sara.id, { dueDate: '2026-10-15' })
		await tick()
		expect(alerts).toEqual([])
		expect(await outbox('manager.onboarding_due')).toEqual([])
	})

	it('ignores people who have left', async () => {
		const gone = await person({ status: 'terminated' })
		await task(gone.id, { dueDate: '2026-01-01' })
		await person()
		await tick()
		expect(alerts).toEqual([])
	})

	it("counts the due day in the scope's own time zone", async () => {
		// 2026-10-14 23:30 UTC is already the 15th in Riyadh.
		now = Date.UTC(2026, 9, 14, 23, 30, 0)
		const sara = await person()
		await task(sara.id, { dueDate: '2026-10-15' })
		zone = 'UTC'
		await tick()
		expect(alerts).toEqual([])
		zone = 'Asia/Riyadh'
		await tick()
		expect(alerts).toHaveLength(1)
	})

	it('and does not fire early where the day has not started', async () => {
		// 2026-10-14 02:00 UTC is still the 13th in Los Angeles.
		now = Date.UTC(2026, 9, 14, 2, 0, 0)
		const sara = await person()
		await task(sara.id, { dueDate: '2026-10-14' })
		zone = 'America/Los_Angeles'
		await tick()
		expect(alerts).toEqual([])
		const [row] = await db.select().from(onboardingTasks)
		expect(row!.remindedStage).toBe(0)
	})

	it('groups by scope', async () => {
		const a = await person({ primaryScopeId: 'loc-1' })
		const b = await person({ primaryScopeId: 'loc-2' })
		await task(a.id)
		await task(b.id)
		await tick()
		expect(alerts.map((e) => [e.scopeId, e.count]).sort()).toEqual([
			['loc-1', 1],
			['loc-2', 1],
		])
	})

	it('does nothing while the hiring flag is off, and catches up when it is on', async () => {
		const sara = await person()
		await task(sara.id)
		flags.hiring = false
		await tick()
		expect(alerts).toEqual([])
		expect(await outbox('manager.onboarding_due')).toEqual([])
		flags.hiring = true
		await tick()
		expect(alerts).toHaveLength(1)
	})

	it('does nothing while the staffing master switch is off', async () => {
		const sara = await person()
		await task(sara.id)
		flags = {
			enabled: false,
			timeclock: false,
			scheduling: false,
			hiring: false,
		}
		const result = await tick()
		expect(result.status).toBe('skipped')
		expect(alerts).toEqual([])
	})

	it("keeps a task's reminder pending when the App is unreachable", async () => {
		const sara = await person()
		await task(sara.id)
		deps.notifyManagers = async () => ({ status: 'retry', code: 'http_503' })
		await tick()
		const [row] = await outbox('manager.onboarding_due')
		expect(row).toMatchObject({ status: 'pending', attempts: 1 })
		// Not queued a second time while it waits.
		await tick()
		expect(await outbox('manager.onboarding_due')).toHaveLength(1)
	})

	it('a postponed task reminds on its new day', async () => {
		const sara = await person()
		const t = await task(sara.id)
		await tick()
		expect(alerts).toHaveLength(1)
		await db
			.update(onboardingTasks)
			.set({ dueDate: '2026-10-16', remindedStage: 0 })
			.where(eq(onboardingTasks.id, t.id))
		now = NOW + 2 * 86_400_000
		await tick()
		expect(alerts).toHaveLength(2)
	})

	it('survives a task failing: other work still runs', async () => {
		const sara = await person()
		await task(sara.id)
		await db.run(
			`CREATE TRIGGER boom BEFORE UPDATE ON onboarding_tasks BEGIN SELECT RAISE(ABORT, 'boom'); END` as never,
		)
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const result = await tick()
		expect(result.status).toBe('ran')
		if (result.status === 'ran') {
			expect(result.tasks.find((t) => t.name === 'onboarding')?.status).toBe(
				'error',
			)
		}
		errors.mockRestore()
	})
})

describe('certificate expiry alerts', () => {
	const cert = async (
		staffId: string,
		expiresOn: string | null,
		over: Partial<typeof staffCertificates.$inferInsert> = {},
	) => {
		const [row] = await db
			.insert(staffCertificates)
			.values({ staffId, kind: 'food_handler', expiresOn, ...over })
			.returning()
		return row!
	}

	it('alerts when a certificate enters its last thirty days, then when it expires', async () => {
		const sara = await person()
		await cert(sara.id, '2026-11-10')
		await tick()
		expect(alerts).toHaveLength(1)
		expect(alerts[0]).toMatchObject({ kind: 'certificate_expiring', count: 1 })
		await tick()
		expect(alerts).toHaveLength(1)
		now = Date.UTC(2026, 10, 11, 12)
		await tick()
		expect(alerts).toHaveLength(2)
		now = Date.UTC(2026, 11, 30, 12)
		await tick()
		expect(alerts).toHaveLength(2)
	})

	it('is quiet for a certificate that is fine, has no expiry, or belongs to someone who left', async () => {
		const sara = await person()
		const gone = await person({ status: 'terminated' })
		await cert(sara.id, '2027-06-01')
		await cert(sara.id, null)
		await cert(gone.id, '2026-01-01')
		await tick()
		expect(alerts).toEqual([])
	})

	it('batches several certificates at one scope into one alert', async () => {
		const a = await person()
		const b = await person({ firstName: 'Omar' })
		await cert(a.id, '2026-10-20')
		await cert(b.id, '2026-10-01')
		await tick()
		expect(alerts).toHaveLength(1)
		expect(alerts[0]!.count).toBe(2)
		expect(JSON.stringify(alerts)).not.toMatch(/Sara|Omar|2026-10/)
	})

	it('alerts again after a renewal runs out', async () => {
		const sara = await person()
		const c = await cert(sara.id, '2026-10-20')
		await tick()
		expect(alerts).toHaveLength(1)
		await db
			.update(staffCertificates)
			.set({ expiresOn: '2026-12-01', alertStage: 0 })
			.where(eq(staffCertificates.id, c.id))
		await tick()
		expect(alerts).toHaveLength(1)
		now = Date.UTC(2026, 10, 25, 12)
		await tick()
		expect(alerts).toHaveLength(2)
	})

	it('does not alert while the hiring flag is off', async () => {
		const sara = await person()
		await cert(sara.id, '2026-10-01')
		flags.hiring = false
		await tick()
		expect(alerts).toEqual([])
	})
})

describe('erasure and export', () => {
	it("erasing a login removes the person's checklist and certificates", async () => {
		const sara = await person({ userId: 'user-1' })
		const other = await person({ firstName: 'Other' })
		await task(sara.id)
		await task(other.id)
		await db
			.insert(staffCertificates)
			.values({ staffId: sara.id, kind: 'first_aid', note: 'private' })
		await db
			.insert(staffCertificates)
			.values({ staffId: other.id, kind: 'first_aid' })
		const result = await eraseLinkedUser(db, { userId: 'user-1' })
		expect(result.ok).toBe(true)
		const tasks = await db.select().from(onboardingTasks)
		expect(tasks.map((t) => t.staffId)).toEqual([other.id])
		const certs = await db.select().from(staffCertificates)
		expect(certs.map((c) => c.staffId)).toEqual([other.id])
		const audit = (await db.select().from(staffAuditLog)).find(
			(r) => r.action === 'staff.erased',
		)
		expect(audit?.changes).toMatchObject({
			onboardingTasksDeleted: 1,
			certificatesDeleted: 1,
		})
	})

	it("a person's own export lists their tasks and certificates, and hides operator ids", async () => {
		const sara = await person({ userId: 'user-9' })
		await task(sara.id, {
			title: 'Order uniform',
			status: 'done',
			completedBy: 'operator-7',
		})
		await db.insert(staffCertificates).values({
			staffId: sara.id,
			kind: 'food_handler',
			expiresOn: '2027-01-01',
		})
		const result = await exportSubject(
			db,
			{ userId: 'user-9' },
			{ orgId: ORG_A },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const file = result.value.export as {
			staff: Array<{
				onboardingTasks: Array<Record<string, unknown>>
				certificates: Array<Record<string, unknown>>
			}>
		}
		expect(file.staff[0]!.onboardingTasks[0]).toMatchObject({
			title: 'Order uniform',
			status: 'done',
		})
		expect(file.staff[0]!.certificates[0]).toMatchObject({
			kind: 'food_handler',
			expiresOn: '2027-01-01',
		})
		expect(JSON.stringify(file)).not.toContain('operator-7')
	})
})
