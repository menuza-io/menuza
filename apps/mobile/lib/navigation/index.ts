import { router, type Href } from 'expo-router'
import { isValidRedirectPath } from './utils'

/**
 * Handle deep link URLs for authentication flows
 */
export const handleDeepLink = (url: string): void => {
	try {
		// Handle different URL formats (custom scheme vs http)
		let pathname: string
		let searchParams: URLSearchParams

		if (url.startsWith('http')) {
			// HTTP URL format
			const parsedUrl = new URL(url)
			pathname = parsedUrl.pathname
			searchParams = parsedUrl.searchParams
		} else {
			// Custom scheme format (myapp://path?params)
			const [, rest] = url.split('://')
			if (!rest) {
				console.warn('Invalid deep link format:', url)
				return
			}

			const [pathPart, queryPart] = rest.split('?')
			pathname = pathPart ? `/${pathPart}` : ''
			searchParams = new URLSearchParams(queryPart || '')
		}

		// Handle verification links
		if (pathname.includes('verify') || searchParams.has('type')) {
			const type = searchParams.get('type')
			const target = searchParams.get('target')
			const code = searchParams.get('code')
			// A link can come from any app or page, so only an in-app path may
			// ride along to sign-in. Anything else is dropped, not forwarded.
			const requestedRedirect = searchParams.get('redirectTo')
			const redirectTo =
				requestedRedirect && isValidRedirectPath(requestedRedirect)
					? requestedRedirect
					: null

			if (type && target && code) {
				// Navigate to verification screen with pre-filled data
				const params = new URLSearchParams({
					type,
					target,
					code,
					...(redirectTo && { redirectTo }),
				}).toString()

				router.replace(`/(auth)/verify-code?${params}` as Href)
				return
			}
		}

		// Handle OAuth callback
		if (pathname.includes('callback')) {
			router.replace('/auth/callback' as Href)
			return
		}

		// Handle other auth-related deep links
		if (
			pathname.includes('auth') ||
			pathname.includes('sign-in') ||
			pathname.includes('sign-up')
		) {
			let authPath = pathname.replace('/auth/', '').replace('/', '')

			// Map common paths
			if (authPath === 'sign-in' || pathname.includes('sign-in')) {
				authPath = 'sign-in'
			} else if (authPath === 'sign-up' || pathname.includes('sign-up')) {
				authPath = 'sign-up'
			}

			if (authPath) {
				router.replace(`/(auth)/${authPath}` as Href)
				return
			}
		}

		// Default fallback - let AuthGuard handle it
	} catch {
		// Fallback to sign in on invalid URLs
		navigateToSignIn()
	}
}

export { navigateAfterAuth } from './utils'

/**
 * Navigate to sign in screen
 */
export const navigateToSignIn = (redirectTo?: string): void => {
	const params = redirectTo
		? `?redirectTo=${encodeURIComponent(redirectTo)}`
		: ''
	router.replace(`/(auth)/sign-in${params}` as Href)
}

/**
 * Navigate to sign up screen
 */
export const navigateToSignUp = (redirectTo?: string): void => {
	const params = redirectTo
		? `?redirectTo=${encodeURIComponent(redirectTo)}`
		: ''
	router.replace(`/(auth)/sign-up${params}` as Href)
}

/**
 * Navigate back in the navigation stack
 */
export const navigateBack = (): void => {
	if (router.canGoBack()) {
		router.back()
	} else {
		// Fallback to sign in if can't go back
		navigateToSignIn()
	}
}
