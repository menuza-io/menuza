import { getUserId } from '@repo/auth'
import { combineHeaders } from '@repo/common'
import { getClientIp } from '@repo/common/ip-tracking'
import { ensurePrimary } from '@repo/common/litefs'
import {
	destroyRedirectToHeaders,
	getRedirectCookieValue,
} from '@repo/common/redirect-cookie'
import { createToastHeaders, redirectWithToast } from '@repo/common/toast'
import { SSOCallbackSchema } from '@repo/validation'
import { redirect } from 'react-router'
import { loginWithSSO } from '#app/utils/auth.server.ts'
import { getOrganizationBySlug } from '#app/utils/organization/organizations.server.ts'
import {
	ssoAuditLogger,
	SSOAuditEventType,
	auditSSOAuthSuccess,
	auditSSOAuthFailed,
} from '#app/utils/sso/audit-logging.server.ts'
import { ssoAuthService } from '#app/utils/sso/auth.server.ts'
import { ssoConfigurationService } from '#app/utils/sso/configuration.server.ts'
import {
	handleSSOError,
	createSSOError,
	SSOErrorType,
	handleOAuthError,
} from '#app/utils/sso/error-handling.server.ts'
import { consumeNonce } from '#app/utils/sso/nonce.server.ts'
import { trackSuspiciousActivity } from '#app/utils/sso/rate-limit.server.ts'
import { validateSSOOrganization } from '#app/utils/sso/sanitization.server.ts'
import { type Route } from './+types/auth.sso.$organizationSlug.callback.ts'
import { handleNewSession } from './login.server.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	// this loader performs mutations, so we need to make sure we're on the
	// primary instance to avoid writing to a read-only replica
	await ensurePrimary()

	const clientIP = getClientIp(request)

	try {
		// Validate and sanitize organization slug (includes suspicious activity check)
		const organizationSlug = await validateSSOOrganization(
			request,
			params.organizationSlug,
		)
		const activityKey = `${organizationSlug}:${clientIP}`

		// Validate callback parameters
		const url = new URL(request.url)
		const callbackData = SSOCallbackSchema.parse({
			code: url.searchParams.get('code') || undefined,
			state: url.searchParams.get('state') || undefined,
			error: url.searchParams.get('error') || undefined,
			error_description: url.searchParams.get('error_description') || undefined,
			organizationSlug,
		})

		// Audit log the callback received
		await ssoAuditLogger.logAuthenticationEvent(
			SSOAuditEventType.AUTH_CALLBACK_RECEIVED,
			'unknown', // We don't have organization ID yet
			'SSO authentication callback received',
			undefined,
			undefined,
			{
				organizationSlug,
				hasCode: !!callbackData.code,
				hasError: !!callbackData.error,
				error: callbackData.error,
				errorDescription: callbackData.error_description,
			},
			request,
			'info',
		)

		// Check for OAuth errors first
		if (callbackData.error) {
			trackSuspiciousActivity(activityKey, 'failed_auth')

			// Audit log the OAuth error
			await auditSSOAuthFailed(
				'unknown', // We don't have organization ID yet
				`OAuth error: ${callbackData.error}`,
				{
					error: callbackData.error,
					errorDescription: callbackData.error_description,
					organizationSlug,
				},
				request,
			)

			const oauthError = handleOAuthError(
				callbackData.error,
				callbackData.error_description,
			)
			throw await handleSSOError(oauthError, '/login', request)
		}

		if (!callbackData.code) {
			trackSuspiciousActivity(activityKey, 'failed_auth')
			const error = createSSOError(
				SSOErrorType.INVALID_CALLBACK,
				'No authorization code received from identity provider',
			)
			throw await handleSSOError(error, '/login', request)
		}

		const redirectTo = getRedirectCookieValue(request)

		// Get organization by slug
		const organization = await getOrganizationBySlug(
			callbackData.organizationSlug,
		)
		if (!organization) {
			trackSuspiciousActivity(activityKey, 'failed_auth')
			return redirectWithToast(
				'/login',
				{
					title: 'Organization Not Found',
					description:
						'The organization you are trying to access does not exist.',
					type: 'error',
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}

		// Get SSO configuration
		const ssoConfig = await ssoConfigurationService.getConfiguration(
			organization.id,
		)
		if (!ssoConfig) {
			return redirectWithToast(
				'/login',
				{
					title: 'SSO Not Available',
					description:
						'Single Sign-On is not configured for this organization.',
					type: 'error',
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}

		if (!ssoConfig.isEnabled) {
			return redirectWithToast(
				'/login',
				{
					title: 'SSO Not Available',
					description:
						'Single Sign-On is temporarily disabled for this organization.',
					type: 'error',
				},
				{ headers: destroyRedirectToHeaders(request) },
			)
		}

		// Consume the stored nonce for validation
		const { nonce, cookieHeader: nonceCookieHeader } =
			await consumeNonce(request)

		const cleanupHeaders = nonceCookieHeader
			? combineHeaders(destroyRedirectToHeaders(request), {
					'set-cookie': nonceCookieHeader,
				})
			: destroyRedirectToHeaders(request)

		// Handle OAuth callback with nonce for ID token validation
		const authResult = await ssoAuthService
			.handleCallback(organization.id, request, nonce ?? undefined)
			.then(
				(data) =>
					({
						success: true,
						data,
					}) as const,
				(error) =>
					({
						success: false,
						error,
					}) as const,
			)

		if (!authResult.success) {
			console.error('SSO authentication failed:', authResult.error)
			trackSuspiciousActivity(activityKey, 'failed_auth')

			return redirectWithToast(
				'/login',
				{
					title: 'SSO Authentication Failed',
					description:
						'Authentication with your identity provider failed. Please try again or contact your administrator.',
					type: 'error',
				},
				{ headers: cleanupHeaders },
			)
		}

		const { data: providerUser } = authResult

		// Check if user is already logged in
		const userId = await getUserId(request)

		if (userId) {
			// User is already logged in, this might be a connection attempt
			// For SSO, we don't support connecting additional providers to existing accounts
			// since SSO users should be managed through their identity provider
			return redirectWithToast(
				'/settings/profile',
				{
					title: 'Already Authenticated',
					description: 'You are already logged in.',
				},
				{ headers: cleanupHeaders },
			)
		}

		// Handle user provisioning through SSO auth service
		// This will either find existing user or create new one based on SSO config
		let user: any
		try {
			// Prepare user info for provisioning - keep the original format for tests
			const userInfo = {
				sub: String(providerUser.id),
				email: providerUser.email,
				name: providerUser.name,
				preferred_username: providerUser.username,
			}

			// The SSO auth service handles user provisioning and organization membership
			// It will create the user if auto-provisioning is enabled, or throw an error if not
			user = await ssoAuthService.provisionUser(userInfo, ssoConfig)
		} catch (error) {
			console.error('User provisioning failed:', error)
			trackSuspiciousActivity(activityKey, 'failed_auth')

			return redirectWithToast(
				'/login',
				{
					title: 'User Provisioning Failed',
					description:
						error instanceof Error
							? error.message
							: 'Failed to provision user account',
					type: 'error',
				},
				{ headers: cleanupHeaders },
			)
		}

		// Audit log successful authentication
		await auditSSOAuthSuccess(
			organization.id,
			user.id,
			'pending-session',
			request,
		)

		// Create session for the authenticated user
		return makeSession(
			{
				request,
				user,
				organizationId: organization.id,
				redirectTo,
				providerUser,
				ssoConfig,
			},
			{ headers: cleanupHeaders },
		)
	} catch (error: unknown) {
		// Track failed authentication attempts
		const organizationSlug = params.organizationSlug || ''
		if (organizationSlug) {
			const activityKey = `${organizationSlug}:${clientIP}`
			trackSuspiciousActivity(activityKey, 'failed_auth')
		}

		// Re-throw if it's already a Response (redirect from our error handling)
		if (error instanceof Response) {
			throw error
		}

		console.error('SSO callback error:', error)
		const ssoError = createSSOError(
			SSOErrorType.UNKNOWN_ERROR,
			error instanceof Error
				? error.message
				: 'Unexpected error during SSO callback',
		)
		throw await handleSSOError(ssoError, '/login', request)
	}
}

async function makeSession(
	{
		request,
		user,
		organizationId,
		redirectTo,
		providerUser,
		ssoConfig,
	}: {
		request: Request
		user: { id: string; email: string; name: string | null }
		organizationId: string
		redirectTo?: string | null
		providerUser: any
		ssoConfig: any
	},
	responseInit?: ResponseInit,
) {
	redirectTo ??= '/'

	const { canUserLogin } = await import('@repo/auth')
	const allowed = await canUserLogin(user.id)
	if (!allowed) {
		return redirect('/login?banned=true', {
			headers: combineHeaders(
				responseInit?.headers,
				destroyRedirectToHeaders(request),
			),
		})
	}

	// Create session using the SSO login function
	const session = await loginWithSSO({
		request,
		user: user as any, // Type assertion since we know the user structure matches
		_organizationId: organizationId,
	})

	// Create SSO session to link with the regular session
	// This allows us to track SSO-specific information and handle token refresh/revocation
	try {
		const tokens = (providerUser as any).tokens
		if (tokens) {
			await ssoAuthService.createSSOSession(
				session.id,
				ssoConfig.id,
				providerUser.id,
				tokens,
			)
		}
	} catch (error) {
		console.warn('Failed to create SSO session tracking:', error)
		// Don't fail the login if SSO session creation fails
	}

	return handleNewSession(
		{ request, session, redirectTo, remember: true },
		{
			headers: combineHeaders(
				responseInit?.headers,
				destroyRedirectToHeaders(request),
				await createToastHeaders({
					title: 'Welcome!',
					description:
						user.id !== providerUser.id
							? 'Your account has been created and you are now logged in.'
							: 'You have been successfully authenticated via SSO.',
					type: 'success',
				}),
			),
		},
	)
}
