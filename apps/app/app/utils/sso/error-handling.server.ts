import { destroyRedirectToHeaders } from '@repo/common/redirect-cookie'
import { redirectWithToast } from '@repo/common/toast'

// SSO-specific error types
export enum SSOErrorType {
	CONFIGURATION_NOT_FOUND = 'configuration_not_found',
	CONFIGURATION_DISABLED = 'configuration_disabled',
	CONFIGURATION_INVALID = 'configuration_invalid',
	IDENTITY_PROVIDER_ERROR = 'identity_provider_error',
	AUTHENTICATION_FAILED = 'authentication_failed',
	USER_NOT_AUTHORIZED = 'user_not_authorized',
	USER_PROVISIONING_FAILED = 'user_provisioning_failed',
	TOKEN_EXCHANGE_FAILED = 'token_exchange_failed',
	INVALID_CALLBACK = 'invalid_callback',
	ORGANIZATION_NOT_FOUND = 'organization_not_found',
	RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
	SUSPICIOUS_ACTIVITY = 'suspicious_activity',
	NETWORK_ERROR = 'network_error',
	UNKNOWN_ERROR = 'unknown_error',
}

export interface SSOError {
	type: SSOErrorType
	message: string
	details?: string
	userMessage: string
	userDescription: string
	shouldFallback: boolean
	shouldNotifyAdmin: boolean
	statusCode: number
}

// Error definitions with user-friendly messages
const SSO_ERROR_DEFINITIONS: Record<
	SSOErrorType,
	Omit<SSOError, 'message' | 'details'>
> = {
	[SSOErrorType.CONFIGURATION_NOT_FOUND]: {
		type: SSOErrorType.CONFIGURATION_NOT_FOUND,
		userMessage: 'SSO Not Available',
		userDescription:
			'Single Sign-On is not configured for this organization. Please contact your administrator or use traditional login.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 404,
	},
	[SSOErrorType.CONFIGURATION_DISABLED]: {
		type: SSOErrorType.CONFIGURATION_DISABLED,
		userMessage: 'SSO Temporarily Unavailable',
		userDescription:
			'Single Sign-On is temporarily disabled for this organization. Please try again later or use traditional login.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 503,
	},
	[SSOErrorType.CONFIGURATION_INVALID]: {
		type: SSOErrorType.CONFIGURATION_INVALID,
		userMessage: 'SSO Configuration Error',
		userDescription:
			'There is an issue with the SSO configuration. Please contact your administrator or use traditional login.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 500,
	},
	[SSOErrorType.IDENTITY_PROVIDER_ERROR]: {
		type: SSOErrorType.IDENTITY_PROVIDER_ERROR,
		userMessage: 'Identity Provider Error',
		userDescription:
			'There was an issue connecting to your identity provider. Please try again or contact your administrator.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 502,
	},
	[SSOErrorType.AUTHENTICATION_FAILED]: {
		type: SSOErrorType.AUTHENTICATION_FAILED,
		userMessage: 'Authentication Failed',
		userDescription:
			'Authentication with your identity provider failed. Please try again or contact your administrator.',
		shouldFallback: true,
		shouldNotifyAdmin: false,
		statusCode: 401,
	},
	[SSOErrorType.USER_NOT_AUTHORIZED]: {
		type: SSOErrorType.USER_NOT_AUTHORIZED,
		userMessage: 'Access Not Authorized',
		userDescription:
			'You are not authorized to access this organization. Please contact your administrator.',
		shouldFallback: false,
		shouldNotifyAdmin: false,
		statusCode: 403,
	},
	[SSOErrorType.USER_PROVISIONING_FAILED]: {
		type: SSOErrorType.USER_PROVISIONING_FAILED,
		userMessage: 'Account Setup Failed',
		userDescription:
			'There was an issue setting up your account. Please contact your administrator.',
		shouldFallback: false,
		shouldNotifyAdmin: true,
		statusCode: 500,
	},
	[SSOErrorType.TOKEN_EXCHANGE_FAILED]: {
		type: SSOErrorType.TOKEN_EXCHANGE_FAILED,
		userMessage: 'Authentication Token Error',
		userDescription:
			'There was an issue processing your authentication. Please try again.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 500,
	},
	[SSOErrorType.INVALID_CALLBACK]: {
		type: SSOErrorType.INVALID_CALLBACK,
		userMessage: 'Invalid Authentication Response',
		userDescription:
			'The authentication response from your identity provider was invalid. Please try again.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 400,
	},
	[SSOErrorType.ORGANIZATION_NOT_FOUND]: {
		type: SSOErrorType.ORGANIZATION_NOT_FOUND,
		userMessage: 'Organization Not Found',
		userDescription:
			'The organization you are trying to access does not exist.',
		shouldFallback: false,
		shouldNotifyAdmin: false,
		statusCode: 404,
	},
	[SSOErrorType.RATE_LIMIT_EXCEEDED]: {
		type: SSOErrorType.RATE_LIMIT_EXCEEDED,
		userMessage: 'Too Many Attempts',
		userDescription:
			'Too many authentication attempts. Please wait a few minutes before trying again.',
		shouldFallback: false,
		shouldNotifyAdmin: false,
		statusCode: 429,
	},
	[SSOErrorType.SUSPICIOUS_ACTIVITY]: {
		type: SSOErrorType.SUSPICIOUS_ACTIVITY,
		userMessage: 'Suspicious Activity Detected',
		userDescription:
			'Your request has been blocked due to suspicious activity. Please try again later.',
		shouldFallback: false,
		shouldNotifyAdmin: true,
		statusCode: 429,
	},
	[SSOErrorType.NETWORK_ERROR]: {
		type: SSOErrorType.NETWORK_ERROR,
		userMessage: 'Network Connection Error',
		userDescription:
			'There was a network issue connecting to your identity provider. Please try again.',
		shouldFallback: true,
		shouldNotifyAdmin: false,
		statusCode: 502,
	},
	[SSOErrorType.UNKNOWN_ERROR]: {
		type: SSOErrorType.UNKNOWN_ERROR,
		userMessage: 'Unexpected Error',
		userDescription:
			'An unexpected error occurred. Please try again or contact support.',
		shouldFallback: true,
		shouldNotifyAdmin: true,
		statusCode: 500,
	},
}

/**
 * Sanitize sensitive data from error messages
 */
function sanitizeSensitiveData(text: string): string {
	if (!text) return text

	// Remove common sensitive patterns
	return text
		.replace(/client_secret[=:]\s*[^\s&]+/gi, 'client_secret=[REDACTED]')
		.replace(/password[=:]\s*[^\s&]+/gi, 'password=[REDACTED]')
		.replace(/token[=:]\s*[^\s&]+/gi, 'token=[REDACTED]')
		.replace(/key[=:]\s*[^\s&]+/gi, 'key=[REDACTED]')
		.replace(/secret[=:]\s*[^\s&]+/gi, 'secret=[REDACTED]')
		.replace(/eyJ[A-Za-z0-9+/=]+/g, '[JWT_TOKEN_REDACTED]') // JWT tokens
		.replace(/postgres:\/\/[^@]+@/g, 'postgres://[REDACTED]@')
		.replace(/redis:\/\/[^@]+@/g, 'redis://[REDACTED]@')
		.replace(/\/etc\/[^\s]+/g, '[SYSTEM_PATH_REDACTED]')
}

/**
 * Create an SSO error with consistent structure
 */
export function createSSOError(
	type: SSOErrorType,
	message: string,
	details?: string,
): SSOError {
	const definition = SSO_ERROR_DEFINITIONS[type]

	// Sanitize the message for admin logs but keep original for internal processing
	const sanitizedMessage = sanitizeSensitiveData(message)

	// Handle details safely in case of circular references or other issues
	let sanitizedDetails: string | undefined
	try {
		sanitizedDetails = details ? sanitizeSensitiveData(details) : undefined
	} catch {
		sanitizedDetails =
			'[Error processing details: circular reference or invalid data]'
	}

	return {
		...definition,
		message: sanitizedMessage,
		details: sanitizedDetails,
	}
}

/**
 * Handle SSO errors and redirect with appropriate user feedback
 */
export async function handleSSOError(
	error: SSOError | Error | unknown,
	fallbackUrl: string = '/login',
	request?: Request,
): Promise<Response> {
	let ssoError: SSOError

	if (error instanceof Error) {
		// Try to categorize the error based on message
		ssoError = categorizeSSOError(error)
	} else if (typeof error === 'object' && error !== null && 'type' in error) {
		ssoError = error as SSOError
	} else {
		ssoError = createSSOError(
			SSOErrorType.UNKNOWN_ERROR,
			'Unknown error occurred',
			String(error),
		)
	}

	// Log error for debugging
	console.error('SSO Error:', {
		type: ssoError.type,
		message: ssoError.message,
		details: ssoError.details,
		shouldNotifyAdmin: ssoError.shouldNotifyAdmin,
	})

	// Notify admin if required
	if (ssoError.shouldNotifyAdmin) {
		await notifyAdminOfSSOError(ssoError)
	}

	// Determine redirect URL - validate fallback URL for security
	let redirectUrl = '/login' // Safe default
	if (ssoError.shouldFallback && fallbackUrl) {
		// Only allow safe relative URLs
		if (fallbackUrl.startsWith('/') && !fallbackUrl.startsWith('//')) {
			// Block internal/admin paths for security
			const blockedPaths = [
				'/internal/',
				'/admin/',
				'/api/internal/',
				'/.env',
				'/config/',
			]
			const isBlockedPath = blockedPaths.some((blocked) =>
				fallbackUrl.toLowerCase().includes(blocked),
			)

			if (!isBlockedPath) {
				// Relative URL is safe
				redirectUrl = fallbackUrl
			}
			// If blocked, use safe default (/login)
		}
		// If external or potentially malicious URL, use safe default (/login)
	}

	// Create toast message
	return redirectWithToast(
		redirectUrl,
		{
			title: ssoError.userMessage,
			description: ssoError.userDescription,
			type: 'error',
		},
		{
			headers: new Headers(destroyRedirectToHeaders(request)),
			status: ssoError.statusCode >= 400 ? undefined : ssoError.statusCode,
		},
	)
}

/**
 * Categorize generic errors into SSO error types
 */
function categorizeSSOError(error: Error): SSOError {
	const message = error.message.toLowerCase()

	// Network and connectivity errors
	if (
		message.includes('network') ||
		message.includes('timeout') ||
		message.includes('connection')
	) {
		return createSSOError(SSOErrorType.NETWORK_ERROR, error.message)
	}

	// Identity provider errors
	if (
		message.includes('identity provider') ||
		message.includes('idp') ||
		message.includes('oidc discovery')
	) {
		return createSSOError(SSOErrorType.IDENTITY_PROVIDER_ERROR, error.message)
	}

	// Configuration errors
	if (
		message.includes('configuration') ||
		message.includes('client secret') ||
		message.includes('client id')
	) {
		return createSSOError(SSOErrorType.CONFIGURATION_INVALID, error.message)
	}

	// Authentication errors
	if (
		message.includes('authentication') ||
		message.includes('unauthorized') ||
		message.includes('invalid_grant')
	) {
		return createSSOError(SSOErrorType.AUTHENTICATION_FAILED, error.message)
	}

	// Token errors
	if (message.includes('token') || message.includes('access_denied')) {
		return createSSOError(SSOErrorType.TOKEN_EXCHANGE_FAILED, error.message)
	}

	// User provisioning errors
	if (
		message.includes('provisioning') ||
		message.includes('user creation') ||
		message.includes('user not found')
	) {
		return createSSOError(SSOErrorType.USER_PROVISIONING_FAILED, error.message)
	}

	// Rate limiting
	if (message.includes('rate limit') || message.includes('too many')) {
		return createSSOError(SSOErrorType.RATE_LIMIT_EXCEEDED, error.message)
	}

	// Default to unknown error
	return createSSOError(SSOErrorType.UNKNOWN_ERROR, error.message)
}

/**
 * Notify administrators of SSO errors that require attention
 */
async function notifyAdminOfSSOError(error: SSOError): Promise<void> {
	try {
		// In a real implementation, this would send notifications via:
		// - Email to administrators
		// - Slack/Teams webhook
		// - Error tracking service
		// - Admin dashboard alerts

		console.warn('Admin notification required for SSO error:', {
			type: error.type,
			message: error.message,
			details: error.details,
			timestamp: new Date().toISOString(),
		})

		// TODO: Implement actual notification system
		// Example implementations:

		// Email notification
		// await sendAdminEmail({
		//   subject: `SSO Error: ${error.userMessage}`,
		//   body: `Error Type: ${error.type}\nMessage: ${error.message}\nDetails: ${error.details}`,
		// })

		// Slack notification
		// await sendSlackNotification({
		//   channel: '#admin-alerts',
		//   message: `🚨 SSO Error: ${error.userMessage}\n\`\`\`${error.message}\`\`\``,
		// })

		// Error tracking
		// captureException(new Error(error.message), {
		//   tags: { sso_error_type: error.type },
		//   extra: { details: error.details },
		// })
	} catch (notificationError) {
		console.error('Failed to notify admin of SSO error:', notificationError)
	}
}

/**
 * Create a fallback authentication response when SSO fails
 */
export async function createSSOFallbackResponse(
	organizationSlug: string,
	originalError: SSOError,
	redirectTo?: string,
	request?: Request,
): Promise<Response> {
	const fallbackUrl = `/login?org=${encodeURIComponent(organizationSlug)}${
		redirectTo ? `&redirectTo=${encodeURIComponent(redirectTo)}` : ''
	}`

	return redirectWithToast(
		fallbackUrl,
		{
			title: 'SSO Unavailable',
			description: `${originalError.userDescription} You can still log in using your username and password.`,
			type: 'message',
		},
		{ headers: destroyRedirectToHeaders(request) },
	)
}

/**
 * Validate and handle OAuth error responses from identity providers
 */
export function handleOAuthError(
	error: string,
	errorDescription?: string,
	errorUri?: string,
): SSOError {
	const commonOAuthErrors: Record<string, SSOErrorType> = {
		access_denied: SSOErrorType.USER_NOT_AUTHORIZED,
		unauthorized_client: SSOErrorType.CONFIGURATION_INVALID,
		invalid_request: SSOErrorType.INVALID_CALLBACK,
		invalid_scope: SSOErrorType.CONFIGURATION_INVALID,
		server_error: SSOErrorType.IDENTITY_PROVIDER_ERROR,
		temporarily_unavailable: SSOErrorType.IDENTITY_PROVIDER_ERROR,
		invalid_grant: SSOErrorType.AUTHENTICATION_FAILED,
		invalid_client: SSOErrorType.CONFIGURATION_INVALID,
	}

	const errorType =
		commonOAuthErrors[error] || SSOErrorType.AUTHENTICATION_FAILED
	const message = errorDescription || `OAuth error: ${error}`
	const details = errorUri ? `Error URI: ${errorUri}` : undefined

	return createSSOError(errorType, message, details)
}

/**
 * Check if an error should trigger fallback to traditional authentication
 */
export function shouldFallbackToTraditionalAuth(error: SSOError): boolean {
	return error.shouldFallback && error.type !== SSOErrorType.USER_NOT_AUTHORIZED
}

/**
 * Get retry delay for rate-limited requests
 */
export function getSSORetryDelay(error: SSOError): number {
	if (error.type === SSOErrorType.RATE_LIMIT_EXCEEDED) {
		return 5 * 60 * 1000 // 5 minutes
	}
	if (error.type === SSOErrorType.SUSPICIOUS_ACTIVITY) {
		return 60 * 60 * 1000 // 1 hour
	}
	if (error.type === SSOErrorType.NETWORK_ERROR) {
		return 30 * 1000 // 30 seconds
	}
	return 60 * 1000 // 1 minute default
}
