/**
 * Where a website redirect may send visitors (#248, extending #88). One
 * validator for the redirects form, the redirects list ("needs attention") and
 * anything else that stores a destination; there is no second one.
 *
 * Allowed: an internal path (`/menu`), or an `https://` address that is not on
 * the site's own domains and carries no credentials. Refused: credentials
 * (`https://user:pass@host`), plain `http://` to anywhere else, an address on
 * one of the organization's own site domains (use the path instead), scheme
 * relative addresses, control characters, and internal paths that target
 * system routes (`/api`, `/login`, `/profile`, ...).
 */

export const REDIRECT_DESTINATION_ERROR =
	'Destination must be an internal path (e.g. /page) or a valid https:// URL.'

/** Internal paths a redirect may never target (and everything below them). */
export const SYSTEM_REDIRECT_PATHS = [
	'/api',
	'/login',
	'/logout',
	'/profile',
	'/resources',
	'/cdn-cgi',
] as const

export type RedirectDestinationErrorCode =
	| 'empty'
	| 'invalid'
	| 'credentials'
	| 'not_https'
	| 'own_domain'
	| 'system_path'

export type RedirectDestinationCheck =
	| { ok: true; kind: 'internal' | 'external'; value: string }
	| {
			ok: false
			code: RedirectDestinationErrorCode
			/** For `own_domain`: the same address as an internal path. */
			suggestedPath?: string
	  }

/** English text; the App shows translated copy chosen by `code`. */
export const REDIRECT_DESTINATION_MESSAGES: Record<
	RedirectDestinationErrorCode,
	string
> = {
	empty: 'Destination is required.',
	invalid: REDIRECT_DESTINATION_ERROR,
	credentials:
		'A destination cannot contain a username or password. Remove it from the address.',
	not_https:
		'Use an https:// address. Plain http:// is only allowed for a path on your own site.',
	own_domain:
		'That address is on your own website. Use the path instead (for example /menu).',
	system_path:
		'That path belongs to the platform (for example /api or /login) and cannot be a destination.',
}

function hostKey(host: string) {
	return host
		.toLowerCase()
		.replace(/\.$/, '')
		.replace(/^www\./, '')
}

function isSystemPath(path: string) {
	const clean = path.split(/[?#]/u)[0]!.toLowerCase().replace(/\/+$/u, '')
	return SYSTEM_REDIRECT_PATHS.some(
		(prefix) => clean === prefix || clean.startsWith(`${prefix}/`),
	)
}

/**
 * Checks a destination. `siteHosts` are the organization's own site hosts
 * (its platform address and custom domain); an `https://` address on one of
 * them is refused with the path to use instead. `www.` is ignored when
 * comparing, since both names are the same site.
 */
export function checkRedirectDestination(
	raw: string,
	options: { siteHosts?: readonly string[] } = {},
): RedirectDestinationCheck {
	const trimmed = raw.trim()
	if (!trimmed) return { ok: false, code: 'empty' }
	// Browsers strip tab/CR/LF from URLs, so `/\t/evil.com` would become `//evil.com`.
	if (/[\u0000-\u001f\u007f]/.test(trimmed))
		return { ok: false, code: 'invalid' }
	// Scheme-relative URLs like //evil.com.
	if (trimmed.startsWith('//')) return { ok: false, code: 'invalid' }

	if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
		let parsed: URL
		try {
			parsed = new URL(trimmed)
		} catch {
			return { ok: false, code: 'invalid' }
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return { ok: false, code: 'invalid' }
		}
		if (parsed.username || parsed.password) {
			return { ok: false, code: 'credentials' }
		}
		const own = (options.siteHosts ?? []).map(hostKey)
		if (own.includes(hostKey(parsed.hostname))) {
			const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
			return {
				ok: false,
				code: 'own_domain',
				suggestedPath: path || '/',
			}
		}
		if (parsed.protocol === 'http:') return { ok: false, code: 'not_https' }
		return { ok: true, kind: 'external', value: trimmed }
	}

	// An internal path starts with exactly one slash, never a backslash.
	if (!trimmed.startsWith('/') || trimmed.startsWith('/\\')) {
		return { ok: false, code: 'invalid' }
	}
	if (isSystemPath(trimmed)) return { ok: false, code: 'system_path' }
	return { ok: true, kind: 'internal', value: trimmed }
}

/** The structural rules alone (no knowledge of the site's own domains). */
export function isValidRedirectDestination(val: string): boolean {
	return checkRedirectDestination(val).ok
}

/** The hosts that are this organization's own website. */
export function siteHostsOf(input: {
	slug: string
	customDomain: string | null
	/** The platform address of the site (`<slug>.<apex>`), when known. */
	platformHost?: string | null
}): string[] {
	const hosts = new Set<string>()
	if (input.customDomain) hosts.add(input.customDomain.toLowerCase())
	if (input.platformHost) hosts.add(input.platformHost.toLowerCase())
	return [...hosts]
}
