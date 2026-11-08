import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './shop.tsx'

async function load(role: 'admin' | 'member' | 'viewer' | 'guest') {
	const { organization, cookie } = await setupTestOrgWithUser(role)
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${organization.slug}/settings/shop`,
		{},
		cookie,
	)
	return loader({
		request,
		params: { orgSlug: organization.slug },
		context: {},
	} as never)
}

// Shop orders carry customer names, phones and emails, so they follow the
// Customers page rule (read:settings:any), not plain membership.
describe('shop settings orders', () => {
	it.each(['member', 'viewer', 'guest'] as const)(
		'are withheld from a %s',
		async (role) => {
			const data = await load(role)
			expect(data.ordersHidden).toBe(true)
			expect(data.orders).toEqual([])
		},
	)

	it('are offered to an admin', async () => {
		const data = await load('admin')
		expect(data.ordersHidden).toBe(false)
	})
})
