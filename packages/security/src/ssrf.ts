/**
 * SSRF (Server-Side Request Forgery) protection utilities
 *
 * Provides both textual URL validation and DNS-resolution-based
 * validation to prevent DNS rebinding attacks.
 */

import { fetchNoRedirect, RedirectBlockedError } from './fetch-no-redirect.js'
import dns from 'node:dns'
import { isIP } from 'node:net'

function isPrivateIpv4Octets(p1: number, p2: number, p3 = 0): boolean {
	return (
		p1 === 0 || // 0.0.0.0/8 - current network
		p1 === 10 || // 10.0.0.0/8
		p1 === 127 || // 127.0.0.0/8 - loopback
		(p1 === 172 && p2 >= 16 && p2 <= 31) || // 172.16.0.0/12
		(p1 === 192 && p2 === 168) || // 192.168.0.0/16
		(p1 === 169 && p2 === 254) || // 169.254.0.0/16 - link-local / cloud metadata
		(p1 === 100 && p2 >= 64 && p2 <= 127) || // 100.64.0.0/10 - CGNAT / cloud VPC
		(p1 === 192 && p2 === 0 && p3 === 0) || // 192.0.0.0/24 - IETF protocol assignments
		(p1 === 192 && p2 === 0 && p3 === 2) || // 192.0.2.0/24 - documentation
		(p1 === 192 && p2 === 88 && p3 === 99) || // 192.88.99.0/24 - deprecated 6to4 relay
		(p1 === 198 && (p2 === 18 || p2 === 19)) || // 198.18.0.0/15 - benchmarking
		(p1 === 198 && p2 === 51 && p3 === 100) || // 198.51.100.0/24 - documentation
		(p1 === 203 && p2 === 0 && p3 === 113) || // 203.0.113.0/24 - documentation
		p1 >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
	)
}

/**
 * Parse an IPv6 literal (without brackets) into 8 16-bit groups, or null.
 * Handles `::` compression and a trailing dotted IPv4 part.
 */
function parseIpv6(ip: string): number[] | null {
	let text = ip
	const zone = text.indexOf('%')
	if (zone !== -1) text = text.slice(0, zone)

	// Convert a trailing dotted-quad into two hex groups.
	const lastColon = text.lastIndexOf(':')
	const tail = text.slice(lastColon + 1)
	if (tail.includes('.')) {
		const m = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
		if (!m) return null
		const o = m.slice(1).map(Number)
		if (o.some((n) => n > 255)) return null
		text =
			text.slice(0, lastColon + 1) +
			(((o[0]! << 8) | o[1]!).toString(16) +
				':' +
				((o[2]! << 8) | o[3]!).toString(16))
	}

	const halves = text.split('::')
	if (halves.length > 2) return null
	const parse = (part: string) => (part === '' ? [] : part.split(':'))
	const head = parse(halves[0]!)
	const rest = halves.length === 2 ? parse(halves[1]!) : []
	if (halves.length === 1 && head.length !== 8) return null
	if (halves.length === 2 && head.length + rest.length > 7) return null
	const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
	const groups = [...head, ...Array(fill).fill('0'), ...rest]
	if (groups.length !== 8) return null
	const out: number[] = []
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
		out.push(parseInt(g, 16))
	}
	return out
}

/**
 * Check whether an IP address falls in a private, loopback, link-local,
 * or otherwise non-routable range. Takes an IP literal only: any other string,
 * including a hostname, is unparseable and so reported as private. IPv6 literals are parsed, so an IPv4
 * address hidden in an IPv4-mapped (`::ffff:a9fe:a9fe`), IPv4-compatible or
 * NAT64 form is checked against the IPv4 ranges. Unparseable input is
 * treated as private (fail closed).
 */
export function isPrivateIp(ip: string): boolean {
	const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
	const match = ip.match(ipv4Regex)
	if (match) {
		return isPrivateIpv4Octets(
			Number(match[1]),
			Number(match[2]),
			Number(match[3]),
		)
	}

	const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase()
	const g = parseIpv6(normalized)
	if (!g) return true

	const embeddedV4 = (hi: number, lo: number) =>
		isPrivateIpv4Octets(hi >> 8, hi & 0xff, lo >> 8)

	const firstSixZero = g.slice(0, 6).every((x) => x === 0)
	const firstFiveZero = g.slice(0, 5).every((x) => x === 0)
	if (g.every((x) => x === 0)) return true // :: unspecified
	if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
	if (firstFiveZero && g[5] === 0xffff) return embeddedV4(g[6]!, g[7]!) // ::ffff:a.b.c.d
	if (firstFiveZero && g[5] === 0) {
		// IPv4-compatible (::a.b.c.d), deprecated
		if (firstSixZero) return embeddedV4(g[6]!, g[7]!)
	}
	// 64:ff9b::/96 NAT64 well-known prefix
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
		return embeddedV4(g[6]!, g[7]!)
	}
	// 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
	if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true
	// 2002::/16 6to4 embeds the IPv4 address in groups 1-2
	if (g[0] === 0x2002) return embeddedV4(g[1]!, g[2]!)
	return (
		(g[0]! & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
		(g[0]! & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(g[0]! & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
		(g[0]! & 0xff00) === 0xff00 || // ff00::/8 multicast
		(g[0] === 0x2001 && g[1] === 0x0db8) // 2001:db8::/32 documentation
	)
}

/**
 * Textual URL validation — checks scheme, credentials, and hostname strings.
 * Synchronous and fast, but does NOT protect against DNS rebinding.
 * Use `validateInstanceUrlWithDns` for full protection.
 */
export function validateInstanceUrl(urlStr: string): {
	valid: boolean
	reason?: string
} {
	try {
		const parsed = new URL(urlStr)

		// Require HTTPS scheme exclusively
		if (parsed.protocol !== 'https:') {
			return { valid: false, reason: 'Invalid protocol: HTTPS is required' }
		}

		// Block credentials in URLs (e.g., https://user:pass@host)
		if (parsed.username || parsed.password) {
			return {
				valid: false,
				reason: 'URL contains credentials (SSRF protection)',
			}
		}

		const hostname = parsed.hostname.toLowerCase()

		// Block localhost, internal hostnames, and cloud metadata endpoints
		if (
			hostname === 'localhost' ||
			hostname.endsWith('.local') ||
			hostname.endsWith('.internal') ||
			hostname === '169.254.169.254' ||
			hostname === '0.0.0.0' ||
			hostname === '::1' ||
			hostname === '[::1]'
		) {
			return {
				valid: false,
				reason: 'Forbidden target domain or IP (SSRF protection)',
			}
		}

		// Block IPv6 unique-local (fd00::/8) and link-local (fe80::/10) ranges
		if (
			hostname.startsWith('fd') ||
			hostname.startsWith('[fd') ||
			hostname.startsWith('fe8') ||
			hostname.startsWith('[fe8') ||
			hostname.startsWith('fe9') ||
			hostname.startsWith('[fe9') ||
			hostname.startsWith('fea') ||
			hostname.startsWith('[fea') ||
			hostname.startsWith('feb') ||
			hostname.startsWith('[feb')
		) {
			return {
				valid: false,
				reason:
					'IPv6 unique-local/link-local address blocked (SSRF protection)',
			}
		}

		// Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16)
		const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
		const match = hostname.match(ipv4Regex)
		if (match) {
			const p1 = Number(match[1])
			const p2 = Number(match[2])
			if (
				p1 === 10 ||
				p1 === 127 ||
				(p1 === 172 && p2 >= 16 && p2 <= 31) ||
				(p1 === 192 && p2 === 168) ||
				(p1 === 169 && p2 === 254)
			) {
				return {
					valid: false,
					reason: 'Private/Internal IP address blocked (SSRF protection)',
				}
			}
		}

		return { valid: true }
	} catch {
		return { valid: false, reason: 'Invalid URL format' }
	}
}

/**
 * Full URL validation with DNS resolution.
 * Resolves the hostname and checks that none of the resolved IPs are
 * private/internal. This prevents DNS rebinding attacks where a hostname
 * like `localtest.me` resolves to `127.0.0.1`.
 */
export async function validateInstanceUrlWithDns(urlStr: string): Promise<{
	valid: boolean
	reason?: string
}> {
	// Run textual checks first (fast path)
	const textualResult = validateInstanceUrl(urlStr)
	if (!textualResult.valid) {
		return textualResult
	}

	const parsed = new URL(urlStr)
	const hostname = parsed.hostname

	// If the hostname is already an IP literal, check it directly
	if (isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 && isPrivateIp(hostname)) {
		return {
			valid: false,
			reason: 'Private/Internal IP address blocked (SSRF protection)',
		}
	}

	// Resolve DNS and validate all returned IPs
	try {
		const [ipv4Results, ipv6Results] = await Promise.allSettled([
			dns.promises.resolve4(hostname),
			dns.promises.resolve6(hostname),
		])

		const resolvedIps: string[] = []

		if (ipv4Results.status === 'fulfilled') {
			resolvedIps.push(...ipv4Results.value)
		}
		if (ipv6Results.status === 'fulfilled') {
			resolvedIps.push(...ipv6Results.value)
		}

		// If we got no IPs at all, DNS resolution failed
		if (resolvedIps.length === 0) {
			return {
				valid: false,
				reason: 'DNS resolution failed for hostname',
			}
		}

		// Check every resolved IP
		for (const ip of resolvedIps) {
			if (isPrivateIp(ip)) {
				return {
					valid: false,
					reason: `DNS resolves to private/internal IP address (SSRF protection): ${ip}`,
				}
			}
		}

		return { valid: true }
	} catch {
		return {
			valid: false,
			reason: 'DNS resolution failed for hostname',
		}
	}
}

/**
 * SSRF-safe fetch wrapper.
 *
 * Validates the URL (including DNS resolution) before making the request.
 * Blocks redirects to prevent redirect-based SSRF bypasses.
 *
 * Use this instead of raw `fetch()` for any request where the URL is
 * derived from user-controlled input.
 */
export async function ssrfSafeFetch(
	url: string | URL,
	init?: RequestInit,
): Promise<Response> {
	const urlStr = typeof url === 'string' ? url : url.toString()

	const validation = await validateInstanceUrlWithDns(urlStr)
	if (!validation.valid) {
		throw new Error(`SSRF security validation failed: ${validation.reason}`)
	}

	try {
		return await fetchNoRedirect(urlStr, init)
	} catch (error) {
		// A safe URL could redirect to an internal one, so a redirect is refused
		// (never followed). Callers that need to follow redirects must validate
		// each hop themselves. Callers see this error, never a 3xx response.
		if (error instanceof RedirectBlockedError) {
			throw new Error('SSRF security validation failed: redirect blocked')
		}
		throw error
	}
}
