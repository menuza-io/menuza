import * as Linking from 'expo-linking'
import { router, type Href } from 'expo-router'

/**
 * Navigation utilities for handling authentication flows and deep linking
 */

export interface NavigationParams {
	redirectTo?: string
	[key: string]: string | undefined
}

/**
 * Navigate to sign-in screen with optional redirect parameter
 */
export function navigateToSignIn(params?: NavigationParams) {
	router.replace({
		pathname: '/(auth)/sign-in',
		params,
	})
}

/**
 * Navigate to sign-up screen with optional redirect parameter
 */
export function navigateToSignUp(params?: NavigationParams) {
	router.replace({
		pathname: '/(auth)/sign-up',
		params,
	})
}

/**
 * Navigate to forgot password screen with optional redirect parameter
 */
export function navigateToForgotPassword(params?: NavigationParams) {
	router.push({
		pathname: '/(auth)/forgot-password',
		params,
	})
}

/**
 * Navigate to email verification screen with optional parameters
 */
export function navigateToVerifyEmail(
	params?: NavigationParams & {
		token?: string
		email?: string
	},
) {
	router.push({
		pathname: '/(auth)/verify-email',
		params,
	})
}

/**
 * Navigate to dashboard or specified redirect location
 */
export function navigateAfterAuth(redirectTo?: string) {
	if (redirectTo && redirectTo.startsWith('/')) {
		// Validate that the redirect path is safe
		if (isValidRedirectPath(redirectTo)) {
			router.replace(redirectTo as Href)
		} else {
			// Fallback to dashboard if redirect path is invalid
			router.replace('/(dashboard)')
		}
	} else {
		router.replace('/(dashboard)')
	}
}

/**
 * Navigate to OAuth callback screen
 */
export function navigateToOAuthCallback(params: {
	code?: string
	state?: string
	error?: string
	provider?: string
}) {
	router.replace({
		pathname: '/auth/callback',
		params,
	})
}

/**
 * Check if a redirect path is valid and safe
 */
export function isValidRedirectPath(path: string): boolean {
	// Only allow paths that start with / and are within our app
	if (!path.startsWith('/')) return false

	// `//host` is protocol-relative: expo-router would open it as https://host
	// in the system browser. A backslash is read as a slash by URL parsers, and
	// control characters can hide the second slash.
	if (path.startsWith('//') || path.includes('\\')) return false
	if (/[\u0000-\u001f\u007f]/.test(path)) return false

	// Allow dashboard routes
	if (path.startsWith('/(dashboard)')) return true

	// Disallow auth routes (would cause redirect loops)
	if (path.startsWith('/(auth)')) return false

	// Disallow callback routes
	if (path.startsWith('/auth/callback')) return false

	// Allow other valid routes
	return true
}

/**
 * Parse deep link URL and extract navigation parameters
 */
export function parseDeepLink(url: string): {
	pathname?: string
	params?: Record<string, string>
} {
	try {
		const parsed = Linking.parse(url)
		return {
			pathname: parsed.path || undefined,
			params: (parsed.queryParams as Record<string, string>) || undefined,
		}
	} catch (error) {
		console.error('Failed to parse deep link:', error)
		return {}
	}
}

/**
 * Create a deep link URL for the app
 */
export function createDeepLink(
	pathname: string,
	params?: Record<string, string>,
): string {
	const scheme = 'epicnotes://'
	const cleanPathname = pathname.startsWith('/') ? pathname.slice(1) : pathname

	let url = scheme + cleanPathname

	if (params) {
		const searchParams = new URLSearchParams()
		Object.entries(params).forEach(([key, value]) => {
			if (value) {
				searchParams.set(key, value)
			}
		})

		const queryString = searchParams.toString()
		if (queryString) {
			url += '?' + queryString
		}
	}

	return url
}

/**
 * Handle incoming deep link and navigate appropriately
 */
export function handleDeepLink(url: string): boolean {
	const { pathname, params } = parseDeepLink(url)

	if (!pathname) return false

	try {
		// Handle OAuth callback
		if (pathname === 'auth/callback') {
			navigateToOAuthCallback(params || {})
			return true
		}

		// Handle sign-in
		if (pathname === 'sign-in') {
			navigateToSignIn(params)
			return true
		}

		// Handle sign-up
		if (pathname === 'sign-up') {
			navigateToSignUp(params)
			return true
		}

		// Handle forgot password
		if (pathname === 'forgot-password') {
			navigateToForgotPassword(params)
			return true
		}

		// Handle email verification
		if (pathname === 'verify-email') {
			navigateToVerifyEmail(params)
			return true
		}

		// Handle dashboard
		if (pathname === 'dashboard') {
			router.replace('/(dashboard)')
			return true
		}

		// Handle other valid paths
		if (isValidRedirectPath(`/${pathname}`)) {
			router.replace(`/${pathname}` as Href)
			return true
		}

		return false
	} catch (error) {
		console.error('Failed to handle deep link:', error)
		return false
	}
}
