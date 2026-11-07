import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	db,
	eq,
	Organization,
	SSOConfiguration,
	SSOIdentity,
	User,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSSOIdentityLink } from './sso-identity.server.ts'

async function setup() {
	const id = randomUUID()
	const users = await db
		.insert(User)
		.values([
			{ username: `u-${id}`, email: `u-${id}@example.com` },
			{ username: `o-${id}`, email: `o-${id}@example.com` },
			{ username: `a-${id}`, email: `a-${id}@example.com` },
		])
		.returning({ id: User.id })
	const [user, other, admin] = users
	const [organization] = await db
		.insert(Organization)
		.values({ name: 'SSO org', slug: `sso-${id}` })
		.returning({ id: Organization.id })
	const [config] = await db
		.insert(SSOConfiguration)
		.values({
			organizationId: organization!.id,
			providerName: 'IdP',
			issuerUrl: 'https://idp.example',
			clientId: 'client',
			clientSecret: 'encrypted',
		})
		.returning({ id: SSOConfiguration.id })
	await db.insert(SSOIdentity).values([
		{
			ssoConfigId: config!.id,
			issuer: 'https://idp.example',
			subject: `s-${id}`,
			userId: user!.id,
		},
		{
			ssoConfigId: config!.id,
			issuer: 'https://idp.example',
			subject: `t-${id}`,
			userId: other!.id,
		},
	])
	return {
		organizationId: organization!.id,
		configId: config!.id,
		userId: user!.id,
		otherId: other!.id,
		adminId: admin!.id,
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('resetSSOIdentityLink', () => {
	it('removes only that user’s link and audits it under the admin', async () => {
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const { organizationId, configId, userId, otherId, adminId } = await setup()

		const result = await resetSSOIdentityLink({
			organizationId,
			userId,
			adminUserId: adminId,
		})

		expect(result).toEqual({ status: 'reset' })
		const links = await db
			.select({ userId: SSOIdentity.userId })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.ssoConfigId, configId))
		expect(links).toEqual([{ userId: otherId }])
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.SSO_IDENTITY_LINK_RESET,
				userId: adminId,
				organizationId,
				targetUserId: userId,
			}),
		)
	})

	it('reports a user with no link and writes no audit entry', async () => {
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const { organizationId, adminId } = await setup()

		const result = await resetSSOIdentityLink({
			organizationId,
			userId: adminId,
			adminUserId: adminId,
		})

		expect(result).toEqual({ status: 'not_linked' })
		expect(log).not.toHaveBeenCalled()
	})

	it('does not touch links of another organization', async () => {
		vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const first = await setup()
		const second = await setup()

		const result = await resetSSOIdentityLink({
			organizationId: second.organizationId,
			userId: first.userId,
			adminUserId: second.adminId,
		})

		expect(result).toEqual({ status: 'not_linked' })
		const links = await db
			.select({ userId: SSOIdentity.userId })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.ssoConfigId, first.configId))
		expect(links).toHaveLength(2)
	})
})
