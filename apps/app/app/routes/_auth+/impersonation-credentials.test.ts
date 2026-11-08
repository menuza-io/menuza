import { getClientIp, hashIp, impersonationSessionStorage } from '@repo/auth'
import {
	db,
	eq,
	DataSubjectRequest,
	ImpersonationSession,
	Password,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action as profileAction } from '../_app+/profile.tsx'
import { action as securityAction } from '../_app+/security.tsx'
import { loader as downloadUserDataLoader } from '../resources+/download-user-data.tsx'
import { action as passkeyRegistrationAction } from './webauthn+/registration.ts'

// Impersonation is applied by host in production; make it apply here.
vi.mock('@repo/common/cookie-domain', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	shouldApplyImpersonationToUserId: () => true,
}))

async function impersonate() {
	const admin = await createTestUser()
	const target = await createTestUser()
	const { cookie } = await createTestSession(admin.id)
	const probe = createAuthenticatedRequest('http://localhost:3000/', {}, cookie)
	const [row] = await db
		.insert(ImpersonationSession)
		.values({
			adminUserId: admin.id,
			targetUserId: target.id,
			ipHash: hashIp(getClientIp(probe)),
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: ImpersonationSession.id })
	const session = await impersonationSessionStorage.getSession()
	session.set('impersonationSessionId', row!.id)
	const impersonationCookie = (
		await impersonationSessionStorage.commitSession(session)
	).split(';')[0]
	return { admin, target, cookie: `${cookie}; ${impersonationCookie}` }
}

async function statusOf(run: () => Promise<unknown>) {
	try {
		const result = await run()
		return result instanceof Response ? result.status : 200
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

function form(cookie: string, url: string, fields: Record<string, string>) {
	return createAuthenticatedRequest(
		url,
		{ method: 'POST', body: new URLSearchParams(fields) },
		cookie,
	)
}

describe('an impersonating admin cannot leave credentials on the target or act in their name', () => {
	it('refuses set-password and the other credential intents', async () => {
		const { target, cookie } = await impersonate()
		const passwordOf = async () =>
			(
				await db
					.select({ hash: Password.hash })
					.from(Password)
					.where(eq(Password.userId, target.id))
			).map((row) => row.hash)
		const before = await passwordOf()
		for (const intent of [
			'set-password',
			'change-password',
			'enable-2fa',
			'disable-2fa',
			'generate-backup-codes',
			'disconnect-provider',
		]) {
			const status = await statusOf(() =>
				securityAction({
					request: form(cookie, 'http://localhost:3000/security', {
						intent,
						password: 'A-very-strong-passw0rd!',
						confirmPassword: 'A-very-strong-passw0rd!',
					}),
				} as never),
			)
			expect({ intent, status }).toEqual({ intent, status: 403 })
		}
		expect(await passwordOf()).toEqual(before)
	})

	it('refuses change-email', async () => {
		const { cookie } = await impersonate()
		const status = await statusOf(() =>
			profileAction({
				request: form(cookie, 'http://localhost:3000/profile', {
					intent: 'change-email',
					email: 'admin-controlled@example.com',
				}),
			} as never),
		)
		expect(status).toBe(403)
	})

	it('refuses passkey registration', async () => {
		const { cookie } = await impersonate()
		const request = createAuthenticatedRequest(
			'http://localhost:3000/webauthn/registration',
			{ method: 'POST', body: '{}' },
			cookie,
		)
		expect(
			await statusOf(() => passkeyRegistrationAction({ request } as never)),
		).toBe(403)
	})

	it('refuses requesting or cancelling account deletion', async () => {
		const { target, cookie } = await impersonate()
		for (const intent of ['request-data-deletion', 'cancel-data-deletion']) {
			const status = await statusOf(() =>
				securityAction({
					request: form(cookie, 'http://localhost:3000/security', { intent }),
				} as never),
			)
			expect({ intent, status }).toEqual({ intent, status: 403 })
		}
		const requests = await db
			.select({ id: DataSubjectRequest.id })
			.from(DataSubjectRequest)
			.where(eq(DataSubjectRequest.userId, target.id))
		expect(requests).toEqual([])
	})

	it('refuses downloading the user data export', async () => {
		const { target, cookie } = await impersonate()
		const request = createAuthenticatedRequest(
			'http://localhost:3000/resources/download-user-data',
			{},
			cookie,
		)
		expect(
			await statusOf(() => downloadUserDataLoader({ request } as never)),
		).toBe(403)
		const requests = await db
			.select({ id: DataSubjectRequest.id })
			.from(DataSubjectRequest)
			.where(eq(DataSubjectRequest.userId, target.id))
		expect(requests).toEqual([])
	})

	it('does not block the same intents outside impersonation', async () => {
		const user = await createTestUser()
		const { cookie } = await createTestSession(user.id)
		const status = await statusOf(() =>
			securityAction({
				request: form(cookie, 'http://localhost:3000/security', {
					intent: 'generate-backup-codes',
				}),
			} as never),
		)
		// No 2FA enrolled: the action answers 400, not the impersonation 403.
		expect(status).toBe(400)
	})
})
