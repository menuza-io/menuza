import type * as DatabaseModule from '@repo/database'
import { db, eq, UserOrganization } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	getUserDefaultOrganization,
	setUserDefaultOrganization,
} from './organizations.server.ts'

// On D1, `db.transaction` runs its callback with no BEGIN/COMMIT
// (`bindCloudflareD1` in packages/database/src/client.ts). Do the same here so
// overlapping requests interleave the way they do in production.
vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	const d1LikeDb = new Proxy(actual.db, {
		get(target, property) {
			if (property === 'transaction') {
				return (callback: (tx: typeof actual.db) => unknown) =>
					callback(actual.db)
			}
			return Reflect.get(target, property)
		},
	})
	return { ...actual, db: d1LikeDb }
})

async function defaultOrganizationIds(userId: string) {
	const memberships = await db
		.select({
			organizationId: UserOrganization.organizationId,
			isDefault: UserOrganization.isDefault,
		})
		.from(UserOrganization)
		.where(eq(UserOrganization.userId, userId))
	return memberships
		.filter((membership) => membership.isDefault)
		.map((membership) => membership.organizationId)
}

describe('setUserDefaultOrganization', () => {
	it('leaves exactly one default when two requests switch organizations at once', async () => {
		const user = await insertTestUser()
		const first = await createTestOrganization(user.id, 'admin')
		const second = await createTestOrganization(user.id, 'admin')

		await Promise.all([
			setUserDefaultOrganization(user.id, first.id),
			setUserDefaultOrganization(user.id, second.id),
		])

		const defaults = await defaultOrganizationIds(user.id)
		expect(defaults).toHaveLength(1)
		expect([first.id, second.id]).toContain(defaults[0])
		expect((await getUserDefaultOrganization(user.id))?.organization.id).toBe(
			defaults[0],
		)
	})

	it('clears every other default, including rows left by an earlier race', async () => {
		const user = await insertTestUser()
		await createTestOrganization(user.id, 'admin')
		await createTestOrganization(user.id, 'admin')
		const target = await createTestOrganization(user.id, 'admin')
		await db
			.update(UserOrganization)
			.set({ isDefault: true })
			.where(eq(UserOrganization.userId, user.id))

		const result = await setUserDefaultOrganization(user.id, target.id)

		expect(await defaultOrganizationIds(user.id)).toEqual([target.id])
		expect(result?.organization.id).toBe(target.id)
	})
})
