import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ManagerAlertEvent, managerAlertEventSchema } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	hiringApplications,
	hiringInterviews,
	hiringNotes,
	notificationOutbox,
	provisionTenantDb,
	staffAuditLog,
	staffMembers,
	type TenantDatabase,
} from '@repo/tenant-db'
import { ORG_A, stubStaffEnv } from '../../tests/staff-harness.ts'
import { seedApplication } from '../../tests/hiring-harness.ts'
import {
	eraseLinkedUser,
	exportSubject,
	summarizeStaff,
} from './staff-internal-service.ts'
import { purgeExpiredApplications, RETENTION_BATCH } from './hiring-service.ts'
import {
	resetStaffTickTasks,
	resetTickLocks,
	runStaffTickForOrg,
	type TickDeps,
} from './staff-tick-service.ts'

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)
const DAY = 86_400_000

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

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hiring-tick-'))
	stubStaffEnv(directory, 'us')
	await provisionTenantDb(ORG_A)
	db = await getTenantDb(ORG_A)
	resetTickLocks()
	resetStaffTickTasks()
	alerts = []
	flags = { enabled: true, timeclock: true, scheduling: true, hiring: true }
	deps = {
		now: () => NOW,
		getFeatures: async () => ({ features: { ...flags }, dataRegion: 'us' }),
		getScope: async () => ({ name: 'Downtown', timeZone: 'UTC' }),
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

function tick() {
	return runStaffTickForOrg(ORG_A, { db, deps })
}

async function remaining() {
	return db.select().from(hiringApplications)
}

describe('retention of declined applicants', () => {
	it('purges declined applicants past their period and nobody else', async () => {
		const expired = await seedApplication(db, {
			firstName: 'Expired',
			stage: 'declined',
			declinedAt: NOW - 400 * DAY,
			retentionExpiresAt: NOW - DAY,
		})
		await seedApplication(db, {
			firstName: 'NotYet',
			stage: 'declined',
			declinedAt: NOW - DAY,
			retentionExpiresAt: NOW + 30 * DAY,
		})
		await seedApplication(db, { firstName: 'InPipeline', stage: 'interview' })
		// A stage that should never carry a retention date, but must not be purged
		// even if one is present.
		await seedApplication(db, {
			firstName: 'Hired',
			stage: 'hired',
			retentionExpiresAt: NOW - DAY,
		})
		await seedApplication(db, {
			firstName: 'Reopened',
			stage: 'screening',
			retentionExpiresAt: NOW - DAY,
		})
		await db
			.insert(hiringNotes)
			.values({ applicationId: expired.id, authorId: 'op', body: 'private' })
		await db.insert(hiringInterviews).values({
			applicationId: expired.id,
			scheduledAt: 1,
			createdBy: 'op',
		})

		const result = await purgeExpiredApplications(db, NOW)
		expect(result).toEqual({ purged: 1 })
		const names = (await remaining()).map((r) => r.firstName).sort()
		expect(names).toEqual(['Hired', 'InPipeline', 'NotYet', 'Reopened'])
		expect(await db.select().from(hiringNotes)).toHaveLength(0)
		expect(await db.select().from(hiringInterviews)).toHaveLength(0)
	})

	it('leaves the audit log alone and records the purge as a count without names', async () => {
		const gone = await seedApplication(db, {
			firstName: 'Zainab',
			email: 'zainab@example.com',
			stage: 'declined',
			retentionExpiresAt: NOW - 1,
		})
		await db.insert(staffAuditLog).values({
			actorId: 'op',
			action: 'hiring.application.declined',
			entityType: 'application',
			entityId: gone.id,
			changes: { from: 'new', reason: 'not_a_fit' },
		})
		const before = (await db.select().from(staffAuditLog)).length
		await purgeExpiredApplications(db, NOW)
		const after = await db.select().from(staffAuditLog)
		expect(after.length).toBe(before + 1)
		expect(after.some((r) => r.entityId === gone.id)).toBe(true)
		const purge = after.find((r) => r.action === 'hiring.applications.purged')
		expect(purge).toMatchObject({
			actorKind: 'system',
			changes: { count: 1, reason: 'retention' },
		})
		expect(JSON.stringify(after)).not.toMatch(/Zainab|zainab@/)
	})

	it('does nothing, and writes nothing, when nothing is due', async () => {
		await seedApplication(db, {
			stage: 'declined',
			retentionExpiresAt: NOW + DAY,
		})
		expect(await purgeExpiredApplications(db, NOW)).toEqual({ purged: 0 })
		expect(
			(await db.select().from(staffAuditLog)).filter((r) =>
				r.action.startsWith('hiring.applications'),
			),
		).toHaveLength(0)
	})

	it('works through a backlog in bounded batches', async () => {
		const total = RETENTION_BATCH + 5
		await db.insert(hiringApplications).values(
			Array.from({ length: total }, (_, i) => ({
				postingId: 'p',
				postingSlug: 's',
				postingTitle: 'T',
				firstName: `N${i}`,
				lastName: 'L',
				stage: 'declined' as const,
				retentionExpiresAt: NOW - 1,
				consentAt: 1,
				consentVersion: '2026-10',
			})),
		)
		expect((await purgeExpiredApplications(db, NOW)).purged).toBe(
			RETENTION_BATCH,
		)
		expect((await purgeExpiredApplications(db, NOW)).purged).toBe(5)
		expect(await remaining()).toHaveLength(0)
	})

	it('runs in the tick, even for an organization with no staff and the hiring flag off', async () => {
		await seedApplication(db, {
			stage: 'declined',
			retentionExpiresAt: NOW - 1,
		})
		flags.hiring = false
		const result = await tick()
		expect(result.status).toBe('ran')
		expect(
			result.tasks.find((t) => t.name === 'hiring_retention'),
		).toMatchObject({
			status: 'ok',
			purged: 1,
		})
		expect(await remaining()).toHaveLength(0)
		// Idempotent: with nothing left the organization costs a local query.
		const again = await tick()
		expect(again).toMatchObject({ status: 'skipped', reason: 'no_staff' })
	})

	it('does not run while the master switch is off', async () => {
		await seedApplication(db, {
			stage: 'declined',
			retentionExpiresAt: NOW - 1,
		})
		flags.enabled = false
		const result = await tick()
		expect(result).toMatchObject({
			status: 'skipped',
			reason: 'staffing_disabled',
		})
		expect(await remaining()).toHaveLength(1)
	})
})

describe('the new-applicant manager alert', () => {
	async function queue(count: number, scopeId: string | null) {
		for (let i = 0; i < count; i++) {
			const app = await seedApplication(db, { scopeId })
			await db.insert(notificationOutbox).values({
				kind: 'manager.new_applicant',
				staffId: 'system',
				scopeId,
				dedupeKey: `manager.new_applicant:${app.id}`,
				payload: {},
				nextAttemptAt: NOW - 1,
				createdAt: NOW - 1,
			})
		}
	}

	it('reaches the App as one generic event per scope with a count and no person', async () => {
		await queue(3, 'loc-1')
		await queue(1, 'loc-2')
		const result = await tick()
		expect(result.status).toBe('ran')
		expect(alerts).toHaveLength(2)
		const byScope = Object.fromEntries(alerts.map((a) => [a.scopeId, a.count]))
		expect(byScope).toEqual({ 'loc-1': 3, 'loc-2': 1 })
		for (const alert of alerts) {
			expect(alert.kind).toBe('new_applicant')
			expect(managerAlertEventSchema.safeParse(alert).success).toBe(true)
			expect(Object.keys(alert).sort()).toEqual(
				['count', 'eventId', 'kind', 'scopeId', 'orgId'].sort(),
			)
		}
		const rows = await db.select().from(notificationOutbox)
		expect(rows.every((r) => r.status === 'sent')).toBe(true)
		// Delivered once: a second pass sends nothing.
		await tick()
		expect(alerts).toHaveLength(2)
	})

	it('is delivered for an organization hiring its first job, before it has any staff', async () => {
		await queue(1, 'loc-1')
		expect((await db.select().from(staffMembers)).length).toBe(0)
		const result = await tick()
		expect(result).toMatchObject({ status: 'ran' })
		expect(alerts).toHaveLength(1)
	})

	it('waits while hiring is off and is never delivered for a module that is off', async () => {
		await queue(1, 'loc-1')
		flags.hiring = false
		await tick()
		expect(alerts).toHaveLength(0)
		const [row] = await db.select().from(notificationOutbox)
		expect(row?.status).toBe('pending')
	})

	it('keeps retrying when the App cannot be reached', async () => {
		await queue(1, 'loc-1')
		deps.notifyManagers = async () => ({
			status: 'retry',
			code: 'network_error',
		})
		await tick()
		const [row] = await db.select().from(notificationOutbox)
		expect(row).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastError: 'network_error',
		})
		expect(row!.nextAttemptAt).toBeGreaterThan(NOW)
	})
})

describe('erasure and counts', () => {
	it('summarizes applicants as a count only', async () => {
		await seedApplication(db)
		await seedApplication(db)
		const summary = await summarizeStaff(db)
		expect(summary.applicants).toBe(2)
		expect(JSON.stringify(summary)).not.toMatch(/Sara|example/)
	})

	it('erasing a login also erases the application the person was hired from', async () => {
		const [staff] = await db
			.insert(staffMembers)
			.values({ firstName: 'Sara', lastName: 'Ali', userId: 'user-1' })
			.returning()
		const hired = await seedApplication(db, {
			stage: 'hired',
			hiredStaffId: staff!.id,
			email: 'sara@example.com',
		})
		await db
			.insert(hiringNotes)
			.values({ applicationId: hired.id, authorId: 'op', body: 'note' })
		const other = await seedApplication(db, { firstName: 'Other' })

		const result = await eraseLinkedUser(db, { userId: 'user-1' })
		expect(result).toEqual({ ok: true, value: { erased: 1 } })
		const left = await remaining()
		expect(left.map((r) => r.id)).toEqual([other.id])
		expect(await db.select().from(hiringNotes)).toHaveLength(0)
		const audit = (await db.select().from(staffAuditLog)).find(
			(r) => r.action === 'staff.erased',
		)
		expect(
			(audit?.changes as { applicationsErased: number }).applicationsErased,
		).toBe(1)
	})

	it("a person's own export carries the answers they gave when they applied", async () => {
		const [staff] = await db
			.insert(staffMembers)
			.values({ firstName: 'Sara', lastName: 'Ali', userId: 'user-9' })
			.returning()
		await seedApplication(db, {
			stage: 'hired',
			hiredStaffId: staff!.id,
			screenerFlags: ['weekends'],
			screenerScore: 7,
		})
		const result = await exportSubject(
			db,
			{ userId: 'user-9' },
			{ orgId: ORG_A },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const file = result.value.export as {
			staff: Array<{ application: Record<string, unknown> }>
		}
		const application = file.staff[0]!.application
		expect(application.answers).toEqual(expect.any(Array))
		expect(application).toMatchObject({
			postingTitle: 'Line cook',
			consentVersion: '2026-10',
		})
		// The employer's screening result is not part of what the person wrote.
		expect(JSON.stringify(application)).not.toContain('screener')
		expect(application).not.toHaveProperty('screenerScore')
	})
})
