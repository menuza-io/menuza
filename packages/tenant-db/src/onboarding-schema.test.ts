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
	onboardingTasks,
	onboardingTemplates,
	onboardingTemplateTasks,
	staffCertificates,
	staffMembers,
} from './schema.ts'

describe('onboarding schema', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-onboarding-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await client.execute('PRAGMA foreign_keys = ON')
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

	async function staff() {
		const [row] = await db
			.insert(staffMembers)
			.values({ firstName: 'Sara', lastName: 'Ali' })
			.returning()
		return row!
	}

	it('keeps tasks created before the migration valid, as custom manager tasks', async () => {
		const person = await staff()
		const [task] = await db
			.insert(onboardingTasks)
			.values({ staffId: person.id, taskKey: 'confirm_contact' })
			.returning()
		expect(task).toMatchObject({
			type: 'custom',
			assignee: 'manager',
			assigneeUserId: null,
			templateId: null,
			remindedStage: 0,
			status: 'todo',
		})
	})

	it('allows only one live default template, and a new one after archiving', async () => {
		await db.insert(onboardingTemplates).values({ name: 'A', isDefault: true })
		await expect(
			db.insert(onboardingTemplates).values({ name: 'B', isDefault: true }),
		).rejects.toThrow()
		await db
			.update(onboardingTemplates)
			.set({ archivedAt: 1, isDefault: false })
			.where(eq(onboardingTemplates.name, 'A'))
		await db.insert(onboardingTemplates).values({ name: 'B', isDefault: true })
		// Any number of non-default templates.
		await db.insert(onboardingTemplates).values([{ name: 'C' }, { name: 'D' }])
		expect(await db.select().from(onboardingTemplates)).toHaveLength(4)
	})

	it('deletes template tasks with their template', async () => {
		const [template] = await db
			.insert(onboardingTemplates)
			.values({ name: 'A' })
			.returning()
		await db
			.insert(onboardingTemplateTasks)
			.values({ templateId: template!.id, title: 'T' })
		await db
			.delete(onboardingTemplates)
			.where(eq(onboardingTemplates.id, template!.id))
		expect(await db.select().from(onboardingTemplateTasks)).toHaveLength(0)
	})

	it("keeps a person's tasks when the template they came from is deleted", async () => {
		const person = await staff()
		const [template] = await db
			.insert(onboardingTemplates)
			.values({ name: 'A' })
			.returning()
		await db.insert(onboardingTasks).values({
			staffId: person.id,
			title: 'T',
			templateId: template!.id,
		})
		await db
			.delete(onboardingTemplates)
			.where(eq(onboardingTemplates.id, template!.id))
		const [task] = await db.select().from(onboardingTasks)
		expect(task).toMatchObject({ title: 'T', templateId: null })
	})

	it('removes checklists and certificates with the person', async () => {
		const person = await staff()
		await db.insert(onboardingTasks).values({ staffId: person.id, title: 'T' })
		await db
			.insert(staffCertificates)
			.values({ staffId: person.id, kind: 'food_handler' })
		await db.delete(staffMembers).where(eq(staffMembers.id, person.id))
		expect(await db.select().from(onboardingTasks)).toHaveLength(0)
		expect(await db.select().from(staffCertificates)).toHaveLength(0)
	})

	it('holds no identity, tax or bank columns', async () => {
		const result = await client.execute(
			"SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('onboarding_templates','onboarding_template_tasks','onboarding_tasks','staff_certificates')",
		)
		const columns = result.rows.map((row) => String(row.col))
		for (const forbidden of [
			/ssn/i,
			/national/i,
			/tax/i,
			/iban/i,
			/bank/i,
			/passport/i,
			/number/i,
			/document/i,
			/file/i,
		]) {
			expect(columns.filter((c) => forbidden.test(c))).toEqual([])
		}
	})
})
