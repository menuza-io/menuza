import type { Context } from 'hono'

/**
 * The client's network address, for rate limits and Turnstile hints. One
 * implementation for every route, so a hardening fix lands in one place.
 *
 * - **Worker runtime** (US default): there is no socket. Cloudflare sets
 *   `cf-connecting-ip` at the edge and overwrites any copy the client sent, so
 *   it is the client. The last `x-forwarded-for` entry (the one the nearest
 *   proxy appended; the first is client-supplied) is the fallback.
 * - **Node runtime** (OCI, `@hono/node-server`): the TCP peer is known.
 *   Forwarding headers are believed only when that peer is a proxy we expect
 *   in front of the node: a loopback, private, link-local or carrier-grade NAT
 *   address (a Cloudflare Tunnel, or a reverse proxy on the same host or
 *   network) or a Cloudflare edge address (the Cloudflare proxy). Any other
 *   peer reached port 8080 directly, so its headers are ignored and the peer
 *   itself is the client. A spoofed `cf-connecting-ip` therefore buys nothing.
 *
 * No environment variable is involved, so existing deployments keep working.
 */
export function clientAddress(c: Context): string | null {
	const peer = socketPeerAddress(c)
	if (peer === null) return headerAddress(c)
	if (isTrustedProxyAddress(peer)) return headerAddress(c) ?? peer
	return peer
}

/**
 * The address a rate limit counts: an IPv6 client is bucketed by its /64 (one
 * subscriber usually holds a whole /64, so per-address buckets would be free to
 * rotate); an IPv4 address is used as it is.
 */
export function addressBucket(address: string): string {
	const groups = parseIpv6(address)
	if (!groups) return address
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(':')}::/64`
}

/**
 * Only an explicit `NODE_ENV` of `development` or `test` is local; an unset or
 * unknown value is production, as everywhere else in this node.
 */
export function isLocalRuntime(): boolean {
	const nodeEnv =
		typeof process !== 'undefined' && process.env
			? process.env.NODE_ENV
			: undefined
	return nodeEnv === 'development' || nodeEnv === 'test'
}

// ---------------------------------------------------------------------------
// Internals (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and
 * /ips-v6, unchanged since 2021; checked 2026-11). A Node node behind the
 * Cloudflare proxy sees one of these as its TCP peer.
 */
const CLOUDFLARE_RANGES = [
	'173.245.48.0/20',
	'103.21.244.0/22',
	'103.22.200.0/22',
	'103.31.4.0/22',
	'141.101.64.0/18',
	'108.162.192.0/18',
	'190.93.240.0/20',
	'188.114.96.0/20',
	'197.234.240.0/22',
	'198.41.128.0/17',
	'162.158.0.0/15',
	'104.16.0.0/13',
	'104.24.0.0/14',
	'172.64.0.0/13',
	'131.0.72.0/22',
	'2400:cb00::/32',
	'2606:4700::/32',
	'2803:f800::/32',
	'2405:b500::/32',
	'2405:8100::/32',
	'2a06:98c0::/29',
	'2c0f:f248::/32',
]

/** Addresses only our own host or network can connect from. */
const LOCAL_RANGES = [
	'127.0.0.0/8',
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'169.254.0.0/16',
	'100.64.0.0/10',
	'::1/128',
	'fc00::/7',
	'fe80::/10',
]

type Range = { v6: boolean; base: bigint; bits: number }

function parseRange(cidr: string): Range {
	const [address = '', bitsText = ''] = cidr.split('/')
	const v4 = parseIpv4(address)
	const bits = Number(bitsText)
	if (v4 !== null) return { v6: false, base: BigInt(v4), bits }
	const v6 = parseIpv6(address)
	if (!v6) throw new Error(`Invalid range ${cidr}`)
	return { v6: true, base: ipv6ToBigInt(v6), bits }
}

const TRUSTED_RANGES = [...CLOUDFLARE_RANGES, ...LOCAL_RANGES].map(parseRange)

function inRange(range: Range, value: bigint, v6: boolean): boolean {
	if (range.v6 !== v6) return false
	const width = v6 ? 128n : 32n
	const shift = width - BigInt(range.bits)
	return value >> shift === range.base >> shift
}

/** Whether a TCP peer is a proxy whose forwarding headers can be believed. */
export function isTrustedProxyAddress(address: string): boolean {
	const v4 = parseIpv4(address)
	if (v4 !== null) {
		return TRUSTED_RANGES.some((range) => inRange(range, BigInt(v4), false))
	}
	const v6 = parseIpv6(address)
	if (!v6) return false
	const value = ipv6ToBigInt(v6)
	return TRUSTED_RANGES.some((range) => inRange(range, value, true))
}

/** `cf-connecting-ip`, else the last `x-forwarded-for` entry; null when neither is an address. */
function headerAddress(c: Context): string | null {
	const cloudflare = normalizeAddress(c.req.header('cf-connecting-ip'))
	if (cloudflare) return cloudflare
	const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)
	return normalizeAddress(forwarded)
}

/**
 * The TCP peer under `@hono/node-server` (`c.env.incoming`, or
 * `c.env.server.incoming` when nested), the same place its `getConnInfo`
 * reads. Null on the Worker runtime and in tests that call `app.request`.
 */
function socketPeerAddress(c: Context): string | null {
	const env = (c as { env?: unknown }).env as
		| {
				server?: { incoming?: { socket?: { remoteAddress?: unknown } } }
				incoming?: { socket?: { remoteAddress?: unknown } }
		  }
		| undefined
	const bindings = env?.server ?? env
	const remote = bindings?.incoming?.socket?.remoteAddress
	return typeof remote === 'string' ? normalizeAddress(remote) : null
}

/**
 * A canonical address, or null when the text is not one: IPv4 as dotted
 * decimal (an IPv4-mapped IPv6 address becomes its IPv4 form, as dual-stack
 * Node sockets report it), IPv6 lower case without a zone.
 */
export function normalizeAddress(
	raw: string | null | undefined,
): string | null {
	const text = raw?.trim()
	if (!text) return null
	const v4 = parseIpv4(text)
	if (v4 !== null) return formatIpv4(v4)
	const v6 = parseIpv6(text)
	if (!v6) return null
	const mapped =
		v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff
	if (mapped) return formatIpv4((v6[6]! << 16) + v6[7]!)
	return formatIpv6(v6)
}

function parseIpv4(text: string): number | null {
	const parts = text.split('.')
	if (parts.length !== 4) return null
	let value = 0
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const octet = Number(part)
		if (octet > 255) return null
		value = value * 256 + octet
	}
	return value
}

function formatIpv4(value: number): string {
	return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

function parseIpv6(text: string): number[] | null {
	let address = text.trim()
	if (address.startsWith('[') && address.endsWith(']')) {
		address = address.slice(1, -1)
	}
	const zone = address.indexOf('%')
	if (zone !== -1) address = address.slice(0, zone)
	if (!address.includes(':')) return null
	// An embedded IPv4 tail (`::ffff:1.2.3.4`) is two groups.
	let tail: number[] = []
	const lastColon = address.lastIndexOf(':')
	const last = address.slice(lastColon + 1)
	if (last.includes('.')) {
		const v4 = parseIpv4(last)
		if (v4 === null) return null
		tail = [Math.floor(v4 / 65536), v4 % 65536]
		address = `${address.slice(0, lastColon + 1)}0:0`
	}
	const halves = address.split('::')
	if (halves.length > 2) return null
	const parse = (part: string) => (part === '' ? [] : part.split(':'))
	const head = parse(halves[0] ?? '')
	const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
	let groupsText = head
	if (halves.length === 2) {
		// `::` stands for at least one group of zeros.
		const zeros = 8 - head.length - rest.length
		if (zeros < 1) return null
		groupsText = [...head, ...Array<string>(zeros).fill('0'), ...rest]
	}
	if (groupsText.length !== 8) return null
	const groups: number[] = []
	for (const group of groupsText) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
		groups.push(Number.parseInt(group, 16))
	}
	if (tail.length === 2) {
		groups[6] = tail[0]!
		groups[7] = tail[1]!
	}
	return groups
}

function ipv6ToBigInt(groups: number[]): bigint {
	return groups.reduce((value, group) => (value << 16n) + BigInt(group), 0n)
}

function formatIpv6(groups: number[]): string {
	return groups.map((group) => group.toString(16)).join(':')
}
