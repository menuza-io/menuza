import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	getPendingVerificationForUser,
	getSessionExpirationDate,
	revealVerificationCode,
	requestCallerVerification,
	sessionKey,
	submitCallerVerificationCode,
} from '@repo/auth'
import {
	Organization,
	Role,
	Session,
	SupportVerification,
	User,
	UserOrganization,
	_RoleToUser,
	db,
	eq,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { action as transferAction } from '../organizations+/$organizationId_+/ownership-transfer.tsx'
import { action as changeEmailAction } from './$userId.change-email.tsx'
import { action as resetTwoFactorAction } from './$userId.reset-2fa.tsx'
import { action as verifyAction } from './$userId.verify.tsx'

async function createUser(name?: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name: name ?? null })
		.returning()
	return user!
}

async function agentWithCookie(name = 'Sara Support') {
	const agent = await createUser(name)
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: agent.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: agent.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return {
		agent,
		cookie: await authSessionStorage.commitSession(authSession),
	}
}

function post(path: string, cookie: string, fields: Record<string, string>) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return new Request(`http://localhost:3004${path}`, {
		method: 'POST',
		headers: { Cookie: cookie },
		body,
	})
}

async function call(
	run: (args: never) => Promise<unknown>,
	request: Request,
	params: Record<string, string>,
) {
	try {
		const result = await run({ request, params } as never)
		return result as { data?: unknown; init?: { status?: number } } & Response
	} catch (thrown) {
		return thrown as { data?: unknown; init?: { status?: number } } & Response
	}
}

function bodyOf(result: unknown): Record<string, unknown> {
	const value = result as { data?: unknown }
	return (value?.data ?? {}) as Record<string, unknown>
}

/** Runs the whole flow: the agent asks, the operator opens the card, the agent types the code. */
async function verifyCaller(agentId: string, userId: string, now = new Date()) {
	const requested = await requestCallerVerification({ agentId, userId, now })
	if (requested.status !== 'requested') throw new Error('not requested')
	const revealed = await revealVerificationCode({
		userId,
		verificationId: requested.id,
		now,
	})
	if (revealed.status !== 'ok') throw new Error('not revealed')
	const submitted = await submitCallerVerificationCode({
		agentId,
		userId,
		code: revealed.code,
		now,
	})
	return { requested, code: revealed.code, submitted }
}

let log: MockInstance<typeof auditService.log>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
})

describe('caller verification (#291)', () => {
	it('shows the code only to the target user, never to the agent, and stores only a hash', async () => {
		const { agent, cookie } = await agentWithCookie()
		const target = await createUser()
		const bystander = await createUser()

		const response = await call(
			verifyAction,
			post(`/users/${target.id}/verify`, cookie, { intent: 'request' }),
			{ userId: target.id },
		)
		expect(bodyOf(response).status).toBe('requested')
		// Admin's answer has no code in it.
		expect(JSON.stringify(response)).not.toMatch(/\b\d{6}\b/)

		// Another signed-in operator sees no pending request.
		expect(await getPendingVerificationForUser(bystander.id)).toBeNull()
		const pending = await getPendingVerificationForUser(target.id)
		expect(pending).toMatchObject({ agentFirstName: 'Sara' })

		// Nobody but the target can make the code.
		expect(
			await revealVerificationCode({
				userId: bystander.id,
				verificationId: pending!.id,
			}),
		).toEqual({ status: 'not_found' })
		const revealed = await revealVerificationCode({
			userId: target.id,
			verificationId: pending!.id,
		})
		expect(revealed.status).toBe('ok')
		if (revealed.status !== 'ok') return
		expect(revealed.code).toMatch(/^\d{6}$/)

		const [row] = await db
			.select()
			.from(SupportVerification)
			.where(eq(SupportVerification.id, pending!.id))
		expect(row!.codeHash).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(row)).not.toContain(revealed.code)
		expect(row!.agentId).toBe(agent.id)
	})

	it('refuses to change a user email without a fresh verification, and allows it with one', async () => {
		const { agent, cookie } = await agentWithCookie()
		const target = await createUser()

		const refused = await call(
			changeEmailAction,
			post(`/users/${target.id}/change-email`, cookie, {
				email: 'new-address@example.com',
			}),
			{ userId: target.id },
		)
		expect(refused.status).toBe(403)
		const [unchanged] = await db
			.select()
			.from(User)
			.where(eq(User.id, target.id))
		expect(unchanged!.email).toBe(target.email)
		// The refusal is audited with the agent's name.
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_SUPPORT_ACTION_REFUSED,
				userId: agent.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)

		const { submitted } = await verifyCaller(agent.id, target.id)
		expect(submitted.status).toBe('verified')

		const allowed = await call(
			changeEmailAction,
			post(`/users/${target.id}/change-email`, cookie, {
				email: 'New-Address@Example.com',
			}),
			{ userId: target.id },
		)
		expect(allowed.status).toBe(302)
		const [changed] = await db.select().from(User).where(eq(User.id, target.id))
		expect(changed!.email).toBe('new-address@example.com')
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_USER_EMAIL_CHANGED,
				userId: agent.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)
		// The audit row never holds a full address.
		const audited = JSON.stringify(
			log.mock.calls.filter(
				([entry]) =>
					(entry as { action: string }).action ===
					AuditAction.ADMIN_USER_EMAIL_CHANGED,
			),
		)
		expect(audited).not.toContain('new-address@example.com')
	})

	it('does not count a verification by another agent, for another user, or an old one', async () => {
		const { agent, cookie } = await agentWithCookie()
		const other = await agentWithCookie('Other Agent')
		const target = await createUser()
		const stranger = await createUser()

		await verifyCaller(other.agent.id, target.id)
		await verifyCaller(agent.id, stranger.id)
		const old = new Date(Date.now() - 16 * 60_000)
		await verifyCaller(agent.id, target.id, old)

		const refused = await call(
			resetTwoFactorAction,
			post(`/users/${target.id}/reset-2fa`, cookie, {}),
			{ userId: target.id },
		)
		expect(refused.status).toBe(403)
	})

	it('resets two-factor sign-in with a fresh verification', async () => {
		const { agent, cookie } = await agentWithCookie()
		const target = await createUser()
		await verifyCaller(agent.id, target.id)
		const result = await call(
			resetTwoFactorAction,
			post(`/users/${target.id}/reset-2fa`, cookie, {}),
			{ userId: target.id },
		)
		expect(result.status).toBe(302)
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_USER_TWO_FACTOR_RESET,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)
	})

	it('expires a request after 10 minutes', async () => {
		const agent = await createUser('Agent')
		const target = await createUser()
		const start = new Date()
		const requested = await requestCallerVerification({
			agentId: agent.id,
			userId: target.id,
			now: start,
		})
		if (requested.status !== 'requested') throw new Error('x')
		const revealed = await revealVerificationCode({
			userId: target.id,
			verificationId: requested.id,
			now: start,
		})
		if (revealed.status !== 'ok') throw new Error('x')
		const late = new Date(start.getTime() + 10 * 60_000 + 1000)
		expect(
			await submitCallerVerificationCode({
				agentId: agent.id,
				userId: target.id,
				code: revealed.code,
				now: late,
			}),
		).toEqual({ status: 'expired' })
		expect(
			await revealVerificationCode({
				userId: target.id,
				verificationId: requested.id,
				now: late,
			}),
		).toEqual({ status: 'expired' })
	})

	it('works once', async () => {
		const agent = await createUser('Agent')
		const target = await createUser()
		const { code, submitted } = await verifyCaller(agent.id, target.id)
		expect(submitted.status).toBe('verified')
		expect(
			await submitCallerVerificationCode({
				agentId: agent.id,
				userId: target.id,
				code,
			}),
		).toEqual({ status: 'no_request' })
	})

	it('does not count a code the operator has not opened yet', async () => {
		const agent = await createUser('Agent')
		const target = await createUser()
		await requestCallerVerification({ agentId: agent.id, userId: target.id })
		expect(
			await submitCallerVerificationCode({
				agentId: agent.id,
				userId: target.id,
				code: '123456',
			}),
		).toEqual({ status: 'not_shown' })
	})

	it('locks verification for the user for an hour after five wrong entries', async () => {
		const agent = await createUser('Agent')
		const target = await createUser()
		const now = new Date()
		const requested = await requestCallerVerification({
			agentId: agent.id,
			userId: target.id,
			now,
		})
		if (requested.status !== 'requested') throw new Error('x')
		const revealed = await revealVerificationCode({
			userId: target.id,
			verificationId: requested.id,
			now,
		})
		if (revealed.status !== 'ok') throw new Error('x')
		const wrong = revealed.code === '000000' ? '111111' : '000000'

		for (let attempt = 1; attempt <= 4; attempt++) {
			expect(
				await submitCallerVerificationCode({
					agentId: agent.id,
					userId: target.id,
					code: wrong,
					now,
				}),
			).toEqual({ status: 'wrong', attemptsLeft: 5 - attempt })
		}
		const fifth = await submitCallerVerificationCode({
			agentId: agent.id,
			userId: target.id,
			code: wrong,
			now,
		})
		expect(fifth.status).toBe('locked')

		// Even the right code is refused while locked, and so is a new request.
		expect(
			(
				await submitCallerVerificationCode({
					agentId: agent.id,
					userId: target.id,
					code: revealed.code,
					now,
				})
			).status,
		).toBe('locked')
		expect(
			(
				await requestCallerVerification({
					agentId: agent.id,
					userId: target.id,
					now,
				})
			).status,
		).toBe('locked')

		// After the hour it works again.
		const later = new Date(now.getTime() + 61 * 60_000)
		expect(
			(
				await requestCallerVerification({
					agentId: agent.id,
					userId: target.id,
					now: later,
				})
			).status,
		).toBe('requested')
	})

	it('logs every request and result with the agent name, and never the code', async () => {
		const { agent, cookie } = await agentWithCookie()
		const target = await createUser()

		await call(
			verifyAction,
			post(`/users/${target.id}/verify`, cookie, { intent: 'request' }),
			{ userId: target.id },
		)
		const pending = await getPendingVerificationForUser(target.id)
		const revealed = await revealVerificationCode({
			userId: target.id,
			verificationId: pending!.id,
		})
		if (revealed.status !== 'ok') throw new Error('x')
		await call(
			verifyAction,
			post(`/users/${target.id}/verify`, cookie, {
				intent: 'submit',
				code: revealed.code,
			}),
			{ userId: target.id },
		)

		const actions = log.mock.calls.map(
			([entry]) => (entry as { action: string }).action,
		)
		expect(actions).toEqual([
			AuditAction.CALLER_VERIFICATION_REQUESTED,
			AuditAction.CALLER_VERIFICATION_RESULT,
		])
		for (const [entry] of log.mock.calls) {
			expect(entry).toMatchObject({
				userId: agent.id,
				targetUserId: target.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			})
		}
		expect(JSON.stringify(log.mock.calls)).not.toContain(revealed.code)
	})

	it('is for Admin only: a signed-out request is refused', async () => {
		const target = await createUser()
		const result = await call(
			verifyAction,
			new Request(`http://localhost:3004/users/${target.id}/verify`, {
				method: 'POST',
				body: new FormData(),
			}),
			{ userId: target.id },
		)
		expect([302, 401, 403]).toContain((result as Response).status)
	})
})

describe('ownership transfer is gated by the caller verification (#291)', () => {
	async function organizationWithAdminAndMember() {
		const id = randomUUID()
		const [organization] = await db
			.insert(Organization)
			.values({ name: `Business ${id.slice(0, 6)}`, slug: `org-${id}` })
			.returning()
		const owner = await createUser('Olivia Owner')
		const member = await createUser('Mario Member')
		await db.insert(UserOrganization).values([
			{
				userId: owner.id,
				organizationId: organization!.id,
				organizationRoleId: 'org_role_admin',
			},
			{
				userId: member.id,
				organizationId: organization!.id,
				organizationRoleId: 'org_role_member',
			},
		])
		return { organization: organization!, owner, member }
	}

	async function roleOf(userId: string, _organizationId: string) {
		const [row] = await db
			.select({ roleId: UserOrganization.organizationRoleId })
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, userId))
		return row?.roleId
	}

	it('is refused without a fresh verification of the caller, and allowed with one', async () => {
		const { agent, cookie } = await agentWithCookie()
		const { organization, owner, member } =
			await organizationWithAdminAndMember()
		const form = { fromUserId: owner.id, toUserId: member.id }

		const refused = await call(
			transferAction,
			post(
				`/organizations/${organization.id}/ownership-transfer`,
				cookie,
				form,
			),
			{ organizationId: organization.id },
		)
		expect(refused.status).toBe(403)
		expect(await roleOf(member.id, organization.id)).toBe('org_role_member')

		// Verifying the NEW owner, or a stranger, does not count: it is the caller.
		await verifyCaller(agent.id, member.id)
		const stillRefused = await call(
			transferAction,
			post(
				`/organizations/${organization.id}/ownership-transfer`,
				cookie,
				form,
			),
			{ organizationId: organization.id },
		)
		expect(stillRefused.status).toBe(403)

		await verifyCaller(agent.id, owner.id)
		const allowed = await call(
			transferAction,
			post(
				`/organizations/${organization.id}/ownership-transfer`,
				cookie,
				form,
			),
			{ organizationId: organization.id },
		)
		expect(allowed.status).toBe(302)
		expect(await roleOf(member.id, organization.id)).toBe('org_role_admin')
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.ADMIN_OWNERSHIP_TRANSFER_STARTED,
				organizationId: organization.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)
	})

	it('needs the caller to be an admin of that restaurant', async () => {
		const { agent, cookie } = await agentWithCookie()
		const { organization, member } = await organizationWithAdminAndMember()
		const bystander = await createUser('Pat Passerby')
		await verifyCaller(agent.id, bystander.id)
		const result = await call(
			transferAction,
			post(`/organizations/${organization.id}/ownership-transfer`, cookie, {
				fromUserId: bystander.id,
				toUserId: member.id,
			}),
			{ organizationId: organization.id },
		)
		expect(bodyOf(result)).toMatchObject({ error: 'caller_not_admin' })
	})
})
