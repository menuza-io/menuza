import { parse as parseTld } from 'tldts'

/**
 * Custom domain hostnames (#139): normalization, apex and www pairing, and the
 * platform-host guard. Pure: no I/O, so App, Sites tests and jobs share it.
 */

export type HostnameError =
	'empty' | 'invalid' | 'too_long' | 'ip_address' | 'no_registrable_domain'

export type ParsedHostname =
	{ ok: true; hostname: string } | { ok: false; error: HostnameError }

const LABEL_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Lower case, no scheme, credentials, port, path, query or trailing dot, and
 * punycode for non-ASCII labels. Returns '' for input that is not a host.
 */
export function normalizeHostname(input: string): string {
	let value = input.trim().toLowerCase()
	value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
	value = value.split(/[/?#]/u)[0] ?? ''
	value = value.includes('@') ? (value.split('@').pop() ?? '') : value
	value = value.replace(/:\d*$/u, '')
	value = value.replace(/\.+$/u, '')
	if (!value) return ''
	try {
		// WHATWG URL converts IDN labels to punycode and lower-cases ASCII.
		const url = new URL(`http://${value}`)
		return url.hostname.replace(/\.+$/u, '')
	} catch {
		return ''
	}
}

export function parseHostname(input: string): ParsedHostname {
	if (!input.trim()) return { ok: false, error: 'empty' }
	const hostname = normalizeHostname(input)
	if (!hostname) return { ok: false, error: 'invalid' }
	if (hostname.length > 253) return { ok: false, error: 'too_long' }
	if (
		IPV4_RE.test(hostname) ||
		hostname.includes(':') ||
		hostname.startsWith('[')
	) {
		return { ok: false, error: 'ip_address' }
	}
	const labels = hostname.split('.')
	if (labels.length < 2) return { ok: false, error: 'invalid' }
	if (!labels.every((label) => LABEL_RE.test(label))) {
		return { ok: false, error: 'invalid' }
	}
	// A TLD is never all digits, and `xn--` labels must be well formed.
	if (/^\d+$/u.test(labels[labels.length - 1]!)) {
		return { ok: false, error: 'invalid' }
	}
	const parsed = parseTld(hostname)
	if (!parsed.domain) return { ok: false, error: 'no_registrable_domain' }
	return { ok: true, hostname }
}

export function isValidHostname(input: string): boolean {
	return parseHostname(input).ok
}

export type HostRole = 'apex' | 'www' | 'subdomain'

export type HostnameParts = {
	hostname: string
	/** The registrable domain (`example.com`, `example.co.uk`). */
	apex: string
	/** The labels left of the apex (`www`, `shop.eu`), or null. */
	subdomain: string | null
	role: HostRole
	publicSuffix: string
}

export function describeHostname(hostname: string): HostnameParts | null {
	const parsed = parseTld(hostname)
	if (!parsed.domain || !parsed.publicSuffix) return null
	const subdomain = parsed.subdomain || null
	const role: HostRole =
		subdomain === null ? 'apex' : subdomain === 'www' ? 'www' : 'subdomain'
	return {
		hostname,
		apex: parsed.domain,
		subdomain,
		role,
		publicSuffix: parsed.publicSuffix,
	}
}

export type PrimaryForm = 'www' | 'apex'

/**
 * The hosts one connect request sets up. `example.com` or `www.example.com`
 * with a chosen primary form gives both, the other redirecting; any other
 * subdomain (`order.example.com`) is just itself.
 */
export function hostsForConnect(
	input: string,
	primaryForm: PrimaryForm,
): { primary: string; redirects: string[] } | null {
	const parts = describeHostname(input)
	if (!parts) return null
	if (parts.role === 'subdomain')
		return { primary: parts.hostname, redirects: [] }
	const apex = parts.apex
	const www = `www.${apex}`
	return primaryForm === 'www'
		? { primary: www, redirects: [apex] }
		: { primary: apex, redirects: [www] }
}

/** The other form (`example.com` <-> `www.example.com`), null for other subdomains. */
export function siblingHostname(hostname: string): string | null {
	const parts = describeHostname(hostname)
	if (!parts) return null
	if (parts.role === 'apex') return `www.${parts.apex}`
	if (parts.role === 'www') return parts.apex
	return null
}

export function hostRole(hostname: string): HostRole {
	return describeHostname(hostname)?.role ?? 'subdomain'
}

const NON_PUBLIC_SUFFIXES = new Set([
	'test',
	'local',
	'localhost',
	'internal',
	'invalid',
	'example',
	'lan',
	'home',
	'corp',
	'onion',
])

/**
 * Hosts a restaurant may not connect: the platform's own domains and every
 * subdomain of them (`hostname_reserved`), and names that are not public.
 */
export function isReservedHostname(
	hostname: string,
	platformDomains: readonly string[],
): boolean {
	const host = hostname.toLowerCase()
	const tld = host.split('.').pop() ?? ''
	if (NON_PUBLIC_SUFFIXES.has(tld)) return true
	return platformDomains
		.map((domain) => domain.toLowerCase().replace(/^\./u, ''))
		.filter(Boolean)
		.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** Strips one trailing dot and lower-cases a DNS name from a resolver. */
export function trimDnsName(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/u, '')
}

// ---------------------------------------------------------------------------
// Domain status vocabulary (shared by App screens, sweep and Sites)
// ---------------------------------------------------------------------------

export const SITE_DOMAIN_STATUSES = [
	'pending',
	'active',
	'moved',
	'blocked',
	'error',
	'expired',
] as const

export type SiteDomainStatus = (typeof SITE_DOMAIN_STATUSES)[number]

/** Statuses Sites serves a host for (as before #139: active and pending). */
export const SERVING_DOMAIN_STATUSES = ['active', 'pending'] as const

/** A pending host gets a "still not connected" email after this long (#139). */
export const DOMAIN_PENDING_REMINDER_MS = 7 * 24 * 60 * 60 * 1000
/** And is removed from Cloudflare and marked `expired` after this long. */
export const DOMAIN_PENDING_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
/** At most this many extra redirecting hosts per organization. */
export const MAX_SITE_DOMAINS = 10

export const DOMAIN_ERROR_CODES = [
	'hostname_reserved',
	'hostname_taken',
	'hostname_invalid',
	'domain_limit',
	'domain_unavailable',
	'tld_not_supported',
	'domain_in_use',
] as const
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

/** Whether the host should be treated as live (status and certificate). */
export function isDomainLive(domain: {
	status: string
	sslStatus?: string | null
}): boolean {
	if (domain.status !== 'active') return false
	return !domain.sslStatus || domain.sslStatus === 'active'
}
