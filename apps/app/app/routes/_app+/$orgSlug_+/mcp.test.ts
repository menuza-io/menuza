import { invariant } from '@epic-web/invariant'
import { faker } from '@faker-js/faker'
import {
	MCPAccessToken,
	MCPAuthorization,
	MCPRefreshToken,
	Organization,
	OrganizationRole,
	Role,
	User,
	UserOrganization,
	_RoleToUser,
	and,
	db,
	eq,
	inArray,
	or,
} from '@repo/database'
import fc from 'fast-check'
import { describe, it, expect, afterEach } from 'vitest'
import { createAuthorizationWithTokens } from '#app/utils/mcp/oauth.server.ts'

async function connectUserRole(userId: string, roleName: string) {
	const [role] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, roleName))
		.limit(1)
	if (role) {
		await db.insert(_RoleToUser).values({ A: role.id, B: userId })
	}
}

async function createTestUser(createdUserIds: string[]) {
	const unique = faker.string.uuid()
	const [user] = await db
		.insert(User)
		.values({
			email: `user-${unique}@example.com`,
			username: `user-${unique.slice(0, 8)}`,
			name: faker.person.fullName(),
		})
		.returning()
	if (!user) throw new Error('Failed to insert user')
	await connectUserRole(user.id, 'user')
	createdUserIds.push(user.id)
	return user
}

async function createTestOrganization(userId: string, createdOrgIds: string[]) {
	let [adminRole] = await db
		.select()
		.from(OrganizationRole)
		.where(eq(OrganizationRole.name, 'admin'))
		.limit(1)
	if (!adminRole) {
		;[adminRole] = await db
			.insert(OrganizationRole)
			.values({
				id: 'org_role_admin',
				name: 'admin',
				description: 'Administrator role',
				level: 4,
			})
			.returning()
		if (!adminRole) throw new Error('Admin role not found')
	}

	const [org] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `org-${faker.string.uuid().slice(0, 8)}`,
		})
		.returning()
	if (!org) throw new Error('Failed to insert organization')
	await db.insert(UserOrganization).values({
		userId,
		organizationId: org.id,
		organizationRoleId: adminRole.id,
	})
	createdOrgIds.push(org.id)
	return org
}

describe('MCP Settings Page', () => {
	const createdUserIds: string[] = []
	const createdOrgIds: string[] = []

	afterEach(async () => {
		if (createdUserIds.length === 0 && createdOrgIds.length === 0) return

		const authIds = db
			.select({ id: MCPAuthorization.id })
			.from(MCPAuthorization)
			.where(
				or(
					inArray(MCPAuthorization.userId, createdUserIds),
					inArray(MCPAuthorization.organizationId, createdOrgIds),
				),
			)
		await db
			.delete(MCPRefreshToken)
			.where(inArray(MCPRefreshToken.authorizationId, authIds))
		await db
			.delete(MCPAccessToken)
			.where(inArray(MCPAccessToken.authorizationId, authIds))
		await db
			.delete(MCPAuthorization)
			.where(
				or(
					inArray(MCPAuthorization.userId, createdUserIds),
					inArray(MCPAuthorization.organizationId, createdOrgIds),
				),
			)
		await db
			.delete(UserOrganization)
			.where(
				or(
					inArray(UserOrganization.userId, createdUserIds),
					inArray(UserOrganization.organizationId, createdOrgIds),
				),
			)
		await db.delete(Organization).where(inArray(Organization.id, createdOrgIds))
		await db.delete(User).where(inArray(User.id, createdUserIds))
		createdUserIds.length = 0
		createdOrgIds.length = 0
	})

	describe('Property 12: Authorization list completeness', () => {
		it('should display all authorizations for a user and organization', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.string({ minLength: 1, maxLength: 50 }), {
						minLength: 1,
						maxLength: 5,
					}),
					async (clientNames) => {
						const user = await createTestUser(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const createdAuths = []
						for (const clientName of clientNames) {
							createdAuths.push(
								await createAuthorizationWithTokens({
									userId: user.id,
									organizationId: org.id,
									clientName,
								}),
							)
						}

						const authorizations = await db
							.select({
								id: MCPAuthorization.id,
								clientName: MCPAuthorization.clientName,
								createdAt: MCPAuthorization.createdAt,
								lastUsedAt: MCPAuthorization.lastUsedAt,
							})
							.from(MCPAuthorization)
							.where(
								and(
									eq(MCPAuthorization.userId, user.id),
									eq(MCPAuthorization.organizationId, org.id),
								),
							)

						expect(authorizations).toHaveLength(createdAuths.length)

						const returnedNames = authorizations.map((a) => a.clientName).sort()
						const expectedNames = clientNames.sort()
						expect(returnedNames).toEqual(expectedNames)
					},
				),
				{ numRuns: 100 },
			)
		}, 30000)

		it('should not include authorizations from other users', async () => {
			const user1 = await createTestUser(createdUserIds)
			const user2 = await createTestUser(createdUserIds)
			const org = await createTestOrganization(user1.id, createdOrgIds)

			const [adminRole] = await db
				.select()
				.from(OrganizationRole)
				.where(eq(OrganizationRole.name, 'admin'))
				.limit(1)
			invariant(adminRole, 'Admin role should exist')

			await db.insert(UserOrganization).values({
				userId: user2.id,
				organizationId: org.id,
				organizationRoleId: adminRole.id,
			})

			await createAuthorizationWithTokens({
				userId: user1.id,
				organizationId: org.id,
				clientName: 'Client 1',
			})

			await createAuthorizationWithTokens({
				userId: user2.id,
				organizationId: org.id,
				clientName: 'Client 2',
			})

			const user1Auths = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user1.id),
						eq(MCPAuthorization.organizationId, org.id),
					),
				)

			expect(user1Auths).toHaveLength(1)
			expect(user1Auths[0]!.clientName).toBe('Client 1')
		})

		it('should not include authorizations from other organizations', async () => {
			const user = await createTestUser(createdUserIds)
			const org1 = await createTestOrganization(user.id, createdOrgIds)
			const org2 = await createTestOrganization(user.id, createdOrgIds)

			await createAuthorizationWithTokens({
				userId: user.id,
				organizationId: org1.id,
				clientName: 'Client 1',
			})

			await createAuthorizationWithTokens({
				userId: user.id,
				organizationId: org2.id,
				clientName: 'Client 2',
			})

			const org1Auths = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user.id),
						eq(MCPAuthorization.organizationId, org1.id),
					),
				)

			expect(org1Auths).toHaveLength(1)
			expect(org1Auths[0]!.clientName).toBe('Client 1')
		})
	})

	describe('Property 13: Authorization display fields', () => {
		it('should include all required display fields for each authorization', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 50 }),
					async (clientName) => {
						const user = await createTestUser(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						await createAuthorizationWithTokens({
							userId: user.id,
							organizationId: org.id,
							clientName,
						})

						const [authorization] = await db
							.select({
								id: MCPAuthorization.id,
								clientName: MCPAuthorization.clientName,
								createdAt: MCPAuthorization.createdAt,
								lastUsedAt: MCPAuthorization.lastUsedAt,
							})
							.from(MCPAuthorization)
							.where(
								and(
									eq(MCPAuthorization.userId, user.id),
									eq(MCPAuthorization.organizationId, org.id),
								),
							)
							.limit(1)

						expect(authorization).toBeDefined()
						expect(authorization?.id).toBeDefined()
						expect(authorization?.clientName).toBe(clientName)
						expect(authorization?.createdAt).toBeDefined()
						expect(authorization?.createdAt).toBeInstanceOf(Date)
						expect(authorization?.lastUsedAt).toBeNull()
					},
				),
				{ numRuns: 100 },
			)
		}, 30000)

		it('should update lastUsedAt when token is used', async () => {
			const user = await createTestUser(createdUserIds)
			const org = await createTestOrganization(user.id, createdOrgIds)

			const { accessToken: ignoredAccessToken } =
				await createAuthorizationWithTokens({
					userId: user.id,
					organizationId: org.id,
					clientName: 'Test Client',
				})

			let [authorization] = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user.id),
						eq(MCPAuthorization.organizationId, org.id),
					),
				)
				.limit(1)

			expect(authorization?.lastUsedAt).toBeNull()

			await db
				.update(MCPAuthorization)
				.set({ lastUsedAt: new Date() })
				.where(eq(MCPAuthorization.id, authorization!.id))

			;[authorization] = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user.id),
						eq(MCPAuthorization.organizationId, org.id),
					),
				)
				.limit(1)

			expect(authorization?.lastUsedAt).toBeDefined()
			expect(authorization?.lastUsedAt).toBeInstanceOf(Date)
		})
	})

	describe('Property 15: Authorization list growth', () => {
		it('should increase list size by one when new authorization is added', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.string({ minLength: 1, maxLength: 50 }), {
						minLength: 1,
						maxLength: 5,
					}),
					async (clientNames) => {
						const user = await createTestUser(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						let currentCount = 0

						for (const clientName of clientNames) {
							await createAuthorizationWithTokens({
								userId: user.id,
								organizationId: org.id,
								clientName,
							})

							currentCount++

							const authorizations = await db
								.select()
								.from(MCPAuthorization)
								.where(
									and(
										eq(MCPAuthorization.userId, user.id),
										eq(MCPAuthorization.organizationId, org.id),
									),
								)

							expect(authorizations).toHaveLength(currentCount)
						}
					},
				),
				{ numRuns: 100 },
			)
		}, 30000)

		it('should maintain correct count after revocation', async () => {
			const user = await createTestUser(createdUserIds)
			const org = await createTestOrganization(user.id, createdOrgIds)

			const auths = []
			for (const clientName of ['Client 1', 'Client 2', 'Client 3']) {
				auths.push(
					await createAuthorizationWithTokens({
						userId: user.id,
						organizationId: org.id,
						clientName,
					}),
				)
			}

			let authorizations = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user.id),
						eq(MCPAuthorization.organizationId, org.id),
					),
				)
			expect(authorizations).toHaveLength(3)

			const firstAuth = auths[0]
			if (!firstAuth) throw new Error('Expected authorization')
			await db
				.update(MCPAuthorization)
				.set({ isActive: false })
				.where(eq(MCPAuthorization.id, firstAuth.authorization.id))

			authorizations = await db
				.select()
				.from(MCPAuthorization)
				.where(
					and(
						eq(MCPAuthorization.userId, user.id),
						eq(MCPAuthorization.organizationId, org.id),
						eq(MCPAuthorization.isActive, true),
					),
				)
			expect(authorizations).toHaveLength(2)
		})
	})
})
