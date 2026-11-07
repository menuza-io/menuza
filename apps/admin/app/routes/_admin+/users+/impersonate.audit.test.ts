import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	cleanupExpiredImpersonationSessions,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	db,
	eq,
	ImpersonationSession,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { action } from './$userId.impersonate.tsx'

async function createUser() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	return user!
}

async function adminWithCookie() {
	const admin = await createUser()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: admin.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: admin.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	return { admin, cookie: await authSessionStorage.commitSession(authSession) }
}

function endEntries(log: MockInstance<typeof auditService.logAdminOperation>) {
	return log.mock.calls.filter(
		([action]) => action === AuditAction.ADMIN_IMPERSONATION_END,
	)
}

let log: MockInstance<typeof auditService.logAdminOperation>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'logAdminOperation').mockResolvedValue(undefined)
})

describe('impersonation audit trail', () => {
	it('logs END (replaced) for the session a new impersonation replaces, before START', async () => {
		const { admin, cookie } = await adminWithCookie()
		const first = await createUser()
		const second = await createUser()
		const [previous] = await db
			.insert(ImpersonationSession)
			.values({
				adminUserId: admin.id,
				targetUserId: first.id,
				expiresAt: new Date(Date.now() + 10 * 60_000),
				ipHash: 'hash',
			})
			.returning()

		await action({
			request: new Request(
				`http://localhost:3004/users/${second.id}/impersonate`,
				{ method: 'POST', headers: { Cookie: cookie } },
			),
			params: { userId: second.id },
		}).catch((thrown: unknown) => thrown)

		const ends = endEntries(log)
		expect(ends).toHaveLength(1)
		expect(ends[0]![3]).toMatchObject({
			impersonationSessionId: previous!.id,
			targetUserId: first.id,
			reason: 'replaced',
		})
		const actions = log.mock.calls.map(([action]) => action)
		expect(actions.indexOf(AuditAction.ADMIN_IMPERSONATION_END)).toBeLessThan(
			actions.indexOf(AuditAction.ADMIN_IMPERSONATION_START),
		)
		expect(
			await db
				.select()
				.from(ImpersonationSession)
				.where(eq(ImpersonationSession.id, previous!.id)),
		).toHaveLength(0)
	})

	it('logs END (expired) when expired sessions are cleaned up', async () => {
		const admin = await createUser()
		const target = await createUser()
		const [expired] = await db
			.insert(ImpersonationSession)
			.values({
				adminUserId: admin.id,
				targetUserId: target.id,
				expiresAt: new Date(Date.now() - 1000),
				ipHash: 'hash',
			})
			.returning()

		await cleanupExpiredImpersonationSessions()

		expect(
			endEntries(log).find(
				([, , , metadata]) =>
					(metadata as { impersonationSessionId?: string })
						?.impersonationSessionId === expired!.id,
			)?.[3],
		).toMatchObject({ reason: 'expired', targetUserId: target.id })
	})
})
