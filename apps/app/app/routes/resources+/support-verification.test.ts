import { AuditAction, auditService } from '@repo/audit'
import {
	getClientIp,
	getPendingVerificationForUser,
	hashIp,
	impersonationSessionStorage,
	requestCallerVerification,
	submitCallerVerificationCode,
} from '@repo/auth'
import {
	ImpersonationSession,
	SupportVerification,
	db,
	eq,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action } from './support-verification.ts'

// Impersonation is applied by host in production; make it apply here.
vi.mock('@repo/common/cookie-domain', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	shouldApplyImpersonationToUserId: () => true,
}))

let log: MockInstance<typeof auditService.log>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
})

async function reveal(cookie: string, verificationId: string) {
	const body = new FormData()
	body.set('verificationId', verificationId)
	const request = createAuthenticatedRequest(
		'http://localhost:3000/resources/support-verification',
		{ method: 'POST', body },
		cookie,
	)
	try {
		return (await action({ request } as never)) as Response
	} catch (thrown) {
		return thrown as Response
	}
}

describe('the code shown in the App (#291)', () => {
	it('is made for the signed-in user and works for the agent who asked', async () => {
		const agent = await createTestUser({ name: 'Sara Support' })
		const operator = await createTestUser()
		const { cookie } = await createTestSession(operator.id)
		const requested = await requestCallerVerification({
			agentId: agent.id,
			userId: operator.id,
		})
		if (requested.status !== 'requested') throw new Error('not requested')

		const response = await reveal(cookie, requested.id)
		expect(response.status).toBe(200)
		const payload = (await response.json()) as { status: string; code: string }
		expect(payload.status).toBe('ok')
		expect(payload.code).toMatch(/^\d{6}$/)
		expect(response.headers.get('Cache-Control')).toContain('no-store')

		// The audit row says a code was shown, never which code.
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.CALLER_VERIFICATION_CODE_SHOWN,
				userId: operator.id,
			}),
		)
		expect(JSON.stringify(log.mock.calls)).not.toContain(payload.code)

		// Only a hash is stored.
		const [row] = await db
			.select()
			.from(SupportVerification)
			.where(eq(SupportVerification.id, requested.id))
		expect(row!.codeHash).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(row)).not.toContain(payload.code)

		// What the operator read out verifies the caller.
		expect(
			await submitCallerVerificationCode({
				agentId: agent.id,
				userId: operator.id,
				code: payload.code,
			}),
		).toMatchObject({ status: 'verified' })
	})

	it('is not shown to another signed-in user', async () => {
		const agent = await createTestUser()
		const operator = await createTestUser()
		const bystander = await createTestUser()
		const { cookie } = await createTestSession(bystander.id)
		const requested = await requestCallerVerification({
			agentId: agent.id,
			userId: operator.id,
		})
		if (requested.status !== 'requested') throw new Error('not requested')

		const response = await reveal(cookie, requested.id)
		expect(response.status).toBe(404)
		expect(await getPendingVerificationForUser(bystander.id)).toBeNull()
	})

	it('is refused to an admin impersonating the user, so the agent cannot read it', async () => {
		const agent = await createTestUser({ role: 'admin' })
		const operator = await createTestUser()
		const requested = await requestCallerVerification({
			agentId: agent.id,
			userId: operator.id,
		})
		if (requested.status !== 'requested') throw new Error('not requested')

		const { cookie } = await createTestSession(agent.id)
		const probe = createAuthenticatedRequest(
			'http://localhost:3000/',
			{},
			cookie,
		)
		const [impersonation] = await db
			.insert(ImpersonationSession)
			.values({
				adminUserId: agent.id,
				targetUserId: operator.id,
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

		const response = await reveal(
			`${cookie}; ${impersonationCookie}`,
			requested.id,
		)
		expect(response.status).toBe(403)
		const [row] = await db
			.select()
			.from(SupportVerification)
			.where(eq(SupportVerification.id, requested.id))
		expect(row!.codeHash).toBeNull()
	})
})
