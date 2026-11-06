import { invariant } from '@epic-web/invariant'
import { faker } from '@faker-js/faker'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	Organization,
	OrganizationRole,
	User,
	UserOrganization,
	Session,
	db,
	eq,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { serverBuildContext } from '#app/server-context.ts'
import { ssoAuthService } from '#app/utils/sso/auth.server.ts'
import { ssoConfigurationService } from '#app/utils/sso/configuration.server.ts'
import { createUser } from '#tests/db-utils.ts'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { BASE_URL, convertSetCookieToCookie } from '#tests/utils.ts'
import { loader } from './auth.sso.$organizationSlug.callback.ts'

// Mock context helper for tests
const createMockContext = () => {
	const ctx = new RouterContextProvider()
	ctx.set(serverBuildContext, {} as any)
	return ctx
}

// Generate unique slug per test run to avoid conflicts with parallel tests
const TEST_ORG_SLUG = `test-org-callback-${Date.now()}-${Math.random().toString(36).substring(7)}`
const ROUTE_PATH = `/auth/sso/${TEST_ORG_SLUG}/callback`
const PARAMS = { organizationSlug: TEST_ORG_SLUG }

// Mock the SSO services
vi.mock('#app/utils/sso/auth.server.ts', () => ({
	ssoAuthService: {
		handleCallback: vi.fn(),
		getProvisionedUser: vi.fn(),
		createSSOSession: vi.fn(),
	},
}))

vi.mock('#app/utils/sso/configuration.server.ts', () => ({
	ssoConfigurationService: {
		getConfiguration: vi.fn(),
	},
}))

let testOrganization: any
let testSSOConfig: any

beforeEach(async () => {
	// Create test organization with unique slug
	;[testOrganization] = await db
		.insert(Organization)
		.values({
			name: 'Test Organization',
			slug: TEST_ORG_SLUG,
			description: 'Test organization for SSO',
		})
		.returning()

	// Create test SSO configuration
	testSSOConfig = {
		id: faker.string.uuid(),
		organizationId: testOrganization.id,
		providerName: 'Test OIDC Provider',
		issuerUrl: 'https://test-provider.example.com',
		clientId: 'test-client-id',
		clientSecret: 'encrypted-secret',
		scopes: 'openid email profile',
		isEnabled: true,
		autoProvision: true,
		defaultRole: 'member',
		attributeMapping: null,
	}

	// Setup default mocks
	vi.mocked(ssoConfigurationService.getConfiguration).mockResolvedValue(
		testSSOConfig,
	)
})

afterEach(async () => {
	// Clean up test data by specific ID to avoid affecting parallel tests
	if (testOrganization?.id) {
		await db
			.delete(Organization)
			.where(eq(Organization.id, testOrganization.id))
	}
	vi.clearAllMocks()
})

test('successful SSO authentication creates session for existing user', async () => {
	const userData = createUser()
	const [existingUser] = await db.insert(User).values(userData).returning()
	if (!existingUser) throw new Error('Failed to insert user')

	// Add user to organization
	let [memberRole] = await db
		.select()
		.from(OrganizationRole)
		.where(eq(OrganizationRole.name, 'member'))
		.limit(1)
	if (!memberRole) {
		;[memberRole] = await db
			.insert(OrganizationRole)
			.values({
				id: 'org_role_member',
				name: 'member',
				description: 'Member role',
				level: 3,
			})
			.returning()
	}
	invariant(memberRole, 'Member role should exist')

	await db.insert(UserOrganization).values({
		userId: existingUser.id,
		organizationId: testOrganization.id,
		organizationRoleId: memberRole.id,
	})

	const mockProviderUser = {
		id: faker.string.uuid(),
		email: userData.email,
		username: userData.username,
		name: userData.name,
		tokens: {
			accessToken: 'mock-access-token',
			refreshToken: 'mock-refresh-token',
			idToken: 'mock-id-token',
			expiresAt: new Date(Date.now() + 3600000),
			scope: ['openid', 'email', 'profile'],
		},
	}

	vi.mocked(ssoAuthService.handleCallback).mockResolvedValue(mockProviderUser)
	vi.mocked(ssoAuthService.getProvisionedUser).mockResolvedValue(existingUser)
	vi.mocked(ssoAuthService.createSSOSession).mockResolvedValue({} as any)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any)

	expect(response).toHaveRedirect('/')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'Welcome!',
			type: 'success',
		}),
	)
	await expect(response).toHaveSessionForUser(existingUser.id)

	// Verify SSO session was created
	expect(ssoAuthService.createSSOSession).toHaveBeenCalledWith(
		expect.any(String),
		testSSOConfig.id,
		mockProviderUser.id,
		mockProviderUser.tokens,
	)
})

test('successful SSO authentication with auto-provisioning creates new user', async () => {
	const newUserData = {
		id: faker.string.uuid(),
		email: faker.internet.email(),
		username: faker.internet.username(),
		name: faker.person.fullName(),
	}

	const [createdUser] = await db
		.insert(User)
		.values({
			...createUser(),
			email: newUserData.email,
			username: newUserData.username,
			name: newUserData.name,
		})
		.returning()
	if (!createdUser) throw new Error('Failed to insert user')

	const mockProviderUser = {
		id: faker.string.uuid(),
		email: newUserData.email,
		username: newUserData.username,
		name: newUserData.name,
		tokens: {
			accessToken: 'mock-access-token',
			refreshToken: 'mock-refresh-token',
			idToken: 'mock-id-token',
			expiresAt: new Date(Date.now() + 3600000),
			scope: ['openid', 'email', 'profile'],
		},
	}

	vi.mocked(ssoAuthService.handleCallback).mockResolvedValue(mockProviderUser)
	vi.mocked(ssoAuthService.getProvisionedUser).mockResolvedValue(createdUser)
	vi.mocked(ssoAuthService.createSSOSession).mockResolvedValue({} as any)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any)

	expect(response).toHaveRedirect('/')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'Welcome!',
			description: 'Your account has been created and you are now logged in.',
			type: 'success',
		}),
	)
	await expect(response).toHaveSessionForUser(createdUser.id)

	// The user handleCallback provisioned is loaded by the id it returned.
	expect(ssoAuthService.getProvisionedUser).toHaveBeenCalledWith(
		String(mockProviderUser.id),
	)
})

test('handles organization not found', async () => {
	const request = await setupRequest()
	const response = await loader({
		request,
		params: { organizationSlug: 'non-existent-org' },
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any).catch((e) => e)

	invariant(response instanceof Response, 'response should be a Response')
	expect(response).toHaveRedirect('/login')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'Organization Not Found',
			type: 'error',
		}),
	)
})

test('handles SSO not configured for organization', async () => {
	vi.mocked(ssoConfigurationService.getConfiguration).mockResolvedValue(null)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any).catch((e) => e)

	invariant(response instanceof Response, 'response should be a Response')
	expect(response).toHaveRedirect('/login')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'SSO Not Available',
			type: 'error',
		}),
	)
})

test('handles SSO disabled for organization', async () => {
	vi.mocked(ssoConfigurationService.getConfiguration).mockResolvedValue({
		...testSSOConfig,
		isEnabled: false,
	})

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any).catch((e) => e)

	invariant(response instanceof Response, 'response should be a Response')
	expect(response).toHaveRedirect('/login')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'SSO Not Available',
			type: 'error',
		}),
	)
})

test('handles OAuth callback failure', async () => {
	consoleError.mockImplementation(() => {})

	vi.mocked(ssoAuthService.handleCallback).mockRejectedValue(
		new Error('OAuth callback failed'),
	)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any).catch((e) => e)

	invariant(response instanceof Response, 'response should be a Response')
	expect(response).toHaveRedirect('/login')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'SSO Authentication Failed',
			type: 'error',
		}),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'SSO authentication failed:',
		expect.any(Error),
	)
})

test('handles user provisioning failure', async () => {
	consoleError.mockImplementation(() => {})

	const mockProviderUser = {
		id: faker.string.uuid(),
		email: faker.internet.email(),
		username: faker.internet.username(),
		name: faker.person.fullName(),
	}

	vi.mocked(ssoAuthService.handleCallback).mockResolvedValue(mockProviderUser)
	vi.mocked(ssoAuthService.getProvisionedUser).mockRejectedValue(
		new Error('User provisioning failed: auto-provisioning disabled'),
	)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any).catch((e) => e)

	invariant(response instanceof Response, 'response should be a Response')
	expect(response).toHaveRedirect('/login')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'User Provisioning Failed',
			description: 'User provisioning failed: auto-provisioning disabled',
			type: 'error',
		}),
	)
	expect(consoleError).toHaveBeenCalledWith(
		'User provisioning failed:',
		expect.any(Error),
	)
})

test('handles user already logged in', async () => {
	const session = await setupUser()

	// Mock the SSO service methods even though they won't be called
	vi.mocked(ssoAuthService.handleCallback).mockResolvedValue({
		id: faker.string.uuid(),
		email: faker.internet.email(),
		username: faker.internet.username(),
		name: faker.person.fullName(),
	})

	const request = await setupRequest({ sessionId: session.id })
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any)

	expect(response).toHaveRedirect('/settings/profile')
	await expect(response).toSendToast(
		expect.objectContaining({
			title: 'Already Authenticated',
			description: 'You are already logged in.',
		}),
	)
})

test('handles banned user login attempt', async () => {
	const userData = createUser()
	const [bannedUser] = await db
		.insert(User)
		.values({
			...userData,
			isBanned: true,
			banReason: 'Test ban',
		})
		.returning()
	if (!bannedUser) throw new Error('Failed to insert user')

	const mockProviderUser = {
		id: faker.string.uuid(),
		email: userData.email,
		username: userData.username,
		name: userData.name,
	}

	vi.mocked(ssoAuthService.handleCallback).mockResolvedValue(mockProviderUser)
	vi.mocked(ssoAuthService.getProvisionedUser).mockResolvedValue(bannedUser)

	const request = await setupRequest()
	const response = await loader({
		request,
		params: PARAMS,
		context: createMockContext(),
		url: request.url,
		pattern: '*',
	} as any)

	expect(response).toHaveRedirect('/login?banned=true')
})

async function setupRequest({
	sessionId,
	code = faker.string.uuid(),
	state = faker.string.uuid(),
}: { sessionId?: string; code?: string; state?: string } = {}) {
	const url = new URL(ROUTE_PATH, BASE_URL)
	url.searchParams.set('state', state)
	url.searchParams.set('code', code)

	const authSession = await authSessionStorage.getSession()
	if (sessionId) authSession.set(sessionKey, sessionId)

	const setSessionCookieHeader =
		await authSessionStorage.commitSession(authSession)

	const request = new Request(url.toString(), {
		method: 'GET',
		headers: {
			cookie: convertSetCookieToCookie(setSessionCookieHeader),
		},
	})

	return request
}

async function setupUser(userData = createUser()) {
	const [user] = await db.insert(User).values(userData).returning()
	if (!user) throw new Error('Failed to insert user')
	const [session] = await db
		.insert(Session)
		.values({
			expirationDate: getSessionExpirationDate(),
			userId: user.id,
		})
		.returning({ id: Session.id, userId: Session.userId })

	if (!session) throw new Error('Failed to insert session')

	return session
}
