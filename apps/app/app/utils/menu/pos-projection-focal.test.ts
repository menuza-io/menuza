/**
 * #394: a dish photo with a focal point reaches delivery platforms as a crop
 * around it; a photo without one is pushed exactly as before.
 */
import { db, OrganizationMediaAsset } from '@repo/database'
import { applyFocalCrops } from '@repo/integrations/pos/project'
import { describe, expect, it } from 'vitest'
import { setupSeoOrganization } from '#tests/seo-utils.ts'

async function asset(organizationId: string, focal: [number, number] | null) {
	const [row] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`,
			mimeType: 'image/jpeg',
			focalX: focal?.[0] ?? null,
			focalY: focal?.[1] ?? null,
		})
		.returning()
	return row!
}

const url = (id: string) => `/resources/images?mediaId=${id}&v=1`

describe('delivery menus keep the focal point in view', () => {
	it('crops around the point, and leaves other photos as they were', async () => {
		const { organization } = await setupSeoOrganization()
		const focused = await asset(organization.id, [0, 0])
		const plain = await asset(organization.id, null)
		const items = await applyFocalCrops(organization.id, [
			{ id: 'a', imageUrl: url(focused.id) },
			{ id: 'b', imageUrl: url(plain.id) },
			{ id: 'c', imageUrl: null },
			{ id: 'd', imageUrl: 'https://cdn.example/x.jpg' },
		])
		expect(items[0]!.imageUrl).toBe(
			`${url(focused.id)}&fit=cover&w=1200&h=1200&fp=0,0`,
		)
		expect(items[1]!.imageUrl).toBe(url(plain.id))
		expect(items[2]!.imageUrl).toBeNull()
		expect(items[3]!.imageUrl).toBe('https://cdn.example/x.jpg')
	})

	it("never reads another organization's focal point", async () => {
		const mine = await setupSeoOrganization()
		const theirs = await setupSeoOrganization()
		const theirPhoto = await asset(theirs.organization.id, [1, 1])
		const [item] = await applyFocalCrops(mine.organization.id, [
			{ id: 'a', imageUrl: url(theirPhoto.id) },
		])
		expect(item!.imageUrl).toBe(url(theirPhoto.id))
	})
})
