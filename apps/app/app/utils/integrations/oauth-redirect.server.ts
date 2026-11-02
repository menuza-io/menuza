import { requireUserId } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { redirectDocument } from 'react-router'
import { setIntegrationOAuthState } from '#app/utils/integrations/oauth-state.server.ts'

/**
 * The `Set-Cookie` value that binds an integration sign-in to the browser and
 * member that start it (see `oauth-state.server.ts`). The callback accepts the
 * provider's answer only with this cookie, from the same signed-in member.
 */
export async function integrationOAuthHandoffCookie(
	request: Request,
	organizationId: string,
	provider: string,
	state: string,
): Promise<string> {
	const userId = await requireUserId(request)
	const [organization] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!organization) throw new Error('Organization not found')
	return setIntegrationOAuthState({
		state,
		provider,
		userId,
		orgSlug: organization.slug,
	})
}

/** Sends the member to the provider with the hand-off cookie set. */
export async function redirectToProviderWithHandoff(
	request: Request,
	organizationId: string,
	provider: string,
	authUrl: string,
	state: string,
) {
	return redirectDocument(authUrl, {
		headers: {
			'Set-Cookie': await integrationOAuthHandoffCookie(
				request,
				organizationId,
				provider,
				state,
			),
		},
	})
}
