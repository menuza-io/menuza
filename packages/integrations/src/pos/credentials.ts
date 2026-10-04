/**
 * Resolves POS platform credentials.
 *
 * - **Sandbox** (default): in-process MSW mock; no Menuza env vars required.
 * - **Live merchants**: Clover, Square, Toast, and Uber Eats use merchant OAuth
 *   (`*_CLIENT_ID` / `*_SECRET` or Clover `*_APP_ID`). DoorDash uses JWT access
 *   keys (`DOORDASH_DEVELOPER_ID`, `DOORDASH_KEY_ID`, `DOORDASH_SIGNING_SECRET`).
 *   Per-merchant OAuth tokens live on the Integration row when applicable.
 *
 * Static platform-wide access tokens are intentionally not supported for live
 * multi-tenant use.
 *
 * App id/secret values prefixed with `MOCK_` or `demo-` keep the MSW sandbox on
 * (offline dev) even when set in `.env`.
 */

import { readEnv } from '../env-reader.ts'
import { merchantIds, sandboxUrls, type PosProvider } from './types.ts'

/** Token the sandbox accepts. */
export const POS_SANDBOX_TOKEN = 'pos-msw-sandbox'

type AppCredentialEnv = {
	clientId: string
	clientSecret: string
	authorizeUrl?: string
	apiBaseUrl?: string
}

const APP_CREDENTIAL_ENV: Record<
	Exclude<PosProvider, 'doordash'>,
	AppCredentialEnv
> = {
	clover: {
		clientId: 'CLOVER_APP_ID',
		clientSecret: 'CLOVER_APP_SECRET',
		authorizeUrl: 'CLOVER_AUTHORIZE_URL',
		apiBaseUrl: 'CLOVER_BASE_URL',
	},
	square: {
		clientId: 'SQUARE_APP_ID',
		clientSecret: 'SQUARE_APP_SECRET',
		authorizeUrl: 'SQUARE_AUTHORIZE_URL',
		apiBaseUrl: 'SQUARE_BASE_URL',
	},
	toast: {
		clientId: 'TOAST_CLIENT_ID',
		clientSecret: 'TOAST_CLIENT_SECRET',
		authorizeUrl: 'TOAST_AUTHORIZE_URL',
		apiBaseUrl: 'TOAST_BASE_URL',
	},
	ubereats: {
		clientId: 'UBER_EATS_CLIENT_ID',
		clientSecret: 'UBER_EATS_CLIENT_SECRET',
		authorizeUrl: 'UBER_EATS_AUTHORIZE_URL',
		apiBaseUrl: 'UBER_EATS_BASE_URL',
	},
}

const MERCHANT_OAUTH_PROVIDERS = new Set<PosProvider>([
	'clover',
	'square',
	'toast',
	'ubereats',
])

export type DoorDashJwtCredentials = {
	developerId: string
	keyId: string
	signingSecret: string
	apiBaseUrl: string
}

export function providerUsesMerchantOAuth(provider: PosProvider): boolean {
	return MERCHANT_OAUTH_PROVIDERS.has(provider)
}

export function resolveDoorDashJwtCredentials(): DoorDashJwtCredentials | null {
	const developerId = readEnv('DOORDASH_DEVELOPER_ID')
	const keyId = readEnv('DOORDASH_KEY_ID')
	const signingSecret = readEnv('DOORDASH_SIGNING_SECRET')
	if (
		isPlaceholder(developerId) ||
		isPlaceholder(keyId) ||
		isPlaceholder(signingSecret)
	) {
		return null
	}
	const configuredApi = readEnv('DOORDASH_BASE_URL')
	return {
		developerId: developerId!,
		keyId: keyId!,
		signingSecret: signingSecret!,
		apiBaseUrl: normalizePosApiBaseUrl(
			'doordash',
			configuredApi ?? DEFAULT_API.doordash,
		),
	}
}

const DEFAULT_AUTHORIZE: Record<PosProvider, string> = {
	clover: 'https://sandbox.dev.clover.com',
	square: 'https://connect.squareupsandbox.com',
	toast: 'https://ws-sandbox-api.toasttab.com',
	ubereats: 'https://sandbox-login.uber.com',
	doordash: 'https://openapi.doordash.com',
}

const DEFAULT_API: Record<PosProvider, string> = {
	clover: 'https://apisandbox.dev.clover.com',
	square: 'https://connect.squareupsandbox.com',
	toast: 'https://ws-sandbox-api.toasttab.com',
	ubereats: 'https://test-api.uber.com',
	doordash: 'https://openapi.doordash.com',
}

function isPlaceholder(value: string | undefined): boolean {
	return !value || value.startsWith('MOCK_') || value.startsWith('demo-')
}

const SQUARE_SANDBOX_CONNECT = 'https://connect.squareupsandbox.com'
const SQUARE_PRODUCTION_CONNECT = 'https://connect.squareup.com'

/** Square OAuth authorize + Connect API host (never `squareupsandbox.com`). */
export const UBER_EATS_OAUTH_TESTING = 'https://sandbox-login.uber.com'
export const UBER_EATS_OAUTH_PRODUCTION = 'https://auth.uber.com'
export const UBER_EATS_API_TESTING = 'https://test-api.uber.com'
export const UBER_EATS_API_PRODUCTION = 'https://api.uber.com'

/** @deprecated Use {@link uberEatsOAuthBaseUrl} */
export const UBER_OAUTH_ORIGIN = UBER_EATS_OAUTH_PRODUCTION

/**
 * Uber Eats Testing apps only exist on `sandbox-login.uber.com`; production apps
 * on `auth.uber.com`. Mixing realms yields `invalid_client` / client metadata errors.
 */
export function resolveUberEatsRealm(): 'testing' | 'production' {
	const mode = readEnv('UBER_EATS_ENVIRONMENT')?.toLowerCase()
	if (mode === 'production' || mode === 'live') return 'production'
	if (mode === 'testing' || mode === 'test' || mode === 'sandbox') {
		return 'testing'
	}

	const authorize = readEnv('UBER_EATS_AUTHORIZE_URL')
	if (authorize?.includes('sandbox-login')) return 'testing'
	if (authorize?.includes('auth.uber.com')) return 'production'

	const api = readEnv('UBER_EATS_BASE_URL')
	if (api?.includes('test-api.uber.com')) return 'testing'
	if (api?.includes('api.uber.com')) return 'production'

	// New Uber Eats apps are usually "Testing" in the developer dashboard.
	return 'testing'
}

export function uberEatsOAuthBaseUrl(configured?: string): string {
	if (configured && !isPlaceholder(configured)) {
		const trimmed = configured.replace(/\/$/, '')
		if (trimmed.includes('sandbox-login.uber.com')) {
			return UBER_EATS_OAUTH_TESTING
		}
		if (trimmed.includes('auth.uber.com')) return UBER_EATS_OAUTH_PRODUCTION
		if (trimmed.includes('login.uber.com')) {
			return resolveUberEatsRealm() === 'testing'
				? UBER_EATS_OAUTH_TESTING
				: UBER_EATS_OAUTH_PRODUCTION
		}
		return trimmed
	}
	return resolveUberEatsRealm() === 'testing'
		? UBER_EATS_OAUTH_TESTING
		: UBER_EATS_OAUTH_PRODUCTION
}

export function uberEatsApiBaseUrl(configured?: string): string {
	if (configured && !isPlaceholder(configured)) {
		return configured.replace(/\/$/, '')
	}
	return resolveUberEatsRealm() === 'testing'
		? UBER_EATS_API_TESTING
		: UBER_EATS_API_PRODUCTION
}

/** Uber Eats OAuth authorize + token host for the active realm. */
export function uberOAuthOrigin(configured?: string): string {
	return uberEatsOAuthBaseUrl(configured)
}

export function squareOAuthAuthorizeOrigin(clientId: string): string {
	return clientId.startsWith('sandbox-')
		? SQUARE_SANDBOX_CONNECT
		: SQUARE_PRODUCTION_CONNECT
}

/** Square OAuth + Connect API must use the `connect.*` host, not `squareupsandbox.com`. */
function normalizeSquareConnectUrl(url: string, clientId?: string): string {
	const fallback = clientId?.startsWith('sandbox-')
		? SQUARE_SANDBOX_CONNECT
		: SQUARE_PRODUCTION_CONNECT
	const trimmed = url.replace(/\/$/, '')
	const brokenSandbox = new Set([
		'https://squareupsandbox.com',
		'http://squareupsandbox.com',
	])
	const brokenProd = new Set([
		'https://squareup.com',
		'https://www.squareup.com',
		'http://squareup.com',
	])
	if (brokenSandbox.has(trimmed)) return SQUARE_SANDBOX_CONNECT
	if (brokenProd.has(trimmed)) return SQUARE_PRODUCTION_CONNECT
	if (
		!trimmed.includes('connect.') &&
		trimmed.includes('squareupsandbox.com')
	) {
		return SQUARE_SANDBOX_CONNECT
	}
	if (
		!trimmed.includes('connect.') &&
		(trimmed.includes('squareup.com') || trimmed.includes('square.com'))
	) {
		return fallback
	}
	return trimmed || fallback
}

export type PosCredentials = {
	mode: 'sandbox' | 'live'
	token: string
	merchantId: string
	baseUrl: string
}

/** Sandbox credentials for MSW-backed connections (no merchant OAuth). */
export function resolveCredentials(provider: PosProvider): PosCredentials {
	return {
		mode: 'sandbox',
		token: POS_SANDBOX_TOKEN,
		merchantId: merchantIds[provider],
		baseUrl: sandboxUrls[provider],
	}
}

export type PosAppCredentials = {
	provider: PosProvider
	clientId: string
	clientSecret: string
	authorizeBaseUrl: string
	apiBaseUrl: string
}

/** OAuth app credentials for a platform, or null when it has none. */
export function resolveAppCredentials(
	provider: PosProvider,
): PosAppCredentials | null {
	if (provider === 'doordash') return null
	const keys = APP_CREDENTIAL_ENV[provider]
	const clientId = readEnv(keys.clientId)
	const clientSecret = readEnv(keys.clientSecret)
	if (isPlaceholder(clientId) || isPlaceholder(clientSecret)) return null
	const configuredAuthorize = readEnv(keys.authorizeUrl ?? '')
	const configuredApi = readEnv(keys.apiBaseUrl ?? '')
	return {
		provider,
		clientId: clientId!,
		clientSecret: clientSecret!,
		authorizeBaseUrl:
			provider === 'square'
				? squareOAuthAuthorizeOrigin(clientId!)
				: provider === 'ubereats'
					? uberEatsOAuthBaseUrl(configuredAuthorize)
					: normalizePosAuthorizeBaseUrl(
							provider,
							configuredAuthorize ?? DEFAULT_AUTHORIZE[provider],
							clientId,
						),
		apiBaseUrl:
			provider === 'ubereats'
				? uberEatsApiBaseUrl(configuredApi)
				: normalizePosApiBaseUrl(
						provider,
						configuredApi ?? DEFAULT_API[provider],
						clientId,
					),
	}
}

/** OAuth authorize/login host (Square uses the same Connect host as the API). */
export function normalizePosAuthorizeBaseUrl(
	provider: PosProvider,
	url: string | undefined,
	clientId?: string,
): string {
	const fallback = DEFAULT_AUTHORIZE[provider]
	if (!url || isPlaceholder(url)) return fallback
	const trimmed = url.replace(/\/$/, '')
	if (provider === 'square') {
		return normalizeSquareConnectUrl(trimmed, clientId)
	}
	return trimmed
}

export function hasAppCredentials(provider: PosProvider): boolean {
	if (provider === 'doordash') {
		return resolveDoorDashJwtCredentials() !== null
	}
	return resolveAppCredentials(provider) !== null
}

/** REST + OAuth token hosts (not the Clover authorize/login host). */
export function normalizePosApiBaseUrl(
	provider: PosProvider,
	url: string | undefined,
	clientId?: string,
): string {
	const fallback = DEFAULT_API[provider]
	if (!url || isPlaceholder(url)) return fallback
	const trimmed = url.replace(/\/$/, '')
	if (provider === 'square') {
		return normalizeSquareConnectUrl(trimmed, clientId)
	}
	if (provider === 'clover') {
		// Common misconfiguration: CLOVER_BASE_URL = https://sandbox.dev.clover.com
		if (
			trimmed.includes('sandbox.dev.clover.com') &&
			!trimmed.includes('apisandbox')
		) {
			return fallback
		}
		if (trimmed === 'https://www.clover.com') {
			return 'https://api.clover.com'
		}
	}
	return trimmed
}

/** The real API base for a platform, or the sandbox host as a fallback. */
export function liveApiBaseUrl(provider: PosProvider): string {
	if (provider === 'doordash') {
		return (
			resolveDoorDashJwtCredentials()?.apiBaseUrl ??
			normalizePosApiBaseUrl('doordash', DEFAULT_API.doordash)
		)
	}
	const configured = resolveAppCredentials(provider)?.apiBaseUrl
	return normalizePosApiBaseUrl(provider, configured ?? sandboxUrls[provider])
}

/** MSW is skipped when Menuza has OAuth app credentials for the platform. */
export function shouldSkipMock(provider: PosProvider): boolean {
	return hasAppCredentials(provider)
}

/** @deprecated Use hasAppCredentials; live merchants always OAuth per org. */
export function hasLiveCredentials(_provider: PosProvider): boolean {
	return false
}
