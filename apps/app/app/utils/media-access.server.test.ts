import {
	db,
	eq,
	Organization,
	OrganizationMediaAsset,
	User,
	UserOrganization,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	authorizeRegisteredObject,
	requireOrganizationMember,
} from './media-access.server.ts'

const getUserId = vi.hoisted(() => vi.fn())
vi.mock('@repo/auth', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getUserId,
}))

const request = new Request('https://app.example.test/resources/videos/source')

async function seed(source = 'library', storageScope = 'organization') {
	const id = Math.random().toString(36).slice(2, 10)
	const [user] = await db
		.insert(User)
		.values({
			id: `u-${id}`,
			email: `${id}@example.com`,
			username: `u-${id}`,
			name: 'M',
		})
		.returning()
	const [org] = await db
		.insert(Organization)
		.values({ id: `o-${id}`, name: `Org ${id}`, slug: `org-${id}` })
		.returning()
	await db.insert(UserOrganization).values({
		userId: user!.id,
		organizationId: org!.id,
		organizationRoleId: 'org_role_member',
		active: true,
	})
	const objectKey = `orgs/${org!.id}/media/videos/${id}-aaaaaaaaaaaa.mp4`
	await db.insert(OrganizationMediaAsset).values({
		organizationId: org!.id,
		objectKey,
		storageScope,
		mimeType: 'video/mp4',
		source,
	})
	return { user: user!, org: org!, objectKey }
}

async function status(promise: Promise<unknown>) {
	try {
		await promise
		return 200
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

describe('registered object authorization', () => {
	beforeEach(() => getUserId.mockReset())

	it('returns null for an unregistered key', async () => {
		expect(
			await authorizeRegisteredObject(request, 'users/x/unknown-key.mp4'),
		).toBeNull()
	})

	it('serves a public branding asset to anyone', async () => {
		const { objectKey, org } = await seed('website-asset')
		getUserId.mockResolvedValue(null)
		expect(await authorizeRegisteredObject(request, objectKey)).toEqual({
			isPublic: true,
			organizationId: org.id,
		})
	})

	it('requires a login for a private asset', async () => {
		const { objectKey } = await seed()
		getUserId.mockResolvedValue(null)
		expect(await status(authorizeRegisteredObject(request, objectKey))).toBe(
			401,
		)
	})

	it('refuses a signed-in user from another organization', async () => {
		const { objectKey } = await seed()
		const other = await seed()
		getUserId.mockResolvedValue(other.user.id)
		expect(await status(authorizeRegisteredObject(request, objectKey))).toBe(
			403,
		)
	})

	it('allows an active member and scopes storage to the asset organization', async () => {
		const { objectKey, user, org } = await seed()
		getUserId.mockResolvedValue(user.id)
		expect(await authorizeRegisteredObject(request, objectKey)).toEqual({
			isPublic: false,
			organizationId: org.id,
		})
	})

	it('refuses a deactivated member and a banned user', async () => {
		const { objectKey, user, org } = await seed()
		getUserId.mockResolvedValue(user.id)
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, user.id))
		expect(await status(authorizeRegisteredObject(request, objectKey))).toBe(
			403,
		)
		await db
			.update(UserOrganization)
			.set({ active: true })
			.where(eq(UserOrganization.userId, user.id))
		await db.update(User).set({ isBanned: true }).where(eq(User.id, user.id))
		expect(await status(requireOrganizationMember(request, org.id))).toBe(403)
	})

	it('applies the strictest row when a key is registered more than once', async () => {
		const { objectKey } = await seed('website-asset')
		const other = await seed()
		await db.insert(OrganizationMediaAsset).values({
			organizationId: other.org.id,
			objectKey,
			mimeType: 'video/mp4',
			source: 'library',
		})
		getUserId.mockResolvedValue(null)
		expect(await status(authorizeRegisteredObject(request, objectKey))).toBe(
			401,
		)
	})
})
