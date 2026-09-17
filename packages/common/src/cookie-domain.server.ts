import { ENV } from './package-env.js'

function runtimeBaseUrl(): string | undefined {
	return process.env.BASE_URL || ENV.BASE_URL
}

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
	origin = runtimeBaseUrl(),
): string | undefined {
	if (!origin) return undefined
	try {
		return sharedCookieDomainFromHost(new URL(origin).host)
	} catch {
		return undefined
	}
}

function originHostname(origin: string | null | undefined): string | undefined {
	if (!origin) return undefined
	try {
		return new URL(origin).hostname.toLowerCase()
	} catch {
		return undefined
	}
}

function isLocalhostHostname(host: string): boolean {
	return (
		host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')
	)
}

/** RFC 2606 `.test` — local dev hostnames in `.env.schema` (not production apexes). */
function isDevTestHostname(host: string): boolean {
	return host === 'test' || host.endsWith('.test')
}

/**
 * Amp orbs serve App and Admin from sibling portal hostnames
 * (`t-<thread>-p<port>.<portal-domain>`), so the operator session has to live on
 * the shared portal domain to make a sign-in in one app apply to the other.
 * Cookie names are scoped by thread so parallel orbs in one browser do not
 * overwrite each other's sessions. Returns undefined outside orbs and for hosts
 * that are not Amp portal hostnames.
 */
function orbPortalCookieScope(
	origin: string | undefined,
): { domain: string; suffix: string } | undefined {
	if (!process.env.AMP_ORB || !origin) return undefined
	try {
		const labels = new URL(origin).hostname.split('.').filter(Boolean)
		const [label, ...rest] = labels
		if (!label || rest.length < 2) return undefined
		// Portal hostnames end with the public portal port: t-<thread>-p<port>.
		const threadLabel = label.replace(/-p\d+$/i, '')
		if (threadLabel === label) return undefined
		return { domain: `.${rest.join('.')}`, suffix: `_${threadLabel}` }
	} catch {
		return undefined
	}
}

/**
 * Cookie Domain for operator auth sessions (`en_session`, `en_imp_session`).
 *
 * Playwright and some flows use `http://localhost:{port}` while `BASE_URL` may
 * still point at a production-shaped apex. Setting `Domain` from that apex would
 * prevent the browser from storing the cookie on localhost. When `MOCKS=true`
 * (local `npm run dev` and CI E2E), use host-only cookies unless `BASE_URL` is
 * localhost-shaped (including `app.localhost`) or a reserved `.test` dev hostname
 * (`app.epic-startup.test`) that matches how local HTTPS dev is served.
 */
export function operatorSessionCookieDomain(
	origin = runtimeBaseUrl(),
): string | undefined {
	const orbScope = orbPortalCookieScope(origin)
	if (orbScope) return orbScope.domain

	const fromOrigin = sharedCookieDomain(origin)
	if (!fromOrigin) return undefined

	if (process.env.MOCKS === 'true') {
		const host = originHostname(origin)
		if (host && !isLocalhostHostname(host) && !isDevTestHostname(host)) {
			return undefined
		}
	}

	return fromOrigin
}

/**
 * Domain for operator UI cookies (locale, theme, client hints, redirectTo).
 * Uses the request Host first so localhost E2E stays host-only when BASE_URL
 * is configured for OAuth on `*.test`; falls back to session cookie rules.
 */
export function operatorSharedCookieDomain(
	request?: Request | null,
): string | undefined {
	if (!request) return operatorSessionCookieDomain()

	const host =
		request.headers.get('x-forwarded-host') ??
		request.headers.get('host') ??
		new URL(request.url).host

	const fromHost = sharedCookieDomainFromHost(host)
	if (fromHost) return fromHost

	const hostname = host.split(':')[0]?.toLowerCase() ?? ''
	if (isLocalhostHostname(hostname)) return undefined

	return operatorSessionCookieDomain()
}

/** Public origin for CSRF checks behind reverse proxies (Cloudflare, etc.). */
export function requestPublicOrigin(request: Request): string {
	const url = new URL(request.url)
	const forwardedHost = request.headers
		.get('x-forwarded-host')
		?.split(',')[0]
		?.trim()
	if (forwardedHost) {
		url.host = forwardedHost
	} else {
		const host = request.headers.get('host')
		if (host) url.host = host
	}
	const forwardedProto = request.headers
		.get('x-forwarded-proto')
		?.split(',')[0]
		?.trim()
	if (forwardedProto) {
		url.protocol = `${forwardedProto}:`
	}
	return url.origin
}

/**
 * Parent-domain consent/theme cookies for the marketing site (`www` / apex).
 * Uses host-only cookies on localhost so dev on `:3002` is not paired with
 * `Domain=.epic-startup.test` from env defaults.
 */
export function marketingSharedCookieDomain(
	request: Request,
	publicRootApp?: string | null,
): string | undefined {
	const host =
		request.headers.get('x-forwarded-host') ??
		request.headers.get('host') ??
		new URL(request.url).host
	const hostname = host.split(':')[0]?.toLowerCase() ?? ''
	if (isLocalhostHostname(hostname)) return undefined

	const root = publicRootApp?.trim().replace(/^\.+/, '')
	if (root && !isLocalhostHostname(root)) {
		return `.${root}`
	}

	return operatorSharedCookieDomain(request)
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
	const hostHeader = request.headers.get('host') ?? new URL(request.url).host
	if (isAdminOperatorHost(hostHeader)) return false
	if (isAppOperatorHost(hostHeader)) return true
	const host = hostHeader.split(':')[0]?.toLowerCase() ?? ''
	// Plain localhost — App dev/e2e (Admin uses admin.* or a separate port).
	return host === 'localhost' || host.endsWith('.localhost')
}

/** Suffix staging operator cookie names so prod and staging can coexist in one browser. */
export function operatorCookieName(
	baseName: string,
	origin = runtimeBaseUrl(),
): string {
	const orbScope = orbPortalCookieScope(origin)
	if (orbScope) return `${baseName}${orbScope.suffix}`
	return isStagingOperatorOrigin(origin) ? `${baseName}_staging` : baseName
}

/** Shared theme preference cookie (`en_theme` / `en_theme_staging`). */
export function operatorThemeCookieName(origin = runtimeBaseUrl()): string {
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
