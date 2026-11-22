import { describe, expect, it } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { createAuthenticatedRequest } from '#tests/test-utils.ts'
import { requireMediaRestyleAccess } from './access.server.ts'

async function statusOf(promise: Promise<unknown>) {
	try {
		await promise
		return 200
	} catch (thrown) {
		if (thrown instanceof Response) return thrown.status
		throw thrown
	}
}

function request(cookie: string, orgSlug: string) {
	return createAuthenticatedRequest(
		`http://localhost/${orgSlug}/media/restyle`,
		{},
		cookie,
	)
}

describe('requireMediaRestyleAccess (#146)', () => {
	it('is 404 while media.restyle is off, for every kind', async () => {
		const ctx = await setupSeoOrganization()
		for (const kind of ['view', 'start', 'apply'] as const) {
			expect(
				await statusOf(
					requireMediaRestyleAccess(
						request(ctx.cookie, ctx.organization.slug),
						ctx.organization.slug,
						kind,
					),
				),
			).toBe(404)
		}
	})

	it('lets a member with the permissions in once the flag is on', async () => {
		const ctx = await setupSeoOrganization()
		await setOrgFlag(ctx.organization.id, 'media.restyle', true)
		for (const kind of ['view', 'start', 'apply'] as const) {
			const access = await requireMediaRestyleAccess(
				request(ctx.cookie, ctx.organization.slug),
				ctx.organization.slug,
				kind,
			)
			expect(access.organization.id).toBe(ctx.organization.id)
			expect(access.userId).toBe(ctx.userId)
		}
	})

	it('is 401 for a signed-out caller and 404 for a non-member', async () => {
		const ctx = await setupSeoOrganization()
		await setOrgFlag(ctx.organization.id, 'media.restyle', true)
		const outsider = await setupSeoOrganization()
		expect(
			await statusOf(
				requireMediaRestyleAccess(
					new Request(
						`http://localhost/${ctx.organization.slug}/media/restyle`,
					),
					ctx.organization.slug,
					'view',
				),
			),
		).toBeGreaterThanOrEqual(300)
		expect(
			await statusOf(
				requireMediaRestyleAccess(
					request(outsider.cookie, ctx.organization.slug),
					ctx.organization.slug,
					'view',
				),
			),
		).toBe(404)
	})

	it('is 403 for a member without the media permission', async () => {
		const ctx = await setupSeoOrganization('viewer')
		await setOrgFlag(ctx.organization.id, 'media.restyle', true)
		expect(
			await statusOf(
				requireMediaRestyleAccess(
					request(ctx.cookie, ctx.organization.slug),
					ctx.organization.slug,
					'view',
				),
			),
		).toBe(403)
	})
})
