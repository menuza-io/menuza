import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import {
	ConfigFlag,
	db,
	eq,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { action } from './feature-flags.tsx'

async function setup() {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	await db
		.insert(Role)
		.values({ name: 'admin', description: 'admin role' })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, 'admin') })
	await db.insert(_RoleToUser).values({ A: role!.id, B: user!.id })
	const [session] = await db
		.insert(Session)
		.values({ userId: user!.id, expirationDate: getSessionExpirationDate() })
		.returning()
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session!.id)
	const cookie = await authSessionStorage.commitSession(authSession)

	return async (body: Record<string, string>) => {
		const url = 'http://localhost:3004/feature-flags'
		return (await action({
			request: new Request(url, {
				method: 'POST',
				headers: { Cookie: cookie },
				body: new URLSearchParams(body),
			}),
			params: {},
			context: new RouterContextProvider(),
			url: new URL(url),
			pattern: '/feature-flags',
		} as unknown as Parameters<typeof action>[0])) as Response
	}
}

describe('feature flag action', () => {
	it('turns a boolean flag off as the edit dialog submits it', async () => {
		const post = await setup()
		const key = `flag.${randomUUID()}`
		const [flag] = await db
			.insert(ConfigFlag)
			.values({ key, value: true, level: 'system' })
			.returning()

		const response = await post({
			_action: 'update',
			id: flag!.id,
			key,
			level: 'system',
			type: 'boolean',
			value: 'off',
		})

		expect(response.status).toBe(200)
		const [saved] = await db
			.select()
			.from(ConfigFlag)
			.where(eq(ConfigFlag.id, flag!.id))
		expect(saved).toMatchObject({ key, value: false })
	})
})
