import { type LinguiConfig } from '@lingui/conf'
import { createCookie } from 'react-router'
import { ENV } from './package-env.ts'
import { RemixLingui } from './remix.server'

/**
 * Creates a locale cookie with sensible defaults
 * @param name - Cookie name (defaults to 'lng')
 * @param options - Additional cookie options
 */
export function createLocaleCookie(
	name: string = 'lng',
	options: Parameters<typeof createCookie>[1] = {},
) {
	return createCookie(name, {
		path: '/',
		sameSite: 'lax',
		secure: ENV.NODE_ENV === 'production',
		httpOnly: true,
		...options,
	})
}

/**
 * Helper to extract fallback language from Lingui config
 * @param config - Lingui configuration object
 * @returns The fallback language as a string
 */
export function getFallbackLanguage(config: LinguiConfig): string {
	// Check if fallbackLocales is configured and not false
	if (!config.fallbackLocales || typeof config.fallbackLocales === 'boolean') {
		return 'en'
	}

	const fallback = config.fallbackLocales.default
	if (!fallback) {
		return 'en'
	}

	// Handle array case - return first element
	if (Array.isArray(fallback)) {
		return fallback[0] ?? 'en'
	}

	// Return string directly
	return fallback
}

/**
 * Creates a configured RemixLingui instance
 * @param config - Lingui configuration object
 * @param localeCookie - Optional custom locale cookie (defaults to 'lng')
 */
export function createLinguiServer(
	config: LinguiConfig,
	localeCookie?: ReturnType<typeof createCookie>,
) {
	const cookie = localeCookie ?? createLocaleCookie()

	return new RemixLingui({
		detection: {
			supportedLanguages: config.locales,
			fallbackLanguage: getFallbackLanguage(config),
			cookie,
		},
	})
}
