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
import {
	hiringApplications,
	hiringEvents,
	hiringInterviews,
	hiringNotes,
	onboardingTasks,
	staffMembers,
} from './schema.ts'

describe('hiring schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-hiring-'))
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

	const base = {
		postingId: 'post1',
		postingSlug: 'line-cook',
		postingTitle: 'Line cook',
		firstName: 'Sara',
		lastName: 'Ali',
		consentAt: 1_000,
		consentVersion: '2026-10',
	}

	it('starts an application as new with no answers and no flags', async () => {
		const [row] = await db
			.insert(hiringApplications)
			.values({ ...base, emailHash: 'h1' })
			.returning()
		expect(row).toMatchObject({
			stage: 'new',
			source: 'careers_page',
			answers: [],
			screenerFlags: [],
			screenerScore: null,
			hiredStaffId: null,
			retentionExpiresAt: null,
		})
	})

	it('refuses a second live application from the same email or phone to a posting', async () => {
		await db
			.insert(hiringApplications)
			.values({ ...base, emailHash: 'e1', phoneHash: 'p1' })
		await expect(
			db.insert(hiringApplications).values({ ...base, emailHash: 'e1' }),
		).rejects.toThrow()
		await expect(
			db.insert(hiringApplications).values({ ...base, phoneHash: 'p1' }),
		).rejects.toThrow()
		// Another posting, or another person, is fine.
		await db
			.insert(hiringApplications)
			.values({ ...base, postingId: 'post2', emailHash: 'e1' })
		await db.insert(hiringApplications).values({ ...base, emailHash: 'e2' })
	})

	it('lets a declined applicant apply again', async () => {
		const [first] = await db
			.insert(hiringApplications)
			.values({ ...base, emailHash: 'e1' })
			.returning()
		await db
			.update(hiringApplications)
			.set({ stage: 'declined' })
			.where(eq(hiringApplications.id, first!.id))
		await db.insert(hiringApplications).values({ ...base, emailHash: 'e1' })
		const rows = await db.select().from(hiringApplications)
		expect(rows).toHaveLength(2)
	})

	it('deletes notes, interviews and the timeline with the application', async () => {
		const [application] = await db
			.insert(hiringApplications)
			.values({ ...base, emailHash: 'e1' })
			.returning()
		const applicationId = application!.id
		await db
			.insert(hiringNotes)
			.values({ applicationId, authorId: 'u1', body: 'Good on the phone' })
		await db.insert(hiringInterviews).values({
			applicationId,
			scheduledAt: 5_000,
			createdBy: 'u1',
		})
		await db
			.insert(hiringEvents)
			.values({ applicationId, kind: 'applied', toStage: 'new' })
		await db
			.delete(hiringApplications)
			.where(eq(hiringApplications.id, applicationId))
		expect(await db.select().from(hiringNotes)).toHaveLength(0)
		expect(await db.select().from(hiringInterviews)).toHaveLength(0)
		expect(await db.select().from(hiringEvents)).toHaveLength(0)
	})

	it('keeps the application when the staff record it created is deleted', async () => {
		const [staff] = await db
			.insert(staffMembers)
			.values({ firstName: 'Sara', lastName: 'Ali' })
			.returning()
		const [application] = await db
			.insert(hiringApplications)
			.values({
				...base,
				emailHash: 'e1',
				hiredStaffId: staff!.id,
				stage: 'hired',
			})
			.returning()
		await db.delete(staffMembers).where(eq(staffMembers.id, staff!.id))
		const [after] = await db
			.select()
			.from(hiringApplications)
			.where(eq(hiringApplications.id, application!.id))
		expect(after?.hiredStaffId).toBeNull()
	})

	it("removes a person's checklist with the person and defaults tasks to todo", async () => {
		const [staff] = await db
			.insert(staffMembers)
			.values({ firstName: 'Sara', lastName: 'Ali' })
			.returning()
		const [task] = await db
			.insert(onboardingTasks)
			.values({ staffId: staff!.id, taskKey: 'confirm_contact' })
			.returning()
		expect(task).toMatchObject({ status: 'todo', source: 'hire', title: null })
		await db.delete(staffMembers).where(eq(staffMembers.id, staff!.id))
		expect(await db.select().from(onboardingTasks)).toHaveLength(0)
	})
})
