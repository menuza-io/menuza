import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	isPrivateIp,
	ssrfSafeFetch,
	validateInstanceUrl,
	validateInstanceUrlWithDns,
} from './ssrf.js'

// Mock dns module
vi.mock('node:dns', () => {
	const resolve4 = vi.fn()
	const resolve6 = vi.fn()
	return {
		default: {
			promises: { resolve4, resolve6 },
		},
		promises: { resolve4, resolve6 },
	}
})

let mockResolve4: ReturnType<typeof vi.fn>
let mockResolve6: ReturnType<typeof vi.fn>

beforeEach(async () => {
	vi.clearAllMocks()
	const dns = await import('node:dns')
	mockResolve4 = dns.default.promises.resolve4 as ReturnType<typeof vi.fn>
	mockResolve6 = dns.default.promises.resolve6 as ReturnType<typeof vi.fn>
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('isPrivateIp', () => {
	it('identifies loopback addresses', () => {
		expect(isPrivateIp('127.0.0.1')).toBe(true)
		expect(isPrivateIp('127.255.255.255')).toBe(true)
		expect(isPrivateIp('::1')).toBe(true)
	})

	it('identifies RFC 1918 private ranges', () => {
		expect(isPrivateIp('10.0.0.1')).toBe(true)
		expect(isPrivateIp('10.255.255.255')).toBe(true)
		expect(isPrivateIp('172.16.0.1')).toBe(true)
		expect(isPrivateIp('172.31.255.255')).toBe(true)
		expect(isPrivateIp('192.168.0.1')).toBe(true)
		expect(isPrivateIp('192.168.255.255')).toBe(true)
	})

	it('identifies link-local and cloud metadata range', () => {
		expect(isPrivateIp('169.254.169.254')).toBe(true)
		expect(isPrivateIp('169.254.0.1')).toBe(true)
	})

	it('identifies CGNAT range (100.64.0.0/10)', () => {
		expect(isPrivateIp('100.64.0.1')).toBe(true)
		expect(isPrivateIp('100.127.255.255')).toBe(true)
	})

	it('identifies 0.0.0.0/8', () => {
		expect(isPrivateIp('0.0.0.0')).toBe(true)
		expect(isPrivateIp('0.255.255.255')).toBe(true)
	})

	it('identifies reserved range (240+)', () => {
		expect(isPrivateIp('240.0.0.1')).toBe(true)
		expect(isPrivateIp('255.255.255.255')).toBe(true)
	})

	it('allows public IPv4 addresses', () => {
		expect(isPrivateIp('8.8.8.8')).toBe(false)
		expect(isPrivateIp('1.1.1.1')).toBe(false)
		expect(isPrivateIp('142.250.80.46')).toBe(false)
		expect(isPrivateIp('172.15.255.255')).toBe(false) // just outside 172.16/12
		expect(isPrivateIp('172.32.0.0')).toBe(false) // just outside 172.16/12
		expect(isPrivateIp('100.63.255.255')).toBe(false) // just outside CGNAT
	})

	it('identifies IPv6 unique-local and link-local', () => {
		expect(isPrivateIp('fd12:3456:789a::1')).toBe(true)
		expect(isPrivateIp('fe80::1')).toBe(true)
		expect(isPrivateIp('fc00::1')).toBe(true)
	})

	it('allows public IPv6 addresses', () => {
		expect(isPrivateIp('2001:4860:4860::8888')).toBe(false)
		expect(isPrivateIp('2606:4700:4700::1111')).toBe(false)
	})

	it('identifies IPv4-mapped IPv6 private addresses', () => {
		expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)
		expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true)
		expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true)
		expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true)
	})
})

describe('validateInstanceUrl (textual)', () => {
	it('rejects non-HTTPS URLs', () => {
		expect(validateInstanceUrl('http://gitlab.example.com').valid).toBe(false)
		expect(validateInstanceUrl('ftp://gitlab.example.com').valid).toBe(false)
	})

	it('rejects URLs with credentials', () => {
		expect(
			validateInstanceUrl('https://user:pass@gitlab.example.com').valid,
		).toBe(false)
	})

	it('rejects localhost and internal hostnames', () => {
		expect(validateInstanceUrl('https://localhost').valid).toBe(false)
		expect(validateInstanceUrl('https://myhost.local').valid).toBe(false)
		expect(validateInstanceUrl('https://myhost.internal').valid).toBe(false)
	})

	it('rejects private IPv4 literals', () => {
		expect(validateInstanceUrl('https://127.0.0.1').valid).toBe(false)
		expect(validateInstanceUrl('https://10.0.0.1').valid).toBe(false)
		expect(validateInstanceUrl('https://192.168.1.1').valid).toBe(false)
		expect(validateInstanceUrl('https://169.254.169.254').valid).toBe(false)
	})

	it('accepts valid public HTTPS URLs', () => {
		expect(validateInstanceUrl('https://gitlab.example.com').valid).toBe(true)
		expect(validateInstanceUrl('https://gitlab.com').valid).toBe(true)
	})

	it('does NOT catch DNS rebinding (textual only)', () => {
		// localtest.me resolves to 127.0.0.1 but passes textual checks
		expect(validateInstanceUrl('https://localtest.me').valid).toBe(true)
	})
})

describe('validateInstanceUrlWithDns', () => {
	it('catches DNS rebinding to loopback', async () => {
		mockResolve4.mockResolvedValue(['127.0.0.1'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		const result = await validateInstanceUrlWithDns('https://localtest.me')
		expect(result.valid).toBe(false)
		expect(result.reason).toContain('private/internal IP')
		expect(result.reason).toContain('127.0.0.1')
	})

	it('catches DNS rebinding to cloud metadata', async () => {
		mockResolve4.mockResolvedValue(['169.254.169.254'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		const result = await validateInstanceUrlWithDns('https://metadata.evil.com')
		expect(result.valid).toBe(false)
		expect(result.reason).toContain('169.254.169.254')
	})

	it('catches DNS rebinding to private network', async () => {
		mockResolve4.mockResolvedValue(['10.0.0.5'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		const result = await validateInstanceUrlWithDns('https://internal.evil.com')
		expect(result.valid).toBe(false)
		expect(result.reason).toContain('10.0.0.5')
	})

	it('blocks when ANY resolved IP is private (dual-stack)', async () => {
		mockResolve4.mockResolvedValue(['8.8.8.8'])
		mockResolve6.mockResolvedValue(['::1'])

		const result = await validateInstanceUrlWithDns(
			'https://dualstack.evil.com',
		)
		expect(result.valid).toBe(false)
	})

	it('allows hostname that resolves to public IPs', async () => {
		mockResolve4.mockResolvedValue(['142.250.80.46'])
		mockResolve6.mockResolvedValue(['2607:f8b0:4004:800::200e'])

		const result = await validateInstanceUrlWithDns(
			'https://gitlab.example.com',
		)
		expect(result.valid).toBe(true)
	})

	it('rejects when DNS resolution fails completely', async () => {
		mockResolve4.mockRejectedValue(new Error('NXDOMAIN'))
		mockResolve6.mockRejectedValue(new Error('NXDOMAIN'))

		const result = await validateInstanceUrlWithDns(
			'https://nonexistent.example.com',
		)
		expect(result.valid).toBe(false)
		expect(result.reason).toContain('DNS resolution failed')
	})

	it('still rejects textually invalid URLs without DNS lookup', async () => {
		const result = await validateInstanceUrlWithDns('http://gitlab.com')
		expect(result.valid).toBe(false)
		expect(result.reason).toContain('HTTPS')
		// DNS should not have been called
		expect(mockResolve4).not.toHaveBeenCalled()
	})
})

describe('ssrfSafeFetch', () => {
	it('throws on DNS rebinding to loopback', async () => {
		mockResolve4.mockResolvedValue(['127.0.0.1'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		await expect(
			ssrfSafeFetch('https://localtest.me/api/v4/user'),
		).rejects.toThrow('SSRF security validation failed')
	})

	it('calls fetch with redirect: manual for safe URLs', async () => {
		mockResolve4.mockResolvedValue(['142.250.80.46'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		const mockResponse = new Response(JSON.stringify({ id: 1 }), {
			status: 200,
		})
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(mockResponse)

		const response = await ssrfSafeFetch(
			'https://gitlab.example.com/api/v4/user',
			{
				headers: { Authorization: 'Bearer token' },
			},
		)

		expect(response).toBe(mockResponse)
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://gitlab.example.com/api/v4/user',
			expect.objectContaining({
				redirect: 'manual',
				headers: { Authorization: 'Bearer token' },
			}),
		)

		fetchSpy.mockRestore()
	})

	it('refuses a redirect response instead of returning it', async () => {
		mockResolve4.mockResolvedValue(['142.250.80.46'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(null, {
				status: 302,
				headers: { Location: 'http://169.254.169.254/latest/meta-data' },
			}),
		)

		await expect(
			ssrfSafeFetch('https://gitlab.example.com/api/v4/user'),
		).rejects.toThrow('redirect blocked')

		fetchSpy.mockRestore()
	})

	it('cancels the body of a refused redirect response', async () => {
		mockResolve4.mockResolvedValue(['142.250.80.46'])
		mockResolve6.mockRejectedValue(new Error('no AAAA'))

		let cancelled = false
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true
					},
				}),
				{ status: 302, headers: { Location: 'http://169.254.169.254/' } },
			),
		)

		await expect(
			ssrfSafeFetch('https://gitlab.example.com/api/v4/user'),
		).rejects.toThrow('redirect blocked')
		expect(cancelled).toBe(true)

		fetchSpy.mockRestore()
	})
})

describe('isPrivateIp IPv6 forms', () => {
	it.each([
		'::ffff:a9fe:a9fe',
		'::ffff:7f00:1',
		'::ffff:169.254.169.254',
		'[::ffff:a00:1]',
		'64:ff9b::a9fe:a9fe',
		'2002:a9fe:a9fe::1',
		'::7f00:1',
		'0:0:0:0:0:0:0:1',
		'fe80::1',
		'fc00::1',
		'ff02::1',
		'198.18.0.1',
		'192.88.99.1',
		'64:ff9b:1::1',
		'192.0.0.8',
		'not-an-ip',
	])('blocks %s', (ip) => {
		expect(isPrivateIp(ip)).toBe(true)
	})

	it.each(['8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808', '1.1.1.1'])(
		'allows %s',
		(ip) => {
			expect(isPrivateIp(ip)).toBe(false)
		},
	)
})
