import { SETUP_REMINDER_WORKFLOW } from '@repo/common/setup-reminders'
import { db, eq, NotificationPreference } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './notifications.tsx'

async function post(
	slug: string,
	cookie: string,
	values: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`https://app.test/${slug}/settings/notifications`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	try {
		return await action({
			request,
			params: { orgSlug: slug },
			context: {},
		} as never)
	} catch (error) {
		if (error instanceof Response) return error
		throw error
	}
}

async function load(slug: string, cookie: string) {
	return (await loader({
		request: createAuthenticatedRequest(
			`https://app.test/${slug}/settings/notifications`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as { setupReminders: { on: boolean } | null }
}

describe('setup reminder switch in Notification settings (#271)', () => {
	it('is on for an owner by default, and the owner can turn it off and on again', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).setupReminders).toEqual({
			on: true,
		})
		await post(organization.slug, cookie, {
			intent: 'setup-reminders',
			enabled: 'false',
		})
		const [row] = await db
			.select()
			.from(NotificationPreference)
			.where(eq(NotificationPreference.userId, user.id))
		expect(row).toMatchObject({
			organizationId: organization.id,
			workflow: SETUP_REMINDER_WORKFLOW,
			email: false,
		})
		expect((await load(organization.slug, cookie)).setupReminders).toEqual({
			on: false,
		})
		await post(organization.slug, cookie, {
			intent: 'setup-reminders',
			enabled: 'true',
		})
		expect((await load(organization.slug, cookie)).setupReminders).toEqual({
			on: true,
		})
	})

	it('is not offered to a member who is not an owner, and cannot be set by one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)
		expect((await load(organization.slug, cookie)).setupReminders).toBeNull()
		const response = await post(organization.slug, cookie, {
			intent: 'setup-reminders',
			enabled: 'false',
		})
		expect((response as Response).status).toBe(403)
		expect(
			await db
				.select()
				.from(NotificationPreference)
				.where(eq(NotificationPreference.userId, member.id)),
		).toEqual([])
	})
})
