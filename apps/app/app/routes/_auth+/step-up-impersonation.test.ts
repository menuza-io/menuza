import { getClientIp, hashIp, impersonationSessionStorage } from '@repo/auth'
import { db, ImpersonationSession, Verification } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { requireRecentVerification } from './verify.server.tsx'

// Impersonation is applied by host in production; make it apply here.
vi.mock('@repo/common/cookie-domain', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	shouldApplyImpersonationToUserId: () => true,
}))

async function withTwoFactor(userId: string) {
	await db.insert(Verification).values({
		type: '2fa',
		target: userId,
		secret: 'JBSWY3DPEHPK3PXP',
		algorithm: 'SHA-1',
		digits: 6,
		period: 30,
		charSet: '0123456789',
	})
}

describe('step-up while an admin impersonates a user', () => {
	it('asks the admin to verify as themselves, not as the impersonated user', async () => {
		const admin = await createTestUser()
		const target = await createTestUser()
		await withTwoFactor(admin.id)
		await withTwoFactor(target.id)
		const { cookie } = await createTestSession(admin.id)

		const probe = createAuthenticatedRequest(
			'http://localhost:3000/settings',
			{},
			cookie,
		)
		const [impersonation] = await db
			.insert(ImpersonationSession)
			.values({
				adminUserId: admin.id,
				targetUserId: target.id,
				ipHash: hashIp(getClientIp(probe)),
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			})
			.returning({ id: ImpersonationSession.id })
		const impersonationCookie = (
			await impersonationSessionStorage.commitSession(
				await impersonationSessionStorage.getSession().then((session) => {
					session.set('impersonationSessionId', impersonation!.id)
					return session
				}),
			)
		).split(';')[0]

		const request = createAuthenticatedRequest(
			'http://localhost:3000/settings',
			{},
			`${cookie}; ${impersonationCookie}`,
		)
		let thrown: Response | undefined
		try {
			await requireRecentVerification(request)
		} catch (error) {
			thrown = error as Response
		}

		expect(thrown?.status).toBe(302)
		const location = new URL(thrown!.headers.get('Location')!, 'http://x')
		expect(location.pathname).toBe('/verify')
		expect(location.searchParams.get('target')).toBe(admin.id)
	})
})
