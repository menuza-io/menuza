import { describe, it, expect } from 'vitest'
import { getClientIp } from './ip-address.server.js'

describe('getClientIp', () => {
	describe('Web API Request (Remix)', () => {
		it('should extract IP from CF-Connecting-IP header (highest priority)', () => {
			const request = {
				headers: {
					get: (name: string) => {
						const headers: Record<string, string> = {
							'cf-connecting-ip': '5.6.7.8',
							'x-real-ip': '9.10.11.12',
							'x-forwarded-for': '13.14.15.16',
						}
						return headers[name.toLowerCase()] || null
					},
				},
			}

			expect(getClientIp(request)).toBe('5.6.7.8')
		})

		it('should extract IP from X-Real-IP header when CF-Connecting-IP is not present', () => {
			const request = {
				headers: {
					get: (name: string) => {
						const headers: Record<string, string> = {
							'x-real-ip': '9.10.11.12',
							'x-forwarded-for': '13.14.15.16',
						}
						return headers[name.toLowerCase()] || null
					},
				},
			}

			expect(getClientIp(request)).toBe('9.10.11.12')
		})

		it('should parse X-Forwarded-For right-to-left based on trustedProxyCount to prevent client spoofing', () => {
			const request = {
				headers: {
					get: (name: string) => {
						if (name.toLowerCase() === 'x-forwarded-for') {
							// Spoofed-Client, Reverse-Proxy-1, Reverse-Proxy-2
							return 'spoofed-1.1.1.1, real-2.2.2.2, proxy-3.3.3.3'
						}
						return null
					},
				},
			}

			// With trustedProxyCount = 1 (default), strips 1 proxy from right -> real-2.2.2.2
			expect(getClientIp(request, { trustedProxyCount: 1 })).toBe(
				'real-2.2.2.2',
			)
			// With trustedProxyCount = 2, strips 2 proxies from right -> spoofed-1.1.1.1
			expect(getClientIp(request, { trustedProxyCount: 2 })).toBe(
				'spoofed-1.1.1.1',
			)
		})

		it('should return default fallback when no IP headers are present', () => {
			const request = {
				headers: {
					get: () => null,
				},
			}

			expect(getClientIp(request)).toBe('127.0.0.1')
		})

		it('should return custom fallback when specified', () => {
			const request = {
				headers: {
					get: () => null,
				},
			}

			expect(getClientIp(request, { fallback: '127.0.0.1' })).toBe('127.0.0.1')
		})

		it('should return undefined when returnUndefined option is true and no IP found', () => {
			const request = {
				headers: {
					get: () => null,
				},
			}

			expect(getClientIp(request, { returnUndefined: true })).toBeUndefined()
		})
	})

	describe('Express-style Request', () => {
		it('should extract IP from CF-Connecting-IP header using .get() method', () => {
			const request = {
				get: (name: string) => {
					const headers: Record<string, string> = {
						'cf-connecting-ip': '5.6.7.8',
					}
					return headers[name.toLowerCase()]
				},
			}

			expect(getClientIp(request)).toBe('5.6.7.8')
		})

		it('should extract IP from X-Forwarded-For using .get() method', () => {
			const request = {
				get: (name: string) => {
					if (name.toLowerCase() === 'x-forwarded-for') {
						return '13.14.15.16, 17.18.19.20'
					}
					return undefined
				},
			}

			expect(getClientIp(request)).toBe('13.14.15.16')
		})

		it('trusts CF-Connecting-IP on Workers even when proxy headers are off', () => {
			const previous = globalThis.caches
			Object.defineProperty(globalThis, 'caches', {
				configurable: true,
				value: { default: {} },
			})
			try {
				const request = {
					headers: {
						get: (name: string) =>
							name.toLowerCase() === 'cf-connecting-ip' ? '203.0.113.8' : null,
					},
					ip: '127.0.0.1',
				}
				expect(getClientIp(request, { trustProxy: false })).toBe('203.0.113.8')
			} finally {
				Object.defineProperty(globalThis, 'caches', {
					configurable: true,
					value: previous,
				})
			}
		})

		it('should use request.ip as fallback for Express requests', () => {
			const request = {
				get: () => undefined,
				ip: '25.26.27.28',
			}

			expect(getClientIp(request)).toBe('25.26.27.28')
		})
	})
})
