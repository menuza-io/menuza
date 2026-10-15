import {
	authSessionStorage,
	logout,
	safeDocumentRedirect,
	sessionKey,
} from '@repo/auth'
import { db, eq, SSOSession } from '@repo/database'
import { getOrganizationBySlug } from '#app/utils/organization/organizations.server.ts'
import { ssoAuthService } from '#app/utils/sso/auth.server.ts'
import { ssoConfigurationService } from '#app/utils/sso/configuration.server.ts'
import { type Route } from './+types/auth.sso.$organizationSlug.logout.ts'

/**
 * Shared SSO logout logic used by both loader and action.
 * Handles organization lookup, SSO configuration check, token revocation, and logout.
 */
async function handleSSOLogout(
	request: Request,
	organizationSlug: string | undefined,
	redirectTo: string | null,
) {
	if (!organizationSlug) {
		throw new Response('Organization slug is required', { status: 400 })
	}

	// Get organization by slug
	const organization = await getOrganizationBySlug(organizationSlug)
	if (!organization) {
		// If organization doesn't exist, just do regular logout
		return logout({ request })
	}

	// Get SSO configuration
	const ssoConfig = await ssoConfigurationService.getConfiguration(
		organization.id,
	)
	if (!ssoConfig || !ssoConfig.isEnabled) {
		// If SSO not configured, just do regular logout
		return logout({ request })
	}

	// Get current session to check for SSO session
	const authSession = await authSessionStorage.getSession(
		request.headers.get('cookie'),
	)
	const sessionId = authSession.get(sessionKey)

	if (sessionId) {
		// Check if this is an SSO session
		const [ssoSession] = await db
			.select({ id: SSOSession.id })
			.from(SSOSession)
			.where(eq(SSOSession.sessionId, sessionId))
			.limit(1)

		if (ssoSession) {
			// Revoke tokens at the identity provider
			try {
				await ssoAuthService.revokeTokens(ssoSession.id)
			} catch (error) {
				// Token revocation is best-effort, continue with logout even if it fails
				console.warn('Failed to revoke SSO tokens:', error)
			}
		}
	}

	const safeRedirectTo = safeDocumentRedirect(redirectTo, '/login')

	// Perform regular logout (this will clean up the session)
	return logout({ request, redirectTo: safeRedirectTo })
}

export async function loader({ request, params }: Route.LoaderArgs) {
	// Get redirect URL from query params
	const url = new URL(request.url)
	const redirectTo = url.searchParams.get('redirectTo')

	return handleSSOLogout(request, params.organizationSlug, redirectTo)
}

export async function action({ request, params }: Route.ActionArgs) {
	// Get redirect URL from query params or form data
	const url = new URL(request.url)
	let redirectTo = url.searchParams.get('redirectTo')

	if (!redirectTo) {
		const formData = await request.formData()
		const rawRedirectTo = formData.get('redirectTo')
		redirectTo = typeof rawRedirectTo === 'string' ? rawRedirectTo : null
	}

	return handleSSOLogout(request, params.organizationSlug, redirectTo)
}
