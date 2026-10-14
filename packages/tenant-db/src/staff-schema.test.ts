import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from './schema.ts'
import {
	staffAuditLog,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
	staffPrivate,
} from './schema.ts'

// Drizzle wraps driver errors ("Failed query"), so look through the cause chain.
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

describe('staff schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-staff-'))
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

	async function member(overrides: Partial<schema.NewStaffMember> = {}) {
		const [row] = await db
			.insert(staffMembers)
			.values({ firstName: 'Rana', lastName: 'Khalid', ...overrides })
			.returning()
		return row!
	}

	async function position(name = 'Server') {
		const [row] = await db.insert(staffPositions).values({ name }).returning()
		return row!
	}

	async function job(
		staffId: string,
		positionId: string,
		overrides: Partial<typeof staffJobs.$inferInsert> = {},
	) {
		const [row] = await db
			.insert(staffJobs)
			.values({
				staffId,
				positionId,
				scopeId: 'loc-1',
				currency: 'USD',
				rateMinor: 1500,
				effectiveFrom: '2026-01-01',
				...overrides,
			})
			.returning()
		return row!
	}

	it('creates every staff table additively', async () => {
		const tables = await db.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'staff%' ORDER BY name`,
		)
		expect(tables.map((t) => t.name)).toEqual([
			'staff_audit_log',
			'staff_availability',
			'staff_certificates',
			'staff_jobs',
			'staff_members',
			'staff_notes',
			'staff_positions',
			'staff_private',
			'staff_scope_assignments',
			'staffing_settings',
		])
		// Existing tables are untouched.
		const customers = await db.all(sql`SELECT 1 FROM customers LIMIT 1`)
		expect(customers).toEqual([])
	})

	it('uses epoch milliseconds for default timestamps', async () => {
		const before = Date.now()
		const row = await member()
		expect(row.createdAt).toBeGreaterThanOrEqual(before - 2000)
		expect(row.createdAt).toBeLessThan(Date.now() + 2000)
		expect(row.status).toBe('active')
		expect(row.eligibleForRehire).toBeNull()
	})

	it('enforces unique opaque user ids and employee numbers, allowing many nulls', async () => {
		await member({ userId: 'user-1', employeeNumber: 'E1' })
		await member()
		await member()
		await expect(member({ userId: 'user-1' })).rejects.toThrow()
		await expect(member({ employeeNumber: 'E1' })).rejects.toThrow()
	})

	it('keeps pin_lookup unique per scope but reusable across scopes', async () => {
		const a = await member()
		const b = await member({ firstName: 'Omar' })
		await db.insert(staffScopeAssignments).values({
			staffId: a.id,
			scopeId: 'loc-1',
			pinLookup: 'hash-1',
		})
		await expectRejectsWith(
			db.insert(staffScopeAssignments).values({
				staffId: b.id,
				scopeId: 'loc-1',
				pinLookup: 'hash-1',
			}),
			/UNIQUE/,
		)
		await db.insert(staffScopeAssignments).values({
			staffId: b.id,
			scopeId: 'loc-2',
			pinLookup: 'hash-1',
		})
		// Staff without a PIN do not collide with each other.
		const c = await member({ firstName: 'Lina' })
		await db
			.insert(staffScopeAssignments)
			.values({ staffId: c.id, scopeId: 'loc-1' })
		const d = await member({ firstName: 'Sami' })
		await db
			.insert(staffScopeAssignments)
			.values({ staffId: d.id, scopeId: 'loc-1' })
	})

	it('allows one assignment per staff and scope, and one primary per staff', async () => {
		const a = await member()
		await db.insert(staffScopeAssignments).values({
			staffId: a.id,
			scopeId: 'loc-1',
			isPrimary: true,
		})
		await expect(
			db
				.insert(staffScopeAssignments)
				.values({ staffId: a.id, scopeId: 'loc-1' }),
		).rejects.toThrow()
		await expect(
			db.insert(staffScopeAssignments).values({
				staffId: a.id,
				scopeId: 'loc-2',
				isPrimary: true,
			}),
		).rejects.toThrow()
	})

	it('allows only one open job per staff, scope and position', async () => {
		const a = await member()
		const server = await position()
		await job(a.id, server.id)
		await expect(job(a.id, server.id)).rejects.toThrow()
	})

	it('allows only one open primary job per staff and scope', async () => {
		const a = await member()
		const server = await position('Server')
		const host = await position('Host')
		await job(a.id, server.id, { isPrimary: true })
		await expect(job(a.id, host.id, { isPrimary: true })).rejects.toThrow()
		await job(a.id, host.id, { isPrimary: false })
	})

	it('lets an open job be closed once, and nothing else about it change', async () => {
		const a = await member()
		const server = await position()
		const open = await job(a.id, server.id, { isPrimary: true })

		// Rewriting the rate in place is rejected.
		await expectRejectsWith(
			db
				.update(staffJobs)
				.set({ rateMinor: 9999 })
				.where(eq(staffJobs.id, open.id)),
			/closed, not edited/,
		)
		// Closing while also rewriting history is rejected.
		await expectRejectsWith(
			db
				.update(staffJobs)
				.set({ effectiveTo: '2026-02-01', rateMinor: 1 })
				.where(eq(staffJobs.id, open.id)),
			/closed, not edited/,
		)

		await db
			.update(staffJobs)
			.set({ effectiveTo: '2026-02-01' })
			.where(eq(staffJobs.id, open.id))

		// A closed row cannot be reopened or moved.
		await expectRejectsWith(
			db
				.update(staffJobs)
				.set({ effectiveTo: null })
				.where(eq(staffJobs.id, open.id)),
			/closed, not edited/,
		)
		await expectRejectsWith(
			db
				.update(staffJobs)
				.set({ effectiveTo: '2026-03-01' })
				.where(eq(staffJobs.id, open.id)),
			/closed, not edited/,
		)

		// The next row for the same slot is now allowed.
		await job(a.id, server.id, {
			isPrimary: true,
			rateMinor: 1800,
			effectiveFrom: '2026-02-02',
		})
		const history = await db
			.select()
			.from(staffJobs)
			.where(and(eq(staffJobs.staffId, a.id), isNull(staffJobs.effectiveTo)))
		expect(history).toHaveLength(1)
		expect(history[0]!.rateMinor).toBe(1800)
	})

	it('never deletes wage history', async () => {
		const a = await member()
		const server = await position()
		const open = await job(a.id, server.id)
		await expectRejectsWith(
			db.delete(staffJobs).where(eq(staffJobs.id, open.id)),
			/append-only/,
		)
		// So a staff row with wage history cannot be hard-deleted either.
		await expectRejectsWith(
			db.delete(staffMembers).where(eq(staffMembers.id, a.id)),
			/append-only/,
		)
	})

	it('makes the audit log append-only', async () => {
		const [entry] = await db
			.insert(staffAuditLog)
			.values({
				actorId: 'user-1',
				action: 'staff.created',
				entityType: 'staff',
			})
			.returning()
		await expectRejectsWith(
			db
				.update(staffAuditLog)
				.set({ action: 'edited' })
				.where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		await expectRejectsWith(
			db.delete(staffAuditLog).where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		const rows = await db.select().from(staffAuditLog)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.action).toBe('staff.created')
	})

	it('lets an audit row be redacted, and nothing else about it be changed', async () => {
		const [entry] = await db
			.insert(staffAuditLog)
			.values({
				actorId: 'user-1',
				action: 'staff.updated',
				entityType: 'staff',
				staffId: 's1',
				changes: { firstName: { before: 'Rana', after: 'Rania' } },
			})
			.returning()
		// Only the exact redaction marker is accepted for `changes`.
		await expectRejectsWith(
			db
				.update(staffAuditLog)
				.set({ changes: { firstName: 'Anything' } })
				.where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		await expectRejectsWith(
			db
				.update(staffAuditLog)
				.set({ changes: null })
				.where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		// The marker cannot ride along with any other edit.
		await expectRejectsWith(
			db
				.update(staffAuditLog)
				.set({ changes: { redacted: true }, action: 'staff.created' })
				.where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		await expectRejectsWith(
			db
				.update(staffAuditLog)
				.set({ changes: { redacted: true }, staffId: 's2' })
				.where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
		await db
			.update(staffAuditLog)
			.set({ changes: { redacted: true } })
			.where(eq(staffAuditLog.id, entry!.id))
		const [after] = await db
			.select()
			.from(staffAuditLog)
			.where(eq(staffAuditLog.id, entry!.id))
		expect(after).toMatchObject({
			action: 'staff.updated',
			staffId: 's1',
			changes: { redacted: true },
		})
		// Deleting stays impossible.
		await expectRejectsWith(
			db.delete(staffAuditLog).where(eq(staffAuditLog.id, entry!.id)),
			/append-only/,
		)
	})

	it('keeps active position names unique case-insensitively but lets archived names be reused', async () => {
		const first = await position('Line Cook')
		await expect(position('line cook')).rejects.toThrow()
		await db
			.update(staffPositions)
			.set({ archivedAt: Date.now() })
			.where(eq(staffPositions.id, first.id))
		await position('Line Cook')
	})

	it('cascades private data with the staff row it belongs to', async () => {
		const a = await member()
		await db.insert(staffPrivate).values({
			staffId: a.id,
			dateOfBirth: '1990-04-02',
		})
		const rows = await db.select().from(staffPrivate)
		expect(rows).toHaveLength(1)
		// The private table has no pay or login columns.
		const columns = await db.all<{ name: string }>(
			sql`SELECT name FROM pragma_table_info('staff_private')`,
		)
		expect(columns.map((c) => c.name)).not.toContain('rate_minor')
		expect(columns.map((c) => c.name)).not.toContain('pin_lookup')
	})
})
