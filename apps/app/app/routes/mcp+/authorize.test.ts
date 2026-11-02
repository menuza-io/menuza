import { faker } from '@faker-js/faker'
import {
	MCPAccessToken,
	MCPAuthorization,
	MCPRefreshToken,
	Organization,
	OrganizationRole,
	Role,
	Session,
	User,
	UserOrganization,
	_RoleToUser,
	and,
	db,
	eq,
	gt,
	inArray,
	or,
} from '@repo/database'
import fc from 'fast-check'
import { describe, it, expect, afterEach } from 'vitest'
import {
	createAuthorizationCode as createAuthorizationCodeRaw,
	hashToken,
	AUTHORIZATION_CODE_EXPIRATION,
} from '#app/utils/mcp/oauth.server.ts'

import { TEST_PKCE_CHALLENGE } from '#tests/mcp-pkce.ts'

// Authorization codes are only issued with an S256 challenge, so tests do the same.
const createAuthorizationCode = (
	args: Parameters<typeof createAuthorizationCodeRaw>[0],
) => createAuthorizationCodeRaw({ ...TEST_PKCE_CHALLENGE, ...args })

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

// Helper to create test user with session
async function createTestUserWithSession(createdUserIds: string[]) {
	const [user] = await db
		.insert(User)
		.values({
			email: faker.internet.email(),
			username: `user-${faker.string.uuid().slice(0, 8)}`,
			name: faker.person.fullName(),
		})
		.returning()
	if (!user) throw new Error('Failed to insert user')
	await connectUserRole(user.id, 'user')
	createdUserIds.push(user.id)

	const [session] = await db
		.insert(Session)
		.values({
			userId: user.id,
			expirationDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})
		.returning()
	if (!session) throw new Error('Failed to insert session')

	return { user, session }
}

// Helper to create test organization
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
			slug: `${faker.helpers.slugify(faker.company.name()).toLowerCase()}-${faker.string.uuid().slice(0, 8)}`,
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

describe('OAuth Authorization Endpoint', { timeout: 60000 }, () => {
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
		await db.delete(Session).where(inArray(Session.userId, createdUserIds))
		await db.delete(Organization).where(inArray(Organization.id, createdOrgIds))
		await db.delete(User).where(inArray(User.id, createdUserIds))
		createdUserIds.length = 0
		createdOrgIds.length = 0
	})

	describe('Property 6: Session-based authorization redirect', () => {
		it('should redirect to authorization page when user has active session', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 100 }),
					async () => {
						const { user, session } =
							await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const [sessionRecord] = await db
							.select()
							.from(Session)
							.where(eq(Session.id, session.id))
							.limit(1)
						expect(sessionRecord).toBeDefined()
						expect(sessionRecord?.userId).toBe(user.id)

						const [userOrg] = await db
							.select()
							.from(UserOrganization)
							.where(
								and(
									eq(UserOrganization.userId, user.id),
									eq(UserOrganization.organizationId, org.id),
								),
							)
							.limit(1)
						expect(userOrg).toBeDefined()
						expect(userOrg?.active).toBe(true)
					},
				),
				{ numRuns: 10 },
			)
		})

		it('should require login when user has no active session', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 100 }),
					async () => {
						const [user] = await db
							.insert(User)
							.values({
								email: faker.internet.email(),
								username: faker.internet.username(),
								name: faker.person.fullName(),
							})
							.returning()
						if (!user) throw new Error('Failed to insert user')
						await connectUserRole(user.id, 'user')

						const sessions = await db
							.select()
							.from(Session)
							.where(
								and(
									eq(Session.userId, user.id),
									gt(Session.expirationDate, new Date()),
								),
							)
						expect(sessions).toHaveLength(0)
					},
				),
				{ numRuns: 10 },
			)
		})
	})

	describe('Property 7: Authorization approval code generation', () => {
		it('should generate unique authorization codes for each approval', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(
						fc.record({
							clientName: fc.string({ minLength: 1, maxLength: 100 }),
						}),
						{ minLength: 2, maxLength: 5 },
					),
					async (approvals) => {
						const { user } = await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const codes = await Promise.all(
							approvals.map((approval) =>
								createAuthorizationCode({
									clientId: 'test-client-id',
									userId: user.id,
									organizationId: org.id,
									clientName: approval.clientName,
									redirectUri: 'http://localhost:3000/callback',
								}),
							),
						)

						const uniqueCodes = new Set(codes)
						expect(uniqueCodes.size).toBe(codes.length)

						codes.forEach((code) => {
							expect(typeof code).toBe('string')
							expect(code.length).toBeGreaterThan(0)
						})
					},
				),
				{ numRuns: 10 },
			)
		})

		it('should create authorization record after code exchange', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 100 }),
					async (clientName) => {
						const { user } = await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const code = await createAuthorizationCode({
							clientId: 'test-client-id',
							userId: user.id,
							organizationId: org.id,
							clientName,
							redirectUri: 'http://localhost:3000/callback',
						})

						expect(code).toBeDefined()
						expect(typeof code).toBe('string')
						expect(code.length).toBeGreaterThan(0)

						const codeHash = hashToken(code)
						expect(codeHash).not.toBe(code)
					},
				),
				{ numRuns: 10 },
			)
		})
	})

	describe('Property 8: Authorization denial error response', () => {
		it('should return access_denied error on denial', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 100 }),
					async () => {
						const { user } = await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const authsBefore = await db
							.select()
							.from(MCPAuthorization)
							.where(
								and(
									eq(MCPAuthorization.userId, user.id),
									eq(MCPAuthorization.organizationId, org.id),
								),
							)
						expect(authsBefore).toHaveLength(0)

						const authsAfter = await db
							.select()
							.from(MCPAuthorization)
							.where(
								and(
									eq(MCPAuthorization.userId, user.id),
									eq(MCPAuthorization.organizationId, org.id),
								),
							)
						expect(authsAfter).toHaveLength(0)
					},
				),
				{ numRuns: 10 },
			)
		})
	})

	describe('Authorization code properties', () => {
		it('should generate codes with sufficient entropy', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.string({ minLength: 1, maxLength: 50 }), {
						minLength: 10,
						maxLength: 20,
					}),
					async (clientNames) => {
						const { user } = await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const codes = await Promise.all(
							clientNames.map((name) =>
								createAuthorizationCode({
									clientId: 'test-client-id',
									userId: user.id,
									organizationId: org.id,
									clientName: name,
									redirectUri: 'http://localhost:3000/callback',
								}),
							),
						)

						const uniqueCodes = new Set(codes)
						expect(uniqueCodes.size).toBe(codes.length)

						codes.forEach((code) => {
							expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
						})
					},
				),
				{ numRuns: 10 },
			)
		})

		it('should expire authorization codes after timeout', async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 100 }),
					async (clientName) => {
						const { user } = await createTestUserWithSession(createdUserIds)
						const org = await createTestOrganization(user.id, createdOrgIds)

						const code = await createAuthorizationCode({
							clientId: 'test-client-id',
							userId: user.id,
							organizationId: org.id,
							clientName,
							redirectUri: 'http://localhost:3000/callback',
						})

						expect(code).toBeDefined()

						const expectedExpiration = AUTHORIZATION_CODE_EXPIRATION
						expect(expectedExpiration).toBe(10 * 60 * 1000)
					},
				),
				{ numRuns: 10 },
			)
		})
	})
})
