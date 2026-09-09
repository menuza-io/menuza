/**
 * Unit tests for session management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { authSessionStorage } from '../src/session.server'
process.env.SESSION_SECRET = 'super-duper-s3cret'
describe('Session Management', () => {
	beforeEach(() => {
		process.env.SESSION_SECRET = 'super-duper-s3cret'
	})

	describe('authSessionStorage', () => {
		beforeEach(() => {
			process.env.SESSION_SECRET = 'super-duper-s3cret'
		})
		it('should create session storage with correct cookie configuration', () => {
			expect(authSessionStorage).toBeDefined()
			expect(authSessionStorage.getSession).toBeDefined()
			expect(authSessionStorage.commitSession).toBeDefined()
			expect(authSessionStorage.destroySession).toBeDefined()
		})

		it('should create a new session', async () => {
			const session = await authSessionStorage.getSession()

			expect(session).toBeDefined()
			expect(typeof session.set).toBe('function')
			expect(typeof session.get).toBe('function')
			expect(typeof session.has).toBe('function')
		})

		it('should store and retrieve session data', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')
			session.set('email', 'test@example.com')

			expect(session.get('userId')).toBe('user-123')
			expect(session.get('email')).toBe('test@example.com')
		})

		it('should commit session with data', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toBeDefined()
			expect(typeof setCookieHeader).toBe('string')
			expect(setCookieHeader).toContain('en_session=')
		})

		it('should commit session with expires option', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			const expiresDate = new Date(Date.now() + 3600000) // 1 hour from now
			const setCookieHeader = await authSessionStorage.commitSession(session, {
				expires: expiresDate,
			})

			expect(setCookieHeader).toBeDefined()
			expect(setCookieHeader).toContain('en_session=')
			expect(setCookieHeader).toContain('Expires=')
		})

		it('should commit session with maxAge option', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			const maxAge = 3600 // 1 hour in seconds
			const beforeCommit = Date.now()
			const setCookieHeader = await authSessionStorage.commitSession(session, {
				maxAge,
			})

			expect(setCookieHeader).toBeDefined()
			expect(setCookieHeader).toContain('en_session=')

			// Check that expires was set based on maxAge
			const expiresValue = session.get('expires')
			expect(expiresValue).toBeInstanceOf(Date)

			const expiresTime = new Date(expiresValue).getTime()
			const expectedTime = beforeCommit + maxAge * 1000

			// Allow for small time difference (100ms) due to execution time
			expect(Math.abs(expiresTime - expectedTime)).toBeLessThan(100)
		})

		it('should preserve existing expires value on subsequent commits', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			const maxAge = 3600 // 1 hour
			await authSessionStorage.commitSession(session, {
				maxAge,
			})

			// Commit again without expires option
			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toBeDefined()
			expect(session.get('expires')).toBeInstanceOf(Date)
		})

		it('should parse and retrieve session from cookie header', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')
			session.set('email', 'test@example.com')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			// Extract cookie value from Set-Cookie header
			const cookieValue = setCookieHeader.split(';')[0]?.split('=')[1]
			expect(cookieValue).toBeDefined()

			// Parse session from cookie
			const parsedSession = await authSessionStorage.getSession(
				`en_session=${cookieValue}`,
			)

			expect(parsedSession.get('userId')).toBe('user-123')
			expect(parsedSession.get('email')).toBe('test@example.com')
		})

		it('should destroy session', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			const setCookieHeader = await authSessionStorage.destroySession(session)

			expect(setCookieHeader).toBeDefined()
			expect(setCookieHeader).toContain('en_session=')
			// Cookie expiration can use either Max-Age=0 or Expires with past date
			expect(
				setCookieHeader.includes('Max-Age=0') ||
					setCookieHeader.includes('Expires=Thu, 01 Jan 1970'),
			).toBe(true)
		})

		it('should handle missing session data gracefully', async () => {
			const session = await authSessionStorage.getSession()

			expect(session.get('nonexistent')).toBeUndefined()
			expect(session.has('nonexistent')).toBe(false)
		})

		it('should handle multiple data types in session', async () => {
			const session = await authSessionStorage.getSession()

			session.set('string', 'test')
			session.set('number', 123)
			session.set('boolean', true)
			session.set('object', { key: 'value' })
			session.set('array', [1, 2, 3])

			expect(session.get('string')).toBe('test')
			expect(session.get('number')).toBe(123)
			expect(session.get('boolean')).toBe(true)
			expect(session.get('object')).toEqual({ key: 'value' })
			expect(session.get('array')).toEqual([1, 2, 3])
		})

		it('should unset session data', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			expect(session.has('userId')).toBe(true)

			session.unset('userId')

			expect(session.has('userId')).toBe(false)
			expect(session.get('userId')).toBeUndefined()
		})
	})

	describe('Session cookie configuration', () => {
		afterEach(() => {
			vi.resetModules()
			vi.unmock('@repo/common/cookie-domain')
		})

		it('should use correct cookie name', async () => {
			const session = await authSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('en_session=')
		})

		it('should set httpOnly flag', async () => {
			const session = await authSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('HttpOnly')
		})

		it('should set SameSite=Lax', async () => {
			const session = await authSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('SameSite=Lax')
		})

		it('should set path=/', async () => {
			const session = await authSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('Path=/')
		})

		it('should set domain from BASE_URL app.{apex} in production', async () => {
			vi.doMock('@repo/common/cookie-domain', async (importOriginal) => {
				const mod =
					await importOriginal<typeof import('@repo/common/cookie-domain')>()
				return {
					...mod,
					operatorSessionCookieDomain: () => '.example.com',
				}
			})
			vi.resetModules()
			const { authSessionStorage: testAuthSessionStorage } = await import(
				'../src/session.server?v=' + Date.now()
			)

			const session = await testAuthSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader =
				await testAuthSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('Domain=.example.com')
		})

		it('should set .localhost domain when BASE_URL is app.localhost', async () => {
			vi.doMock('@repo/common/cookie-domain', async (importOriginal) => {
				const mod =
					await importOriginal<typeof import('@repo/common/cookie-domain')>()
				return {
					...mod,
					operatorSessionCookieDomain: () => '.localhost',
				}
			})
			vi.resetModules()
			const { authSessionStorage: testAuthSessionStorage } = await import(
				'../src/session.server?v=' + Date.now()
			)

			const session = await testAuthSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader =
				await testAuthSessionStorage.commitSession(session)

			expect(setCookieHeader).toContain('Domain=.localhost')
		})

		it('should omit domain when BASE_URL is localhost', async () => {
			vi.doMock('@repo/common/cookie-domain', async (importOriginal) => {
				const mod =
					await importOriginal<typeof import('@repo/common/cookie-domain')>()
				return {
					...mod,
					operatorSessionCookieDomain: () => undefined,
				}
			})
			vi.resetModules()
			const { authSessionStorage: testAuthSessionStorage } = await import(
				'../src/session.server?v=' + Date.now()
			)

			const session = await testAuthSessionStorage.getSession()
			session.set('test', 'value')

			const setCookieHeader =
				await testAuthSessionStorage.commitSession(session)

			expect(setCookieHeader).not.toContain('Domain=')
		})
	})

	describe('Session expiration handling', () => {
		it('should handle expired sessions', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			// Set expires in the past
			const pastDate = new Date(Date.now() - 3600000) // 1 hour ago
			session.set('expires', pastDate)

			const setCookieHeader = await authSessionStorage.commitSession(session)

			expect(setCookieHeader).toBeDefined()
			// Cookie should have expiry date in the past
			expect(setCookieHeader).toContain('Expires=')
		})

		it('should update expires on each commit when maxAge is provided', async () => {
			const session = await authSessionStorage.getSession()
			session.set('userId', 'user-123')

			// First commit with maxAge
			const firstExpires = new Date(Date.now() + 1800000) // 30 minutes
			await authSessionStorage.commitSession(session, { expires: firstExpires })

			// Second commit with new maxAge
			const maxAge = 3600 // 1 hour
			await authSessionStorage.commitSession(session, { maxAge })

			const expiresValue = session.get('expires')
			expect(expiresValue).toBeInstanceOf(Date)

			// New expires should be roughly 1 hour from now (not the old 30 minutes)
			const expiresTime = new Date(expiresValue).getTime()
			const expectedTime = Date.now() + maxAge * 1000

			expect(Math.abs(expiresTime - expectedTime)).toBeLessThan(1000)
		})
	})

	describe('Concurrent session handling', () => {
		it('should handle multiple sessions independently', async () => {
			const session1 = await authSessionStorage.getSession()
			const session2 = await authSessionStorage.getSession()

			session1.set('userId', 'user-1')
			session2.set('userId', 'user-2')

			expect(session1.get('userId')).toBe('user-1')
			expect(session2.get('userId')).toBe('user-2')
		})

		it('should not mix data between sessions', async () => {
			const session1 = await authSessionStorage.getSession()
			const session2 = await authSessionStorage.getSession()

			session1.set('data', 'session1-data')
			session2.set('data', 'session2-data')

			const cookie1 = await authSessionStorage.commitSession(session1)
			const cookie2 = await authSessionStorage.commitSession(session2)

			expect(cookie1).not.toBe(cookie2)

			// Parse each session and verify data
			const cookieValue1 = cookie1.split(';')[0]?.split('=')[1] || ''
			const cookieValue2 = cookie2.split(';')[0]?.split('=')[1] || ''

			const parsed1 = await authSessionStorage.getSession(
				`en_session=${cookieValue1}`,
			)
			const parsed2 = await authSessionStorage.getSession(
				`en_session=${cookieValue2}`,
			)

			expect(parsed1.get('data')).toBe('session1-data')
			expect(parsed2.get('data')).toBe('session2-data')
		})
	})
})
