import { db, eq, Organization } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const post = vi.hoisted(() => vi.fn())
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: post,
}))
vi.mock('varlock/env', async (importOriginal) => {
	const original = await importOriginal<{ ENV: Record<string, unknown> }>()
	return {
		...original,
		ENV: new Proxy(original.ENV, {
			get: (target, key) =>
				key === 'INTERNAL_COMMAND_TOKEN'
					? 'x'.repeat(32)
					: Reflect.get(target, key),
		}),
	}
})

const { notifyReservationsContextChanged } = await import('./access.server.ts')

describe('notifyReservationsContextChanged', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('never throws into the request when the regional node is down', async () => {
		const { organization } = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		post.mockRejectedValue(new Error('connect ECONNREFUSED'))

		await expect(
			notifyReservationsContextChanged(organization.id, 'payments'),
		).resolves.toBeUndefined()
		expect(post).toHaveBeenCalledWith(
			expect.objectContaining({
				path: 'context-changed',
				body: { orgId: organization.id, reason: 'payments' },
			}),
		)
	})

	it('does nothing for an organization without a regional database', async () => {
		const { organization } = await setupTestOrgWithUser()
		await notifyReservationsContextChanged(organization.id, 'flags')
		expect(post).not.toHaveBeenCalled()
	})
})
