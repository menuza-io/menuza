export type CredentialRateLimit = {
	scope: string
	maxRequests: number
	windowMs: number
}

const WINDOW_MS = 60_000

// Same strict tier as server/index.ts (10/min per IP) for interactive
// credential entry.
const STRICT: CredentialRateLimit = {
	scope: 'worker-credential-routes',
	maxRequests: 10,
	windowMs: WINDOW_MS,
}

// Token refresh is automatic and shares an IP with everyone behind the same
// carrier NAT or office, so it gets a wider budget than password entry.
const REFRESH: CredentialRateLimit = {
	scope: 'worker-token-refresh',
	maxRequests: 60,
	windowMs: WINDOW_MS,
}

// Each passkey sign-in starts with an unauthenticated GET that writes a
// challenge row to the database, so that GET is limited too, on its own budget
// so opening the login page a few times does not use up the password tier.
const PASSKEY_CHALLENGE: CredentialRateLimit = {
	scope: 'worker-passkey-challenge',
	maxRequests: 30,
	windowMs: WINDOW_MS,
}

const PASSKEY_AUTHENTICATION = '/webauthn/authentication'

const STRICT_PREFIXES = [
	'/login',
	'/signup',
	'/verify',
	'/reset-password',
	'/resources/login',
	'/resources/verify',
	'/api/auth/login',
	'/api/auth/signup',
	PASSKEY_AUTHENTICATION,
]

function matchesPrefix(pathname: string, prefix: string) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * React Router matches routes case-insensitively and decodes path segments, so
 * `/LOGIN` and `/%6Cogin` reach the login action. Normalize the same way before
 * comparing, or a guess can dodge the limit by changing its spelling.
 */
function normalizePath(rawPathname: string) {
	let path = rawPathname
	try {
		path = decodeURIComponent(path)
	} catch {
		// An undecodable path matches no route; compare it as written.
	}
	return (
		path
			.toLowerCase()
			.replace(/\.data$/, '')
			.replace(/\/{2,}/g, '/')
			.replace(/\/+$/, '') || '/'
	)
}

/**
 * Which limit applies to a request, or null when none does. Matches whole path
 * segments (so `/login-help` is not throttled) and treats a single-fetch
 * `.data` request like its page route.
 */
export function credentialRateLimitFor(
	method: string,
	rawPathname: string,
): CredentialRateLimit | null {
	const pathname = normalizePath(rawPathname)
	if (method === 'GET' || method === 'HEAD') {
		return matchesPrefix(pathname, PASSKEY_AUTHENTICATION)
			? PASSKEY_CHALLENGE
			: null
	}
	if (matchesPrefix(pathname, '/mcp')) return null
	if (matchesPrefix(pathname, '/api/auth/refresh')) return REFRESH
	if (STRICT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
		return STRICT
	}
	return null
}
