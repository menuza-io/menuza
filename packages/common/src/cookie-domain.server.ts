import { ENV } from './env.js'
const OPERATOR_HOST_LABELS = new Set([
	'app',
	'admin',
	'app-staging',
	'admin-staging',
])

/**
 * Cookie Domain for App/Admin when they run as `app.{apex}` / `admin.{apex}`
 * (production) or `app-staging.{apex}` / `admin-staging.{apex}` (staging).
 *
 * `admin.preview.example.dev` → `.preview.example.dev`
 * `app-staging.example.com` → `.example.com`
 * `localhost` / workers.dev previews → omit (host-only cookie)
 */
export function sharedCookieDomainFromHost(
	hostHeader: string | null | undefined,
): string | undefined {
	const host = hostHeader?.split(':')[0]?.toLowerCase() ?? ''
	if (!host || host === '127.0.0.1') return undefined
	if (host === 'localhost') return undefined
	if (host.endsWith('.localhost')) return '.localhost'

	const parts = host.split('.').filter(Boolean)
	const subdomain = parts[0]
	if (!subdomain || !OPERATOR_HOST_LABELS.has(subdomain) || parts.length < 3) {
		return undefined
	}

	return `.${parts.slice(1).join('.')}`
}

export function sharedCookieDomain(
	origin = ENV.BASE_URL,
): string | undefined {
	if (!origin) return undefined
	try {
		return sharedCookieDomainFromHost(new URL(origin).host)
	} catch {
		return undefined
	}
}

export function isStagingOperatorHost(
	hostHeader: string | null | undefined,
): boolean {
	const host = hostHeader?.split(':')[0]?.toLowerCase() ?? ''
	return host.startsWith('app-staging.') || host.startsWith('admin-staging.')
}

export function isStagingOperatorOrigin(origin?: string): boolean {
	if (!origin) return false
	try {
		return isStagingOperatorHost(new URL(origin).hostname)
	} catch {
		return false
	}
}

export function isAppOperatorHost(
	hostHeader: string | null | undefined,
): boolean {
	const host = hostHeader?.split(':')[0]?.toLowerCase() ?? ''
	return host.startsWith('app.') || host.startsWith('app-staging.')
}

export function isAdminOperatorHost(
	hostHeader: string | null | undefined,
): boolean {
	const host = hostHeader?.split(':')[0]?.toLowerCase() ?? ''
	return host.startsWith('admin.') || host.startsWith('admin-staging.')
}

/**
 * Whether `getUserId()` should return the impersonated target on this request.
 * Admin keeps the operator session; App shows the impersonated customer context.
 */
export function shouldApplyImpersonationToUserId(request: Request): boolean {
	const hostHeader =
		request.headers.get('host') ?? new URL(request.url).host
	if (isAdminOperatorHost(hostHeader)) return false
	if (isAppOperatorHost(hostHeader)) return true
	const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''
	// Plain localhost — App dev/e2e (Admin uses admin.* or a separate port).
	return host === 'localhost' || host.endsWith('.localhost')
}

/** Suffix staging operator cookie names so prod and staging can coexist in one browser. */
export function operatorCookieName(
	baseName: string,
	origin = ENV.BASE_URL,
): string {
	return isStagingOperatorOrigin(origin) ? `${baseName}_staging` : baseName
}

/** Shared theme preference cookie (`en_theme` / `en_theme_staging`). */
export function operatorThemeCookieName(origin = ENV.BASE_URL): string {
	return operatorCookieName('en_theme', origin)
}

type OperatorHostLabel = 'app' | 'admin' | 'app-staging' | 'admin-staging'

function getOperatorHostLabel(
	role: 'app' | 'admin',
	referenceOrigin: string,
): OperatorHostLabel {
	const staging = isStagingOperatorOrigin(referenceOrigin)
	return staging ? `${role}-staging` : role
}

/**
 * Cross-origin URL for the main operator app (`app.{apex}` or `app-staging.{apex}`).
 * Port and protocol are copied from the reference origin (typically this app's BASE_URL).
 */
export function getOperatorAppUrl(
	referenceOrigin: string,
	rootApp: string,
): string {
	const ref = new URL(referenceOrigin)
	const hostLabel = getOperatorHostLabel('app', referenceOrigin)
	const port = ref.port ? `:${ref.port}` : ''
	return `${ref.protocol}//${hostLabel}.${rootApp}${port}`
}

/**
 * Cross-origin URL for the admin dashboard (`admin.{apex}` or `admin-staging.{apex}`).
 */
export function getOperatorAdminUrl(
	referenceOrigin: string,
	rootApp: string,
): string {
	const ref = new URL(referenceOrigin)
	const hostLabel = getOperatorHostLabel('admin', referenceOrigin)
	const port = ref.port ? `:${ref.port}` : ''
	return `${ref.protocol}//${hostLabel}.${rootApp}${port}`
}
