import { userHasOrganizationPermission } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { isPastDueStatus } from './past-due.ts'

/**
 * Whether to show the past-due banner (#237): the subscription is past due and
 * the viewer can manage billing (the same `update:settings:any` grant the
 * billing page's actions need). Everyone else sees nothing: they could not fix
 * it, and a failed card is not theirs to worry about. The state is the status
 * the Stripe webhook stored.
 */
export async function billingPastDueFor(input: {
	userId: string
	organization: { id: string; slug: string }
}): Promise<{ orgSlug: string } | null> {
	const [row] = await db
		.select({ subscriptionStatus: Organization.subscriptionStatus })
		.from(Organization)
		.where(eq(Organization.id, input.organization.id))
		.limit(1)
	if (!isPastDueStatus(row?.subscriptionStatus)) return null
	const canManage = await userHasOrganizationPermission(
		input.userId,
		input.organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	return canManage ? { orgSlug: input.organization.slug } : null
}
