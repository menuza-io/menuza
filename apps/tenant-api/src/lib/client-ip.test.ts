import { type Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
	addressBucket,
	clientAddress,
	isTrustedProxyAddress,
	normalizeAddress,
} from './client-ip.ts'

/**
 * A request as the routes see it: headers, and on the Node runtime the TCP
 * peer `@hono/node-server` exposes as `c.env.incoming.socket`.
 */
function context(
	headers: Record<string, string>,
	peer?: string,
	nested = false,
): Context {
	const incoming = peer ? { socket: { remoteAddress: peer } } : undefined
	const lower = Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	)
	return {
		req: { header: (name: string) => lower[name.toLowerCase()] },
		env: incoming ? (nested ? { server: { incoming } } : { incoming }) : {},
	} as unknown as Context
}

describe('clientAddress', () => {
	describe('without a socket (Worker runtime, app.request in tests)', () => {
		it('believes cf-connecting-ip, which Cloudflare sets at the edge', () => {
			expect(
				clientAddress(context({ 'cf-connecting-ip': '203.0.113.9' })),
			).toBe('203.0.113.9')
		})

		it('falls back to the last x-forwarded-for entry, never the first', () => {
			expect(
				clientAddress(
					context({ 'x-forwarded-for': '1.1.1.1, 10.0.0.2, 203.0.113.4' }),
				),
			).toBe('203.0.113.4')
		})

		it('is null when no header holds an address', () => {
			expect(clientAddress(context({}))).toBeNull()
			expect(clientAddress(context({ 'cf-connecting-ip': 'evil' }))).toBeNull()
		})
	})

	describe('on the Node runtime', () => {
		it('ignores a forged cf-connecting-ip from a peer that reached the port directly', () => {
			const forged = context(
				{ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
				'198.51.100.7',
			)
			expect(clientAddress(forged)).toBe('198.51.100.7')
		})

		it('gives every forged header from one peer the same address', () => {
			const addresses = Array.from({ length: 5 }, (_, index) =>
				clientAddress(
					context({ 'cf-connecting-ip': `9.9.9.${index}` }, '198.51.100.7'),
				),
			)
			expect(new Set(addresses)).toEqual(new Set(['198.51.100.7']))
		})

		it('believes the header from the Cloudflare proxy', () => {
			expect(
				clientAddress(
					context({ 'cf-connecting-ip': '203.0.113.5' }, '104.16.1.1'),
				),
			).toBe('203.0.113.5')
			expect(
				clientAddress(
					context({ 'cf-connecting-ip': '203.0.113.5' }, '2606:4700::1111'),
				),
			).toBe('203.0.113.5')
		})

		it('believes the header from a Tunnel or proxy on our own host or network', () => {
			for (const peer of [
				'127.0.0.1',
				'::ffff:127.0.0.1',
				'::1',
				'172.17.0.1',
			]) {
				expect(
					clientAddress(context({ 'cf-connecting-ip': '203.0.113.6' }, peer)),
				).toBe('203.0.113.6')
			}
		})

		it('reads the peer when the node server nests its bindings', () => {
			expect(
				clientAddress(
					context({ 'cf-connecting-ip': '1.2.3.4' }, '198.51.100.8', true),
				),
			).toBe('198.51.100.8')
		})

		it('does not read a socket-less header as trusted when the nested server lacks one', () => {
			// `server` exists without `incoming`; the socket is on `env` itself.
			const c = {
				req: { header: () => '1.2.3.4' },
				env: {
					server: {},
					incoming: { socket: { remoteAddress: '198.51.100.7' } },
				},
			} as unknown as Context
			expect(clientAddress(c)).toBe('198.51.100.7')
		})

		it('uses a trusted peer itself when it sends no header', () => {
			expect(clientAddress(context({}, '127.0.0.1'))).toBe('127.0.0.1')
		})
	})
})

describe('addressBucket', () => {
	it('counts an IPv6 client by its /64, so rotating the host part buys nothing', () => {
		const first = addressBucket(normalizeAddress('2001:db8:1:2:3:4:5:6')!)
		const second = addressBucket(normalizeAddress('2001:db8:1:2:ffff::1')!)
		expect(first).toBe('2001:db8:1:2::/64')
		expect(second).toBe(first)
		expect(addressBucket(normalizeAddress('2001:db8:1:3::1')!)).not.toBe(first)
	})

	it('keeps an IPv4 address as it is', () => {
		expect(addressBucket('203.0.113.9')).toBe('203.0.113.9')
	})
})

describe('isTrustedProxyAddress', () => {
	it('knows the private ranges by their exact edges', () => {
		expect(isTrustedProxyAddress('172.15.255.255')).toBe(false)
		expect(isTrustedProxyAddress('172.16.0.1')).toBe(true)
		expect(isTrustedProxyAddress('172.31.255.255')).toBe(true)
		expect(isTrustedProxyAddress('172.32.0.1')).toBe(false)
	})

	it('trusts Cloudflare edges and nothing else on the internet', () => {
		expect(isTrustedProxyAddress('162.158.1.1')).toBe(true)
		expect(isTrustedProxyAddress('8.8.8.8')).toBe(false)
		expect(isTrustedProxyAddress('2001:db8::1')).toBe(false)
		expect(isTrustedProxyAddress('not an address')).toBe(false)
	})
})

describe('normalizeAddress', () => {
	it('writes IPv4-mapped IPv6 as IPv4 and drops brackets and zones', () => {
		expect(normalizeAddress('::ffff:203.0.113.9')).toBe('203.0.113.9')
		expect(normalizeAddress('[2001:DB8::1]')).toBe('2001:db8:0:0:0:0:0:1')
		expect(normalizeAddress('fe80::1%eth0')).toBe('fe80:0:0:0:0:0:0:1')
	})

	it('refuses IPv4 octets with leading zeros, which some stacks read as octal', () => {
		expect(normalizeAddress('010.0.0.1')).toBeNull()
		expect(normalizeAddress('1.2.3.04')).toBeNull()
		expect(normalizeAddress('10.0.0.1')).toBe('10.0.0.1')
		expect(normalizeAddress('0.0.0.0')).toBe('0.0.0.0')
	})

	it('refuses text that is not an address', () => {
		expect(normalizeAddress('256.1.1.1')).toBeNull()
		expect(normalizeAddress('1.2.3')).toBeNull()
		expect(normalizeAddress('')).toBeNull()
		expect(normalizeAddress(undefined)).toBeNull()
	})
})
