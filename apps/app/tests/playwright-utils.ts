import { test as base } from '@playwright/test'
import {
	authSessionStorage,
	MOCK_CODE_GITHUB_HEADER,
	normalizeEmail,
	getPasswordHash,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { cookieConsentCookie } from '@repo/common/cookie-consent'
import {
	db,
	eq,
	Password,
	Session,
	User,
	WebsitePage,
	Role,
	_RoleToUser,
	OrganizationInviteLink,
} from '@repo/database'
import { type User as UserModel } from '@repo/database/types'
import * as setCookieParser from 'set-cookie-parser'
import { createUser } from './db-utils.ts'
import {
	type GitHubUser,
	deleteGitHubUser,
	insertGitHubUser,
} from './mocks/github.ts'

export * from './db-utils.ts'

type GetOrInsertUserOptions = {
	id?: string
	username?: UserModel['username']
	password?: string
	email?: UserModel['email']
}

type User = {
	id: string
	email: string
	username: string
	name: string | null
}

async function getOrInsertUser({
	id,
	username,
	password,
	email,
}: GetOrInsertUserOptions = {}): Promise<User> {
	if (id) {
		const [user] = await db
			.select({
				id: User.id,
				email: User.email,
				username: User.username,
				name: User.name,
			})
			.from(User)
			.where(eq(User.id, id))
			.limit(1)
		if (!user) throw new Error('User not found')
		return user
	} else {
		const userData = createUser()
		username ??= userData.username
		password ??= userData.username
		email ??= userData.email
		const [user] = await db
			.insert(User)
			.values({
				...userData,
				email,
				username,
			})
			.returning({
				id: User.id,
				email: User.email,
				username: User.username,
				name: User.name,
			})
		if (!user) throw new Error('Failed to create user')
		const [role] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (role) await db.insert(_RoleToUser).values({ A: role.id, B: user.id })
		await db
			.insert(Password)
			.values({ userId: user.id, hash: await getPasswordHash(password) })
		return user
	}
}

async function setCookieConsent(page: any, hasConsented: boolean = true) {
	const cookieValue = await cookieConsentCookie.serialize({ hasConsented })
	const cookieConfig = setCookieParser.parseString(cookieValue)
	const newConfig = {
		name: cookieConfig.name,
		value: cookieConfig.value,
		domain: 'localhost',
		path: cookieConfig.path,
		expires: cookieConfig.expires?.getTime(),
		sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
	}
	await page.context().addCookies([newConfig])
}

async function deleteTestUser(userId: string | undefined) {
	if (!userId) return

	await db.delete(WebsitePage).where(eq(WebsitePage.createdById, userId))
	await db
		.delete(OrganizationInviteLink)
		.where(eq(OrganizationInviteLink.createdById, userId))
	await db.delete(User).where(eq(User.id, userId))
}

type Navigate = (
	route: string,
	params?: Record<string, string | number>,
) => ReturnType<(typeof base.extend<any>)['prototype']['page']['goto']>

export const test = base.extend<{
	insertNewUser(options?: GetOrInsertUserOptions): Promise<User>
	login(options?: GetOrInsertUserOptions): Promise<User>
	prepareGitHubUser(): Promise<GitHubUser>
	navigate: Navigate
}>({
	page: async ({ page }, use) => {
		// Set cookie consent for all tests to prevent the banner from blocking interactions
		await setCookieConsent(page)
		// Abort SSE stream to prevent networkidle from hanging globally in all E2E tests
		await page.route('**/api/notifications/stream*', (route) =>
			route.abort().catch(() => {}),
		)
		await use(page)
	},
	// oxlint-disable-next-line no-empty-pattern
	insertNewUser: async ({}, use) => {
		let userId: string | undefined = undefined
		await use(async (options) => {
			const user = await getOrInsertUser(options)
			userId = user.id
			return user
		})
		await deleteTestUser(userId).catch(() => {})
	},
	login: async ({ page }, use) => {
		let userId: string | undefined = undefined
		await use(async (options) => {
			const user = await getOrInsertUser(options)
			userId = user.id
			const [session] = await db
				.insert(Session)
				.values({
					expirationDate: getSessionExpirationDate(),
					userId: user.id,
				})
				.returning({ id: Session.id })
			if (!session) throw new Error('Failed to create test session')

			const authSession = await authSessionStorage.getSession()
			authSession.set(sessionKey, session.id)
			const cookieConfig = setCookieParser.parseString(
				await authSessionStorage.commitSession(authSession),
			)
			const newConfig = {
				name: cookieConfig.name,
				value: cookieConfig.value,
				domain: 'localhost',
				path: cookieConfig.path,
				expires: cookieConfig.expires?.getTime(),
				sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
			}
			await page.context().addCookies([newConfig])
			await setCookieConsent(page)
			return user
		})
		await deleteTestUser(userId)
	},
	prepareGitHubUser: async ({ page }, use, testInfo) => {
		await page.route(/\/auth\/github(?!\/callback)/, async (route, request) => {
			const headers = {
				...request.headers(),
				[MOCK_CODE_GITHUB_HEADER]: testInfo.testId,
			}
			await route.continue({ headers })
		})

		let ghUser: GitHubUser | null = null
		await use(async () => {
			const newGitHubUser = await insertGitHubUser(testInfo.testId)!
			ghUser = newGitHubUser
			return newGitHubUser
		})

		const [user] = await db
			.select({ id: User.id, name: User.name })
			.from(User)
			.where(eq(User.email, normalizeEmail(ghUser!.primaryEmail)))
			.limit(1)
		if (user) {
			await deleteTestUser(user.id)
		}
		await deleteGitHubUser(ghUser!.primaryEmail)
	},
	navigate: async ({ page }, use) => {
		await use((route, params) => {
			let path = route
			if (params) {
				for (const [key, value] of Object.entries(params)) {
					path = path.replace(`:${key}`, String(value))
				}
			}
			return page.goto(path)
		})
	},
})
export const { expect } = test

/**
 * This allows you to wait for something (like an email to be available).
 *
 * It calls the callback every 50ms until it returns a value (and does not throw
 * an error). After the timeout, it will throw the last error that was thrown or
 * throw the error message provided as a fallback
 */
export async function waitFor<ReturnValue>(
	cb: () => ReturnValue | Promise<ReturnValue>,
	{
		errorMessage,
		timeout = 5000,
	}: { errorMessage?: string; timeout?: number } = {},
) {
	const endTime = Date.now() + timeout
	let lastError: unknown = new Error(errorMessage)
	while (Date.now() < endTime) {
		try {
			const response = await cb()
			if (response) return response
		} catch (e: unknown) {
			lastError = e
		}
		await new Promise((r) => setTimeout(r, 100))
	}
	throw lastError
}
