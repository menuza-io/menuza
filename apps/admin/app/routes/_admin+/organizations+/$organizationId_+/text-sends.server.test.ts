import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { billingPeriod, MAX_SMS_GRANT } from '@repo/common/marketing-allowance'
import {
	db,
	eq,
	MarketingSmsUsage,
	Organization,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { action, loader } from './text-sends.server.ts'

async function setup(role: 'admin' | 'user' = 'admin') {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	const [organization] = await db
		.insert(Organization)
		.values({ name: 'Test organization', slug: id, planName: 'Starter' })
		.returning()
	if (!user || !organization) throw new Error('Test setup failed')
	await db
		.insert(Role)
		.values({ name: role, description: `${role} role` })
		.onConflictDoNothing()
	const roleRecord = await db.query.Role.findFirst({
		where: eq(Role.name, role),
	})
	if (!roleRecord) throw new Error('Test role missing')
	await db.insert(_RoleToUser).values({ A: roleRecord.id, B: user.id })
	await db.insert(UserOrganization).values({
		userId: user.id,
		organizationId: organization.id,
		organizationRoleId: 'org_role_admin',
	})
	const [session] = await db
		.insert(Session)
		.values({ userId: user.id, expirationDate: getSessionExpirationDate() })
		.returning()
	if (!session) throw new Error('Test session missing')
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session.id)
	const cookie = await authSessionStorage.commitSession(authSession)
	const defaultOrganizationId = organization.id

	function args(extra?: string, organizationId = defaultOrganizationId) {
		const url = `http://localhost:3004/organizations/${organizationId}/text-sends`
		return {
			request: new Request(url, {
				headers: { Cookie: cookie },
				...(extra !== undefined
					? {
							method: 'POST',
							body: new URLSearchParams({ intent: 'grant', extra }),
						}
					: {}),
			}),
			params: { organizationId },
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/organizations/:organizationId/text-sends',
		}
	}
	return { user, organization, args }
}

describe('platform admin text sends (#247)', () => {
	it('shows the plan, the allowance and what is used this month', async () => {
		const { organization, args } = await setup()
		const result = await loader(args())
		expect(result.data.organization).toMatchObject({
			id: organization.id,
			planName: 'Starter',
		})
		expect(result.data.allowance).toMatchObject({
			limit: 4,
			extra: 0,
			used: 0,
			remaining: 4,
			periodKey: billingPeriod(Date.now()).key,
		})
	})

	it('grants extra sends for this month, adds them up, and audits the count', async () => {
		const { user, organization, args } = await setup()
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const first = await action(args('3'))
		expect((first as Response).status).toBe(302)
		await action(args('2'))
		const rows = await db
			.select()
			.from(MarketingSmsUsage)
			.where(eq(MarketingSmsUsage.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ extraSends: 5, sends: 0 })
		expect((await loader(args())).data.allowance).toMatchObject({
			limit: 9,
			extra: 5,
			remaining: 9,
		})
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.MARKETING_TEXT_SENDS_GRANTED,
				userId: user.id,
				organizationId: organization.id,
				details: expect.stringContaining('3 extra marketing text sends'),
			}),
		)
	})

	it.each(['0', '-1', '1.5', 'abc', '', String(MAX_SMS_GRANT + 1)])(
		'refuses %j without granting or auditing',
		async (value) => {
			const { organization, args } = await setup()
			const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
			const response = await action(args(value))
			expect(response).toMatchObject({ init: { status: 400 } })
			expect(
				await db
					.select()
					.from(MarketingSmsUsage)
					.where(eq(MarketingSmsUsage.organizationId, organization.id)),
			).toHaveLength(0)
			expect(audit).not.toHaveBeenCalled()
		},
	)

	it('denies tenant admins without the platform admin role', async () => {
		const { organization, args } = await setup('user')
		await expect(loader(args())).rejects.toMatchObject({ status: 403 })
		await expect(action(args('3'))).rejects.toMatchObject({ status: 403 })
		expect(
			await db
				.select()
				.from(MarketingSmsUsage)
				.where(eq(MarketingSmsUsage.organizationId, organization.id)),
		).toHaveLength(0)
	})

	it('returns 404 for a missing organization', async () => {
		const { args } = await setup()
		await expect(loader(args(undefined, 'missing'))).rejects.toMatchObject({
			status: 404,
		})
		await expect(action(args('3', 'missing'))).rejects.toMatchObject({
			status: 404,
		})
	})
})
