import { getClientIp } from '@repo/common/ip-tracking'
import sanitizeHtmlLibrary from 'sanitize-html'
import {
	createSSOError,
	SSOErrorType,
	handleSSOError,
} from './error-handling.server.ts'
import { isSuspiciousActivityBlocked } from './rate-limit.server.ts'

/**
 * Sanitize HTML content to prevent XSS attacks
 */
export function sanitizeHtml(input: string): string {
	if (!input || typeof input !== 'string') return ''

	return sanitizeHtmlLibrary(input, {
		allowedTags: [], // No HTML tags allowed
		allowedAttributes: {},
	})
}

/**
 * Sanitize and validate URL inputs
 */
export function sanitizeUrl(input: string): string {
	if (!input || typeof input !== 'string') return ''

	try {
		// Remove any HTML encoding
		const decoded = decodeURIComponent(input.trim())

		// Parse URL to validate structure
		const url = new URL(decoded)

		// Only allow HTTPS in production
		if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
			throw new Error('Only HTTPS URLs are allowed')
		}

		// Block dangerous protocols
		const allowedProtocols = ['https:', 'http:']
		if (!allowedProtocols.includes(url.protocol)) {
			throw new Error('Invalid URL protocol')
		}

		// Return normalized URL
		return url.toString()
	} catch (error) {
		throw new Error(
			`Invalid URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
		)
	}
}

/**
 * Sanitize provider name input
 */
export function sanitizeProviderName(input: string): string {
	if (!input || typeof input !== 'string') return ''

	return input
		.trim()
		.replace(/[<>"'&]/g, '') // Remove potentially dangerous characters
		.replace(/\s+/g, ' ') // Normalize whitespace
		.substring(0, 50) // Limit length
}

/**
 * Sanitize client ID input
 */
export function sanitizeClientId(input: string): string {
	if (!input || typeof input !== 'string') return ''

	return input
		.trim()
		.replace(/[^a-zA-Z0-9\-_.~]/g, '') // Only allow safe characters
		.substring(0, 255) // Limit length
}

/**
 * Sanitize OAuth scopes
 */
export function sanitizeScopes(input: string): string {
	if (!input || typeof input !== 'string') return 'openid email profile'

	const scopes = input
		.trim()
		.split(/\s+/)
		.filter((scope) => /^[a-zA-Z0-9_\-:.]+$/.test(scope)) // Only allow valid scope characters
		.filter((scope) => scope.length <= 50) // Limit individual scope length

	// Ensure openid is always included
	if (!scopes.includes('openid')) {
		scopes.unshift('openid')
	}

	// Remove duplicates and limit total scopes
	return [...new Set(scopes)].slice(0, 10).join(' ')
}

/**
 * Sanitize JSON input (for attribute mapping)
 */
export function sanitizeJsonInput(input: string): string | null {
	if (!input || typeof input !== 'string') return null

	try {
		// Parse to validate JSON structure
		const parsed = JSON.parse(input.trim())

		// Must be an object
		if (
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed === null
		) {
			throw new Error('Must be a JSON object')
		}

		// Sanitize keys and values
		const sanitized: Record<string, string> = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof key === 'string' && typeof value === 'string') {
				// Sanitize key (user attribute name)
				const cleanKey = key
					.trim()
					.replace(/[^a-zA-Z0-9_]/g, '')
					.substring(0, 50)
				// Sanitize value (OIDC claim name)
				const cleanValue = value
					.trim()
					.replace(/[^a-zA-Z0-9_.:/-]/g, '')
					.substring(0, 100)

				if (cleanKey && cleanValue) {
					sanitized[cleanKey] = cleanValue
				}
			}
		}

		// Limit number of mappings
		const limitedMappings = Object.fromEntries(
			Object.entries(sanitized).slice(0, 20),
		)

		return Object.keys(limitedMappings).length > 0
			? JSON.stringify(limitedMappings)
			: null
	} catch (error) {
		throw new Error(
			`Invalid JSON: ${error instanceof Error ? error.message : 'Parse error'}`,
		)
	}
}

/**
 * Sanitize organization slug
 */
export function sanitizeOrganizationSlug(input: string): string {
	if (!input || typeof input !== 'string') return ''

	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]/g, '') // Only allow lowercase letters, numbers, and hyphens
		.replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
		.replace(/-+/g, '-') // Collapse multiple hyphens
		.substring(0, 50) // Limit length
}

/**
 * Sanitize redirect URL to prevent open redirects
 */
export function sanitizeRedirectUrl(input: string): string | null {
	if (!input || typeof input !== 'string') return null

	const trimmed = input.trim()

	// Only allow relative URLs that start with /
	if (!trimmed.startsWith('/')) {
		return null
	}

	// Prevent protocol-relative URLs
	if (trimmed.startsWith('//')) {
		return null
	}

	// Remove any HTML encoding
	try {
		const decoded = decodeURIComponent(trimmed)

		// Basic path validation
		if (!/^\/[a-zA-Z0-9\-_./]*(\?[a-zA-Z0-9\-_=&]*)?$/.test(decoded)) {
			return null
		}

		return decoded.substring(0, 200) // Limit length
	} catch {
		return null
	}
}

/**
 * Sanitize user role input
 */
export function sanitizeUserRole(input: string): string {
	if (!input || typeof input !== 'string') return 'member'

	const role = input.toLowerCase().trim()
	const validRoles = ['admin', 'member', 'viewer', 'owner']

	return validRoles.includes(role) ? role : 'member'
}

/**
 * Comprehensive sanitization for SSO configuration input
 */
export function sanitizeSSOConfigInput(input: any): any {
	if (!input || typeof input !== 'object') {
		throw new Error('Invalid input: must be an object')
	}

	const sanitized: any = {}

	// Sanitize each field
	if (input.providerName) {
		sanitized.providerName = sanitizeProviderName(input.providerName)
	}

	if (input.issuerUrl) {
		sanitized.issuerUrl = sanitizeUrl(input.issuerUrl)
	}

	if (input.clientId) {
		sanitized.clientId = sanitizeClientId(input.clientId)
	}

	if (input.clientSecret) {
		// Don't sanitize client secret as it might contain special characters
		// Just ensure it's a string and limit length
		if (typeof input.clientSecret === 'string') {
			sanitized.clientSecret = input.clientSecret.substring(0, 512)
		}
	}

	if (input.scopes) {
		sanitized.scopes = sanitizeScopes(input.scopes)
	}

	// Boolean fields
	if (typeof input.autoDiscovery === 'boolean') {
		sanitized.autoDiscovery = input.autoDiscovery
	}

	if (typeof input.pkceEnabled === 'boolean') {
		sanitized.pkceEnabled = input.pkceEnabled
	}

	if (typeof input.autoProvision === 'boolean') {
		sanitized.autoProvision = input.autoProvision
	}

	if (input.defaultRole) {
		sanitized.defaultRole = sanitizeUserRole(input.defaultRole)
	}

	if (input.attributeMapping) {
		sanitized.attributeMapping = sanitizeJsonInput(input.attributeMapping)
	}

	// Manual endpoint URLs
	if (input.authorizationUrl) {
		sanitized.authorizationUrl = sanitizeUrl(input.authorizationUrl)
	}

	if (input.tokenUrl) {
		sanitized.tokenUrl = sanitizeUrl(input.tokenUrl)
	}

	if (input.userinfoUrl) {
		sanitized.userinfoUrl = sanitizeUrl(input.userinfoUrl)
	}

	if (input.revocationUrl) {
		sanitized.revocationUrl = sanitizeUrl(input.revocationUrl)
	}

	return sanitized
}

/**
 * Sanitize OIDC user info from identity provider
 */
export function sanitizeOIDCUserInfo(userInfo: any): any {
	if (!userInfo || typeof userInfo !== 'object') {
		throw new Error('Invalid user info: must be an object')
	}

	const sanitized: any = {}

	// Required fields
	if (userInfo.sub) {
		sanitized.sub = String(userInfo.sub).trim().substring(0, 255)
	}

	if (userInfo.email) {
		const email = String(userInfo.email).toLowerCase().trim()
		// Basic email validation
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			sanitized.email = email.substring(0, 100)
		}
	}

	// Optional fields
	if (userInfo.name) {
		sanitized.name = sanitizeHtml(String(userInfo.name)).substring(0, 100)
	}

	if (userInfo.given_name) {
		sanitized.given_name = sanitizeHtml(String(userInfo.given_name)).substring(
			0,
			50,
		)
	}

	if (userInfo.family_name) {
		sanitized.family_name = sanitizeHtml(
			String(userInfo.family_name),
		).substring(0, 50)
	}

	if (userInfo.preferred_username) {
		sanitized.preferred_username = String(userInfo.preferred_username)
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9_.-]/g, '')
			.substring(0, 50)
	}

	if (userInfo.picture) {
		try {
			sanitized.picture = sanitizeUrl(String(userInfo.picture))
		} catch {
			// Ignore invalid picture URLs
		}
	}

	// Handle additional claims safely
	for (const [key, value] of Object.entries(userInfo)) {
		if (!sanitized.hasOwnProperty(key) && typeof key === 'string') {
			const cleanKey = key.replace(/[^a-zA-Z0-9_]/g, '').substring(0, 50)
			if (cleanKey && typeof value === 'string') {
				sanitized[cleanKey] = sanitizeHtml(String(value)).substring(0, 200)
			}
		}
	}

	return sanitized
}

/**
 * Validates and sanitizes organization slug for SSO authentication requests.
 * Checks for suspicious activity and throws appropriate errors.
 * Reduces duplication between SSO callback and login routes.
 *
 * @param request - The incoming request
 * @param rawOrganizationSlug - The raw organization slug from params
 * @returns The sanitized organization slug
 * @throws Response with appropriate error status and message
 */
export async function validateSSOOrganization(
	request: Request,
	rawOrganizationSlug: string | undefined,
): Promise<string> {
	const clientIP = getClientIp(request)

	// Sanitize and validate organization slug
	if (!rawOrganizationSlug) {
		throw new Response('Organization slug is required', { status: 400 })
	}

	const organizationSlug = sanitizeOrganizationSlug(rawOrganizationSlug)
	if (!organizationSlug) {
		throw new Response('Invalid organization slug format', { status: 400 })
	}

	// Check for suspicious activity
	const activityKey = `${organizationSlug}:${clientIP}`
	if (isSuspiciousActivityBlocked(activityKey, 'failed_auth')) {
		const error = createSSOError(
			SSOErrorType.SUSPICIOUS_ACTIVITY,
			'Too many failed authentication attempts',
			`Activity key: ${activityKey}`,
		)
		throw await handleSSOError(error, '/login', request)
	}

	return organizationSlug
}
