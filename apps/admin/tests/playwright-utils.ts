import { test as base } from '@playwright/test'
import {
	authSessionStorage,
	getPasswordHash,
	getSessionExpirationDate,
	MOCK_CODE_GITHUB_HEADER,
	normalizeEmail,
	sessionKey,
} from '@repo/auth'
import { cookieConsentCookie } from '@repo/common/cookie-consent'
import {
	Password,
	Role,
	Session,
	User as UserTable,
	_RoleToUser,
	db,
	eq,
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
				id: UserTable.id,
				email: UserTable.email,
				username: UserTable.username,
				name: UserTable.name,
			})
			.from(UserTable)
			.where(eq(UserTable.id, id))
			.limit(1)
		if (!user) throw new Error(`User ${id} not found`)
		return user
	} else {
		const userData = createUser()
		username ??= userData.username
		password ??= userData.username
		email ??= userData.email
		const [user] = await db
			.insert(UserTable)
			.values({
				...userData,
				email,
				username,
			})
			.returning({
				id: UserTable.id,
				email: UserTable.email,
				username: UserTable.username,
				name: UserTable.name,
			})
		const [role] = await db
			.select({ id: Role.id })
			.from(Role)
			.where(eq(Role.name, 'user'))
			.limit(1)
		if (!user || !role) throw new Error('Could not create test user')
		await db.insert(_RoleToUser).values({ A: role.id, B: user.id })
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
		path: cookieConfig.path,
		domain: 'localhost',
		expires: cookieConfig.expires?.getTime(),
		sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
	}
	await page.context().addCookies([newConfig])
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
		if (userId) {
			await db
				.delete(UserTable)
				.where(eq(UserTable.id, userId))
				.catch(() => {})
		}
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
			if (!session) throw new Error('Could not create test session')

			const authSession = await authSessionStorage.getSession()
			authSession.set(sessionKey, session.id)
			const cookieConfig = setCookieParser.parseString(
				await authSessionStorage.commitSession(authSession),
			)
			const newConfig = {
				...cookieConfig,
				domain: 'localhost',
				expires: cookieConfig.expires?.getTime(),
				sameSite: cookieConfig.sameSite as 'Strict' | 'Lax' | 'None',
			}
			await page.context().addCookies([newConfig])
			await setCookieConsent(page)
			return user
		})
		if (userId) {
			await db.delete(UserTable).where(eq(UserTable.id, userId))
		}
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
			.select({ id: UserTable.id, name: UserTable.name })
			.from(UserTable)
			.where(eq(UserTable.email, normalizeEmail(ghUser!.primaryEmail)))
			.limit(1)
		if (user) {
			await db.delete(UserTable).where(eq(UserTable.id, user.id))
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
