import { faker } from '@faker-js/faker'
import { authSessionStorage, getPasswordHash, sessionKey } from '@repo/auth'
import {
	db,
	eq,
	Organization,
	OrganizationNote,
	Password,
	Role,
	Session,
	User,
	UserOrganization,
	Verification,
	_RoleToUser,
} from '@repo/database'
import { getSessionExpirationDate } from '#app/utils/auth.server.ts'
import { createUser } from './db-utils.ts'

import { convertSetCookieToCookie } from './utils.ts'

export async function createTestUser({
	username,
	email,
	name,
	password = 'testpassword123',
	role = 'user',
}: {
	username?: string
	email?: string
	name?: string
	password?: string
	role?: 'admin' | 'user'
} = {}) {
	const userData = createUser()
	const finalUsername = username ?? userData.username
	const finalEmail = (email ?? `${finalUsername}@example.com`).toLowerCase()
	const finalName = name ?? userData.name

	const hashedPassword = await getPasswordHash(password)

	const [user] = await db
		.insert(User)
		.values({
			email: finalEmail,
			username: finalUsername.toLowerCase(),
			name: finalName,
		})
		.returning()
	if (!user) throw new Error('Failed to create test user')

	await db.insert(Password).values({
		userId: user.id,
		hash: hashedPassword,
	})

	let [roleRecord] = await db
		.select({ id: Role.id })
		.from(Role)
		.where(eq(Role.name, role))
		.limit(1)

	if (!roleRecord) {
		;[roleRecord] = await db
			.insert(Role)
			.values({
				name: role,
				description: `${role} role`,
			})
			.returning({ id: Role.id })
	}

	if (roleRecord) {
		await db
			.insert(_RoleToUser)
			.values({ A: roleRecord.id, B: user.id })
			.onConflictDoNothing()
	}

	return { ...user, password }
}

export async function createTestSession(userId: string, remember = false) {
	const expirationDate = getSessionExpirationDate(remember)
	const [session] = await db
		.insert(Session)
		.values({
			userId,
			expirationDate,
		})
		.returning()
	if (!session) throw new Error('Failed to create test session')

	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session.id)
	const cookieHeader = await authSessionStorage.commitSession(authSession, {
		expires: remember ? expirationDate : undefined,
	})
	const cookie = convertSetCookieToCookie(cookieHeader)

	return { session, cookie, cookieHeader }
}

export function createAuthenticatedRequest(
	url: string,
	options: RequestInit = {},
	cookie: string,
) {
	const headers = new Headers(options.headers)
	headers.set('Cookie', cookie)
	return new Request(url, { ...options, headers })
}

export function getResponseHeaders(response: any): Headers {
	if (response instanceof Response) {
		return response.headers
	}
	if (response?.init?.headers) {
		return new Headers(response.init.headers)
	}
	return new Headers()
}

export function getResponseStatus(response: any): number {
	if (response instanceof Response) {
		return response.status
	}
	return response?.init?.status ?? 200
}

export async function createTestOrganization(
	userId: string,
	role: 'admin' | 'member' | 'viewer' | 'guest' = 'admin',
) {
	const name = faker.company.name()
	const [organization] = await db
		.insert(Organization)
		.values({
			name,
			slug: `${faker.helpers.slugify(name).toLowerCase()}-${Date.now()}-${faker.string.alphanumeric(4).toLowerCase()}`,
			description: faker.company.catchPhrase(),
		})
		.returning()
	if (!organization) throw new Error('Failed to create test organization')
	await db.insert(UserOrganization).values({
		userId,
		organizationId: organization.id,
		organizationRoleId: `org_role_${role}`,
	})
	return organization
}

export async function setupTestOrgWithUser(
	role: 'admin' | 'member' | 'viewer' | 'guest' = 'admin',
) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, role)
	const { session, cookie, cookieHeader } = await createTestSession(user.id)
	return { user, organization, session, cookie, cookieHeader }
}

export async function createTestOrganizationWithMultipleUsers(
	users: Array<{
		userId: string
		role?: 'admin' | 'member' | 'viewer' | 'guest'
	}>,
) {
	const organization = await createTestOrganization(
		users[0]?.userId ?? '',
		users[0]?.role ?? 'member',
	)
	if (users.length > 1) {
		await db.insert(UserOrganization).values(
			users.slice(1).map((user) => ({
				userId: user.userId,
				organizationId: organization.id,
				organizationRoleId: `org_role_${user.role || 'member'}`,
			})),
		)
	}
	return organization
}

export async function createTestNote(
	orgId: string,
	userId: string,
	overrides: {
		title?: string
		content?: string
		isPublic?: boolean
	} = {},
) {
	const [note] = await db
		.insert(OrganizationNote)
		.values({
			organizationId: orgId,
			createdById: userId,
			title: overrides.title ?? faker.lorem.sentence(),
			content: overrides.content ?? faker.lorem.paragraphs(),
			isPublic: overrides.isPublic ?? true,
		})
		.returning()
	if (!note) throw new Error('Failed to create test note')
	return note
}

export async function enableTwoFactor(userId: string) {
	const [verification] = await db
		.insert(Verification)
		.values({
			type: '2fa',
			target: userId,
			secret: 'two-factor-otp-secret',
			algorithm: 'SHA-1',
			digits: 6,
			period: 30,
			charSet: '0123456789',
			expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		})
		.returning()
	return verification
}

export async function addOrganizationMember(
	userId: string,
	organizationId: string,
	roleId: string = 'org_role_member',
) {
	const [member] = await db
		.insert(UserOrganization)
		.values({
			userId,
			organizationId,
			organizationRoleId: roleId,
			active: true,
		})
		.returning()
	return member
}
