import { getReferrerRoute } from '@repo/common'
import { getClientIp } from '@repo/common/ip-tracking'
import { getRedirectCookieHeader } from '@repo/common/redirect-cookie'
import { SSOAuthRequestSchema } from '@repo/validation'
import { redirect } from 'react-router'
import { ENV } from 'varlock/env'
import { getSSOStrategy } from '#app/utils/auth.server.ts'
import { getOrganizationBySlug } from '#app/utils/organization/organizations.server.ts'
import {
	ssoAuditLogger,
	SSOAuditEventType,
} from '#app/utils/sso/audit-logging.server.ts'
import { ssoAuthService } from '#app/utils/sso/auth.server.ts'
import {
	handleSSOError,
	createSSOError,
	SSOErrorType,
} from '#app/utils/sso/error-handling.server.ts'
import { generateNonce, storeNonce } from '#app/utils/sso/nonce.server.ts'
import { trackSuspiciousActivity } from '#app/utils/sso/rate-limit.server.ts'
import {
	sanitizeRedirectUrl,
	validateSSOOrganization,
} from '#app/utils/sso/sanitization.server.ts'
import { type Route } from './+types/auth.sso.$organizationSlug.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	// This route should handle SSO callback/redirect from the identity provider
	// If we get here via GET request, it's likely a callback from the SSO provider
	const url = new URL(request.url)

	// Check if this is a callback with auth parameters - redirect to canonical callback route
	if (
		url.searchParams.has('code') ||
		url.searchParams.has('state') ||
		url.searchParams.has('SAMLResponse')
	) {
		const organizationSlug = params.organizationSlug
		if (!organizationSlug) {
			throw new Response('Organization slug is required', { status: 400 })
		}
		return redirect(
			`/auth/sso/${encodeURIComponent(organizationSlug)}/callback?${url.searchParams.toString()}`,
		)
	}

	// If no callback parameters, redirect to login
	// This prevents direct access to the SSO route
	return redirect('/login')
}

export async function action({ request, params }: Route.ActionArgs) {
	const clientIP = getClientIp(request)

	try {
		// Validate and sanitize organization slug (includes suspicious activity check)
		const organizationSlug = await validateSSOOrganization(
			request,
			params.organizationSlug,
		)
		const activityKey = `${organizationSlug}:${clientIP}`

		// Get and validate form data
		const formData = await request.formData()
		const rawRedirectTo = formData.get('redirectTo')

		// Validate request data
		const requestData = SSOAuthRequestSchema.parse({
			organizationSlug,
			redirectTo: typeof rawRedirectTo === 'string' ? rawRedirectTo : undefined,
		})

		// Get organization by slug
		const organization = await getOrganizationBySlug(
			requestData.organizationSlug,
		)
		if (!organization) {
			trackSuspiciousActivity(activityKey, 'failed_auth')
			throw new Response('Organization not found', { status: 404 })
		}

		// Check if SSO is configured and enabled for this organization
		const strategyName = await getSSOStrategy(organization.id)
		if (!strategyName) {
			trackSuspiciousActivity(activityKey, 'failed_auth')
			throw new Response('SSO not configured for this organization', {
				status: 400,
			})
		}

		// Audit log the authentication initiation
		await ssoAuditLogger.logAuthenticationEvent(
			SSOAuditEventType.AUTH_INITIATED,
			organization.id,
			'SSO authentication initiated',
			undefined, // No user ID yet
			undefined, // No session ID yet
			{
				organizationSlug: requestData.organizationSlug,
				redirectTo: requestData.redirectTo,
				userAgent: request.headers.get('user-agent'),
			},
			request,
			'info',
		)

		// Generate and store nonce for replay attack prevention
		const nonce = generateNonce()
		const nonceCookie = await storeNonce(request, nonce)

		// Initiate SSO authentication flow with nonce
		const response = await ssoAuthService.initiateAuth(
			organization.id,
			request,
			nonce,
		)

		// Add nonce cookie to response
		response.headers.append('set-cookie', nonceCookie)

		// Handle redirect cookie for post-auth redirect
		const redirectTo = requestData.redirectTo || getReferrerRoute(request)
		const sanitizedRedirectTo = sanitizeRedirectUrl(redirectTo)

		if (sanitizedRedirectTo) {
			const redirectToCookie = getRedirectCookieHeader(sanitizedRedirectTo)
			if (redirectToCookie) {
				response.headers.append('set-cookie', redirectToCookie)
			}
		}

		return response
	} catch (error: unknown) {
		// Track failed authentication attempts
		const organizationSlug = params.organizationSlug || ''
		if (organizationSlug) {
			const activityKey = `${organizationSlug}:${clientIP}`
			trackSuspiciousActivity(activityKey, 'failed_auth')
		}

		// If it's already a Response (from our error handling), just throw it
		if (error instanceof Response) {
			throw error
		}

		// Handle unexpected errors - don't log to console in tests
		if (ENV.NODE_ENV !== 'test') {
			console.error('Unexpected SSO initiation error:', error)
		}

		// For service errors, just re-throw the original error
		if (error instanceof Error) {
			throw error
		}

		const ssoError = createSSOError(
			SSOErrorType.UNKNOWN_ERROR,
			error instanceof Error
				? error.message
				: 'Unknown error during SSO initiation',
		)
		const response = await handleSSOError(ssoError)
		throw response
	}
}
