import { verifySessionStorage } from '@repo/auth'
import {
	ApiKey,
	db,
	eq,
	MCPAuthorization,
	Organization,
	Password,
	RefreshToken,
	Session,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { convertSetCookieToCookie } from '#tests/utils.ts'
import {
	action,
	loader,
	resetPasswordUsernameSessionKey,
} from './reset-password.tsx'

async function createResetPasswordCookie(username: string) {
	const verifySession = await verifySessionStorage.getSession()
	verifySession.set(resetPasswordUsernameSessionKey, username)
	const cookieHeader = await verifySessionStorage.commitSession(verifySession)
	return convertSetCookieToCookie(cookieHeader)
}

describe('reset-password route integration', () => {
	describe('loader', () => {
		it('redirects to /login if verify session is missing', async () => {
			const request = new Request('http://localhost:3000/reset-password')

			try {
				await loader({
					request,
					params: {},
					context: {},
				} as any)
				expect.fail('Expected loader to redirect to login')
			} catch (error: any) {
				expect(error).toBeInstanceOf(Response)
				expect(error.status).toBe(302)
				expect(error.headers.get('Location')).toBe('/login')
			}
		})

		it('returns resetPasswordUsername when valid verify session cookie is present', async () => {
			const user = await createTestUser()
			const cookie = await createResetPasswordCookie(user.username)

			const request = createAuthenticatedRequest(
				'http://localhost:3000/reset-password',
				{},
				cookie,
			)

			const result = await loader({
				request,
				params: {},
				context: {},
			} as any)

			expect(result.resetPasswordUsername).toBe(user.username)
		})
	})

	describe('action', () => {
		it('returns 400 when password and confirmPassword do not match', async () => {
			const user = await createTestUser()
			const cookie = await createResetPasswordCookie(user.username)

			const formData = new FormData()
			formData.append('password', 'NewValidPassword123!')
			formData.append('confirmPassword', 'DifferentPassword456!')

			const request = createAuthenticatedRequest(
				'http://localhost:3000/reset-password',
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = await action({
				request,
				params: {},
				context: {},
			} as any)

			expect(getResponseStatus(response)).toBe(400)
		})

		it('also revokes refresh tokens, MCP authorizations and API keys', async () => {
			const user = await createTestUser({ password: 'OldPassword123!' })
			const orgId = `org-${user.id}`
			await db
				.insert(Organization)
				.values({ id: orgId, name: 'Reset Org', slug: orgId })
			await db.insert(RefreshToken).values({
				tokenHash: `rt-${user.id}`,
				userId: user.id,
				expiresAt: new Date(Date.now() + 86_400_000),
			})
			const [mcp] = await db
				.insert(MCPAuthorization)
				.values({
					userId: user.id,
					organizationId: orgId,
					clientName: 'c',
					clientId: `client-${user.id}`,
				})
				.returning()
			const [key] = await db
				.insert(ApiKey)
				.values({
					keyHash: `kh-${user.id}`,
					keyPrefix: 'pre',
					name: 'k',
					userId: user.id,
					organizationId: orgId,
				})
				.returning()

			const cookie = await createResetPasswordCookie(user.username)
			const formData = new FormData()
			formData.append('password', 'NewSecretPassword123!')
			formData.append('confirmPassword', 'NewSecretPassword123!')
			await action({
				request: createAuthenticatedRequest(
					'http://localhost:3000/reset-password',
					{ method: 'POST', body: formData },
					cookie,
				),
				params: {},
				context: {},
			} as any)

			const [rt] = await db
				.select()
				.from(RefreshToken)
				.where(eq(RefreshToken.userId, user.id))
			expect(rt?.revoked).toBe(true)
			const [mcpAfter] = await db
				.select()
				.from(MCPAuthorization)
				.where(eq(MCPAuthorization.id, mcp!.id))
			expect(mcpAfter?.isActive).toBe(false)
			// Expired (kept for audit), not deleted.
			const [keyAfter] = await db
				.select()
				.from(ApiKey)
				.where(eq(ApiKey.id, key!.id))
			expect(keyAfter?.expiresAt).toBeInstanceOf(Date)
			expect(keyAfter!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
		})

		it('successfully resets password, purges active sessions, and redirects to /login', async () => {
			const user = await createTestUser({ password: 'OldPassword123!' })
			// Create an active session for the user
			const { session } = await createTestSession(user.id)

			// Verify session exists before reset
			const [sessionBefore] = await db
				.select()
				.from(Session)
				.where(eq(Session.id, session.id))
				.limit(1)
			expect(sessionBefore).toBeDefined()

			const cookie = await createResetPasswordCookie(user.username)
			const newPassword = 'NewSecretPassword123!'

			const formData = new FormData()
			formData.append('password', newPassword)
			formData.append('confirmPassword', newPassword)

			const request = createAuthenticatedRequest(
				'http://localhost:3000/reset-password',
				{ method: 'POST', body: formData },
				cookie,
			)

			const response = (await action({
				request,
				params: {},
				context: {},
			} as any)) as Response

			expect(response.status).toBe(302)
			expect(response.headers.get('Location')).toBe('/login')

			// Verify existing sessions were wiped from database
			const [sessionAfter] = await db
				.select()
				.from(Session)
				.where(eq(Session.id, session.id))
				.limit(1)
			expect(sessionAfter).toBeUndefined()

			// Verify password hash in Password table was updated
			const [passwordRow] = await db
				.select()
				.from(Password)
				.where(eq(Password.userId, user.id))
				.limit(1)
			expect(passwordRow?.hash).toBeDefined()

			// Verify user can now log in with the new password
			const { login } = await import('#app/utils/auth.server.ts')
			const newLoginSession = await login({
				username: user.username,
				password: newPassword,
			})
			expect(newLoginSession).toBeDefined()
			expect(newLoginSession?.userId).toBe(user.id)
		})
	})
})
