import { db, eq, Session } from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestUser,
	enableTwoFactor,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action, loader } from './login.tsx'

describe('login route integration', () => {
	describe('loader', () => {
		it('allows access to anonymous users and returns empty org/sso info', async () => {
			const request = new Request('http://localhost:3000/login')
			const result = (await loader({
				request,
				params: {},
				context: {},
			} as any)) as any

			expect(result.organization).toBeNull()
			expect(result.ssoConfig).toBeNull()
		})

		it('redirects authenticated users away from login page', async () => {
			const user = await createTestUser()
			const { createTestSession } = await import('#tests/test-utils.ts')
			const { cookie } = await createTestSession(user.id)

			const request = createAuthenticatedRequest(
				'http://localhost:3000/login',
				{},
				cookie,
			)

			try {
				await loader({
					request,
					params: {},
					context: {},
				} as any)
				expect.fail('Expected loader to redirect authenticated user')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(302)
				expect(error.headers.get('Location')).toBe('/')
			}
		})

		it('loads organization when valid ?org= query parameter is provided', async () => {
			const user = await createTestUser()
			const org = await createTestOrganization(user.id)

			const request = new Request(`http://localhost:3000/login?org=${org.slug}`)
			const result = (await loader({
				request,
				params: {},
				context: {},
			} as any)) as any

			expect(result.organization).toBeDefined()
			expect(result.organization?.id).toBe(org.id)
			expect(result.organization?.slug).toBe(org.slug)
		})
	})

	describe('action', () => {
		it('returns 400 when submitting empty form', async () => {
			const formData = new FormData()

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = await action({
				request,
				params: {},
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(400)
		})

		it('returns 400 on incorrect password', async () => {
			const user = await createTestUser({ password: 'CorrectPassword123!' })

			const formData = new FormData()
			formData.append('username', user.username)
			formData.append('password', 'WrongPassword456!')

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = await action({
				request,
				params: {},
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(400)
			const responseData = (response as any).data
			expect(responseData?.result?.error?.['']).toBeDefined()
		})

		it('logs in successfully with username, sets session cookie, and redirects', async () => {
			const password = 'ValidPassword123!'
			const user = await createTestUser({ password })

			const formData = new FormData()
			formData.append('username', user.username)
			formData.append('password', password)

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe('/')

			const setCookie = response.headers.get('set-cookie')
			expect(setCookie).toBeDefined()
			expect(setCookie).toContain('_session=')

			// Verify a session was actually created in the database
			const [session] = await db
				.select()
				.from(Session)
				.where(eq(Session.userId, user.id))
				.limit(1)

			expect(session).toBeDefined()
			expect(session?.userId).toBe(user.id)
		})

		it('logs in successfully with email', async () => {
			const password = 'EmailValidPassword123!'
			const user = await createTestUser({ password })

			const formData = new FormData()
			formData.append('username', user.email)
			formData.append('password', password)

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe('/')
			expect(response.headers.get('set-cookie')).toContain('_session=')
		})

		it('logs in when the username or email is typed in a different case', async () => {
			const password = 'CaseValidPassword123!'
			const user = await createTestUser({
				password,
				username: `kody_${Math.random().toString(36).slice(2, 8)}`,
			})
			for (const identifier of [
				` ${user.username.toUpperCase()} `,
				user.email.toUpperCase(),
			]) {
				const formData = new FormData()
				formData.append('username', identifier)
				formData.append('password', password)
				const response = (await action({
					request: new Request('http://localhost:3000/login', {
						method: 'POST',
						body: formData,
					}),
					params: {},
					context: {},
				} as any)) as Response
				expect(response.status).toBe(302)
				expect(response.headers.get('set-cookie')).toContain('_session=')
			}
		})

		it('supports redirectTo parameter', async () => {
			const password = 'RedirectPassword123!'
			const user = await createTestUser({ password })

			const formData = new FormData()
			formData.append('username', user.username)
			formData.append('password', password)
			formData.append('redirectTo', '/settings/profile')

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe('/settings/profile')
		})

		it('creates 30-day session when remember is true', async () => {
			const password = 'RememberPassword123!'
			const user = await createTestUser({ password })

			const formData = new FormData()
			formData.append('username', user.username)
			formData.append('password', password)
			formData.append('remember', 'on')

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)

			// Check DB session expiration date is ~30 days
			const [session] = await db
				.select()
				.from(Session)
				.where(eq(Session.userId, user.id))
				.limit(1)

			expect(session).toBeDefined()
			const diffDays =
				(session!.expirationDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
			expect(diffDays).toBeGreaterThan(28)
			expect(diffDays).toBeLessThanOrEqual(31)
		})

		it('handles 2FA transition when user has two-factor authentication enabled', async () => {
			const password = 'TwoFactorPass123!'
			const user = await createTestUser({ password })

			// Enable 2FA for this user via test helper
			await enableTwoFactor(user.id)

			const formData = new FormData()
			formData.append('username', user.username)
			formData.append('password', password)

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			const location = response.headers.get('Location')
			expect(location).toBeDefined()
			expect(location).toContain('/verify')
			expect(location).toContain('type=2fa')

			// Should set unverified session cookie, not regular session cookie
			const setCookie = response.headers.get('set-cookie')
			expect(setCookie).toBeDefined()
			expect(setCookie).toContain('en_verification=')
		})

		it('handles check-email intent for SSO discovery', async () => {
			const formData = new FormData()
			formData.append('intent', 'check-email')
			formData.append('username', 'test@standard-non-sso-domain.com')

			const request = new Request('http://localhost:3000/login', {
				method: 'POST',
				body: formData,
			})

			const response = await action({
				request,
				params: {},
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(200)
			const data = (response as any).data
			expect(data.ssoAvailable).toBe(false)
			expect(data.username).toBe('test@standard-non-sso-domain.com')
		})
	})
})
