import { db, eq, Organization } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './_layout.tsx'

async function layoutFor(slug: string, cookie: string) {
	return (await loader({
		request: createAuthenticatedRequest(
			`http://localhost:3001/${slug}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
	})) as { billingPastDue: { orgSlug: string } | null }
}

describe('org layout past-due banner (#237)', () => {
	it('exposes billingPastDue to billing managers only, and only while past due', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(
			(await layoutFor(organization.slug, cookie)).billingPastDue,
		).toBeNull()

		await db
			.update(Organization)
			.set({ subscriptionStatus: 'past_due', pastDueSince: new Date() })
			.where(eq(Organization.id, organization.id))
		expect((await layoutFor(organization.slug, cookie)).billingPastDue).toEqual(
			{
				orgSlug: organization.slug,
			},
		)

		// A viewer of the same organization sees nothing.
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const viewerSession = await createTestSession(viewer.id)
		expect(
			(await layoutFor(organization.slug, viewerSession.cookie)).billingPastDue,
		).toBeNull()

		// Paid again: the banner goes at once.
		await db
			.update(Organization)
			.set({ subscriptionStatus: 'active', pastDueSince: null })
			.where(eq(Organization.id, organization.id))
		expect(
			(await layoutFor(organization.slug, cookie)).billingPastDue,
		).toBeNull()
	})
})
