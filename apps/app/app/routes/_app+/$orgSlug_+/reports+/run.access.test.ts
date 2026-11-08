import { db, eq, UserOrganization } from '@repo/database'
import { createReportDefinition } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestNote,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './run.ts'

function definition(subject: 'notes' | 'members', columns: string[]) {
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
		settings: { title: 'Access', notes: '', timezone: 'UTC' },
	})
}

async function run(
	orgSlug: string,
	cookie: string,
	body: ReturnType<typeof definition>,
) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${orgSlug}/reports/run`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ definition: body }),
		},
		cookie,
	)
	const result = (await action({
		request,
		params: { orgSlug },
		context: {},
	} as never)) as { data: any; init?: { status?: number } | null }
	return { status: result.init?.status ?? 200, data: result.data }
}

async function setup() {
	const { user: admin, organization } = await setupTestOrgWithUser('admin')
	await createTestNote(organization.id, admin.id, {
		title: 'Secret admin plan',
		isPublic: false,
	})
	await createTestNote(organization.id, admin.id, {
		title: 'Public roadmap',
		isPublic: true,
	})
	const departed = await createTestUser()
	await addOrganizationMember(departed.id, organization.id, 'org_role_member')
	await db
		.update(UserOrganization)
		.set({ active: false })
		.where(eq(UserOrganization.userId, departed.id))
	return { organization, departed }
}

async function memberCookie(organizationId: string, role: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role)
	return (await createTestSession(user.id)).cookie
}

// Reports follow the same rules as the notes and members pages.
describe('report runner access', () => {
	it("shows a member public and own notes, never another member's private note", async () => {
		const { organization } = await setup()
		const cookie = await memberCookie(organization.id, 'org_role_member')
		const { status, data } = await run(
			organization.slug,
			cookie,
			definition('notes', ['title']),
		)
		expect({ status, data }).toMatchObject({ status: 200 })
		const titles = data.rows.map((row: { title: string }) => row.title)
		expect(titles).toContain('Public roadmap')
		expect(titles).not.toContain('Secret admin plan')
	})

	it('lists only active members', async () => {
		const { organization, departed } = await setup()
		const cookie = await memberCookie(organization.id, 'org_role_member')
		const { status, data } = await run(
			organization.slug,
			cookie,
			definition('members', ['email']),
		)
		expect(status).toBe(200)
		const emails = data.rows.map((row: { email: string }) => row.email)
		expect(emails).not.toContain(departed.email)
	})

	it('refuses both subjects to a guest without the page permissions', async () => {
		const { organization } = await setup()
		const cookie = await memberCookie(organization.id, 'org_role_guest')
		for (const subject of ['notes', 'members'] as const) {
			const { status } = await run(
				organization.slug,
				cookie,
				definition(subject, [subject === 'notes' ? 'title' : 'email']),
			)
			expect({ subject, status }).toEqual({ subject, status: 403 })
		}
	})
})
