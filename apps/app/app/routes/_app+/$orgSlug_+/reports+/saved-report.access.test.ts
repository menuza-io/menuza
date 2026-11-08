import { db, eq, SavedReport } from '@repo/database'
import { createReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './$reportId.tsx'

function definition(subject: 'notes' | 'time_entries', columns: string[]) {
	return createReportDefinition({
		subject,
		timeframe: { field: 'createdAt', preset: 'all_time' },
		groupBy: [],
		columns,
		visualization: {
			chartStyle: 'table',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Saved', notes: '', timezone: 'UTC' },
	})
}

async function save(
	orgSlug: string,
	reportId: string,
	cookie: string,
	body: ReturnType<typeof definition>,
) {
	const form = new FormData()
	form.set('definition', JSON.stringify(body))
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${orgSlug}/reports/${reportId}`,
		{ method: 'POST', body: form },
		cookie,
	)
	try {
		return await action({
			request,
			params: { orgSlug, reportId },
			context: {},
		} as never)
	} catch (error) {
		return error as Response
	}
}

describe('saved report overwrite', () => {
	it('refuses a member who may not open the stored report and leaves it untouched', async () => {
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const stored = definition('time_entries', ['clockInAt'])
		const [report] = await db
			.insert(SavedReport)
			.values({
				scope: 'organization',
				organizationId: organization.id,
				createdById: admin.id,
				title: 'Admin only',
				notes: '',
				definition: JSON.stringify(stored),
			})
			.returning()
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)

		const result = await save(
			organization.slug,
			report!.id,
			cookie,
			definition('notes', ['title']),
		)
		expect(result).toBeInstanceOf(Response)
		expect((result as Response).status).toBe(404)

		const [after] = await db
			.select()
			.from(SavedReport)
			.where(eq(SavedReport.id, report!.id))
		expect(after!.createdById).toBe(admin.id)
		expect(after!.definition).toBe(report!.definition)
		expect(after!.title).toBe('Admin only')
	})

	it('lets an allowed member update without taking over the creator', async () => {
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const [report] = await db
			.insert(SavedReport)
			.values({
				scope: 'organization',
				organizationId: organization.id,
				createdById: admin.id,
				title: 'Shared',
				notes: '',
				definition: JSON.stringify(definition('notes', ['title'])),
			})
			.returning()
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)

		const result = await save(
			organization.slug,
			report!.id,
			cookie,
			definition('notes', ['title', 'createdAt']),
		)
		expect(result).toMatchObject({ ok: true })
		const [after] = await db
			.select()
			.from(SavedReport)
			.where(eq(SavedReport.id, report!.id))
		expect(after!.createdById).toBe(admin.id)
		expect(after!.definition).not.toBe(report!.definition)
	})
})
