import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { db, eq, Role, Session, User, _RoleToUser } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { loader } from './index.tsx'

async function createUser() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	if (!user) throw new Error('Test user missing')
	return user
}

async function createSession(userId: string, expirationDate: Date) {
	const [session] = await db
		.insert(Session)
		.values({ userId, expirationDate })
		.returning()
	if (!session) throw new Error('Test session missing')
	return session
}

async function setup() {
	const admin = await createUser()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	if (!role) throw new Error('Test role missing')
	await db.insert(_RoleToUser).values({ A: role.id, B: admin.id })
	const session = await createSession(admin.id, getSessionExpirationDate())
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session.id)
	const cookie = await authSessionStorage.commitSession(authSession)

	const url = 'http://localhost:3004/'
	return () =>
		loader({
			request: new Request(url, { headers: { Cookie: cookie } }),
			params: {},
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/',
		} as Parameters<typeof loader>[0])
}

describe('admin dashboard', () => {
	it('counts each logged-in user once, however many sessions they have', async () => {
		const load = await setup()
		const before = (await load()).metrics

		const user = await createUser()
		for (let i = 0; i < 3; i++) {
			await createSession(user.id, getSessionExpirationDate())
		}
		await createSession(user.id, new Date(Date.now() - 60_000))
		const expiredOnly = await createUser()
		await createSession(expiredOnly.id, new Date(Date.now() - 60_000))

		const after = (await load()).metrics
		expect(after.activeUsers - before.activeUsers).toBe(1)
		expect(after.activeUsers).toBeLessThanOrEqual(after.totalUsers)
	})
})
