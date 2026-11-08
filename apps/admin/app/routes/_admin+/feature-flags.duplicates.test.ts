import { randomUUID } from 'node:crypto'
import { auditService } from '@repo/audit'
import {
	authSessionStorage,
	getSessionExpirationDate,
	sessionKey,
} from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	ConfigFlag,
	db,
	eq,
	Organization,
	Role,
	Session,
	User,
	_RoleToUser,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './feature-flags.tsx'

beforeEach(() => {
	vi.restoreAllMocks()
})

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
	const [organization] = await db
		.insert(Organization)
		.values({ name: `Org ${id.slice(0, 6)}`, slug: `org-${id}` })
		.returning()

	const post = async (body: Record<string, string>) => {
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
	return { post, organizationId: organization!.id, adminId: user!.id }
}

describe('organization feature flags', () => {
	it('creating an existing organization flag updates it instead of adding a duplicate', async () => {
		const { post, organizationId } = await setup()
		const key = `flag.${randomUUID()}`
		const create = (value: string) =>
			post({
				_action: 'create',
				key,
				value,
				type: 'string',
				level: 'organization',
				organizationId,
			})

		// Concurrent creates both pass a check-then-insert.
		await Promise.all([create('a'), create('b')])
		await create('c')

		const rows = await db
			.select()
			.from(ConfigFlag)
			.where(eq(ConfigFlag.key, key))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.value).toBe('c')
		expect(await getFeatureFlag(key, { organizationId })).toBe('c')
	})

	it('the database keeps one row per key and scope, NULL scopes included', async () => {
		const { organizationId } = await setup()
		const key = `flag.${randomUUID()}`
		await db.insert(ConfigFlag).values([
			{ key, level: 'organization', organizationId, value: 'a' },
			{ key, level: 'system', value: 'a' },
		])
		await expect(
			db
				.insert(ConfigFlag)
				.values({ key, level: 'organization', organizationId, value: 'b' }),
		).rejects.toThrow()
		await expect(
			db.insert(ConfigFlag).values({ key, level: 'system', value: 'b' }),
		).rejects.toThrow()
		expect(await getFeatureFlag(key, { organizationId })).toBe('a')
	})

	it('audits flag changes', async () => {
		const log = vi.spyOn(auditService, 'logAdminOperation')
		const { post, organizationId, adminId } = await setup()
		const key = `flag.${randomUUID()}`
		await post({
			_action: 'create',
			key,
			value: 'on',
			type: 'boolean',
			level: 'organization',
			organizationId,
		})
		expect(log).toHaveBeenCalledWith(
			'admin_config_changed',
			adminId,
			expect.stringContaining(key),
			expect.objectContaining({ key, organizationId, value: true }),
			expect.any(Request),
		)
	})
})
