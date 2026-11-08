import { randomUUID } from 'node:crypto'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { db, eq, Role, Session, User, _RoleToUser } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { action, loader } from './system.$roleId.tsx'

async function ensureRole(name: string) {
	await db
		.insert(Role)
		.values({ name, description: `${name} role` })
		.onConflictDoNothing()
	const role = await db.query.Role.findFirst({ where: eq(Role.name, name) })
	if (!role) throw new Error(`Test role ${name} missing`)
	return role
}

async function signedInUser(roleName?: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com` })
		.returning()
	if (!user) throw new Error('Test user missing')
	if (roleName) {
		const role = await ensureRole(roleName)
		await db.insert(_RoleToUser).values({ A: role.id, B: user.id })
	}
	const [session] = await db
		.insert(Session)
		.values({ userId: user.id, expirationDate: getSessionExpirationDate() })
		.returning()
	if (!session) throw new Error('Test session missing')
	const authSession = await authSessionStorage.getSession()
	authSession.set(sessionKey, session.id)
	return { user, cookie: await authSessionStorage.commitSession(authSession) }
}

function args(roleId: string, cookie?: string, body?: Record<string, string>) {
	const url = `http://localhost:3004/roles/system/${roleId}`
	return {
		request: new Request(url, {
			headers: cookie ? { Cookie: cookie } : {},
			...(body ? { method: 'POST', body: new URLSearchParams(body) } : {}),
		}),
		params: { roleId },
		context: new RouterContextProvider(),
		url: new URL(url),
		pattern: '/roles/system/:roleId',
	} as unknown as Parameters<typeof action>[0] & Parameters<typeof loader>[0]
}

describe('system role page', () => {
	it('refuses to delete the admin role, whose id is generated', async () => {
		const { user, cookie } = await signedInUser('admin')
		const adminRole = await ensureRole('admin')
		expect(adminRole.id).not.toBe('admin')

		const result = await action(
			args(adminRole.id, cookie, { intent: 'delete-role' }),
		)

		expect(result).toMatchObject({ success: false })
		expect(
			await db.query.Role.findFirst({ where: eq(Role.id, adminRole.id) }),
		).toBeDefined()
		const holders = await db
			.select()
			.from(_RoleToUser)
			.where(eq(_RoleToUser.B, user.id))
		expect(holders).toHaveLength(1)
	})

	it.each(['admin', 'user'])('refuses to rename the %s role', async (name) => {
		const { cookie } = await signedInUser('admin')
		const role = await ensureRole(name)

		const result = await action(
			args(role.id, cookie, {
				intent: 'update-basic',
				name: `${name}-renamed`,
				description: 'Updated description',
			}),
		)

		expect(result).toMatchObject({ success: false })
		const unchanged = await db.query.Role.findFirst({
			where: eq(Role.id, role.id),
		})
		expect(unchanged?.name).toBe(name)
	})

	it('still updates the description of a core role', async () => {
		const { cookie } = await signedInUser('admin')
		const role = await ensureRole('user')

		const result = await action(
			args(role.id, cookie, {
				intent: 'update-basic',
				description: 'Every signed-up account',
			}),
		)

		expect(result).toMatchObject({ success: true })
		const updated = await db.query.Role.findFirst({
			where: eq(Role.id, role.id),
		})
		expect(updated).toMatchObject({
			name: 'user',
			description: 'Every signed-up account',
		})
	})

	it('deletes another system role and redirects to the roles list', async () => {
		const { cookie } = await signedInUser('admin')
		const custom = await ensureRole(`support-${randomUUID()}`)

		const response = await action(
			args(custom.id, cookie, { intent: 'delete-role' }),
		)

		expect(response).toBeInstanceOf(Response)
		expect((response as Response).status).toBe(302)
		expect((response as Response).headers.get('Location')).toBe('/roles')
		expect(
			await db.query.Role.findFirst({ where: eq(Role.id, custom.id) }),
		).toBeUndefined()
	})

	it('requires the admin role to load a role', async () => {
		const adminRole = await ensureRole('admin')

		const anonymous = await loader(args(adminRole.id)).catch(
			(error: unknown) => error,
		)
		expect(anonymous).toBeInstanceOf(Response)
		expect((anonymous as Response).status).toBe(302)
		expect((anonymous as Response).headers.get('Location')).toMatch(/^\/login/)

		const { cookie } = await signedInUser('user')
		await expect(loader(args(adminRole.id, cookie))).rejects.toMatchObject({
			status: 403,
		})
	})

	it('sends the holder count, not the holders', async () => {
		const { cookie } = await signedInUser('admin')
		const adminRole = await ensureRole('admin')
		const holders = await db
			.select()
			.from(_RoleToUser)
			.where(eq(_RoleToUser.A, adminRole.id))

		const data = await loader(args(adminRole.id, cookie))

		expect(data.role._count.users).toBe(holders.length)
		expect(data.role).not.toHaveProperty('roleToUsers')
		expect(data.role).not.toHaveProperty('permissionToRoles')
	})
})
