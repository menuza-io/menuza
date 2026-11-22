/**
 * The public menu payload on the real database: a dish photo changed outside
 * the web form (the phone app) shows up for guests; a focal point rides with
 * its photo (#394); photo B of a test reaches only the web and QR menus (#192).
 */
import {
	db,
	eq,
	OrganizationMediaAsset,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { replaceDishMainPhoto } from './dish-photo.server.ts'
import { startPhotoTest } from './photo-tests.server.ts'
import { buildPublicSiteMenuPayload } from './public-menu-context.server.ts'

vi.stubEnv('TENANT_OPERATOR_TOKEN', 'operator-secret-operator-secret-1234')

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => undefined),
}))

async function asset(
	organizationId: string,
	values: Record<string, unknown> = {},
) {
	const [row] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`,
			mimeType: 'image/jpeg',
			...values,
		})
		.returning()
	return row!
}

async function publishedMenu(withPhotoTestsFlag: boolean) {
	const ctx = await setupSeoOrganization()
	const organizationId = ctx.organization.id
	if (withPhotoTestsFlag)
		await setOrgFlag(organizationId, 'menu.photo_tests', true)
	const [menu] = await db
		.insert(OrganizationMenu)
		.values({ organizationId, displayName: JSON.stringify({ en: 'Menu' }) })
		.returning()
	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({ organizationId, displayName: JSON.stringify({ en: 'Mains' }) })
		.returning()
	await db
		.insert(OrganizationMenuCategoryAssignment)
		.values({ menuId: menu!.id, categoryId: category!.id, position: 0 })
	const a = await asset(organizationId, { focalX: 0, focalY: 0 })
	const b = await asset(organizationId, { focalX: 1, focalY: 0.2 })
	const [item] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Soup' }),
			price: 10,
			imageKey: a.objectKey,
			imageKeys: JSON.stringify([a.objectKey]),
		})
		.returning()
	await db
		.insert(OrganizationMenuItemCategoryAssignment)
		.values({ categoryId: category!.id, itemId: item!.id, position: 0 })
	const org = {
		id: organizationId,
		name: ctx.organization.name,
		slug: ctx.organization.slug,
		currency: 'USD',
		siteDefaultLocale: 'en',
		siteLocales: null,
		customDomain: null,
	}
	return { ...ctx, org, a, b, item: item! }
}

async function soup(
	org: Parameters<typeof buildPublicSiteMenuPayload>[0],
	channel?: 'web' | 'qr' | 'app' | 'pos',
) {
	const { payload } = await buildPublicSiteMenuPayload(org, null, { channel })
	return payload.menus
		.flatMap((menu) => menu.categories)
		.flatMap((category) => category.items)
		.find((entry) => entry.displayName.includes('Soup'))!
}

describe('public menu photos', () => {
	it('carries the focal point of the dish photo; a photo without one carries none', async () => {
		const { org, item } = await publishedMenu(false)
		const dish = await soup(org, 'web')
		expect(dish.id).toBe(item.id)
		expect(dish.imageFocal).toEqual({ x: 0, y: 0 })
		expect(dish.imageFocals).toEqual([{ x: 0, y: 0 }])

		const plain = await publishedMenu(false)
		await db
			.update(OrganizationMediaAsset)
			.set({ focalX: null, focalY: null })
			.where(eqId(plain.a.id))
		expect(await soup(plain.org, 'web')).not.toHaveProperty('imageFocal')
	})

	it('shows a photo attached outside the web form to guests', async () => {
		const { org, a, b, item, userId } = await publishedMenu(false)
		await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: b,
			details: 'phone',
		})
		const dish = await soup(org, 'web')
		expect(dish.imageUrl).toContain(`mediaId=${b.id}`)
		expect(dish.imageFocal).toEqual({ x: 1, y: 0.2 })
		// The old photo is a gallery photo behind the new main one.
		expect(dish.imageUrls[1]).toContain(`mediaId=${a.id}`)
	})

	it('photo B of a running test reaches the web and QR menus only; imageUrl stays photo A', async () => {
		const { org, a, b, item, userId } = await publishedMenu(true)
		expect(
			await startPhotoTest({
				organization: org,
				userId,
				itemId: item.id,
				assetId: b.id,
			}),
		).toMatchObject({ ok: true })
		for (const channel of ['web', 'qr'] as const) {
			const dish = await soup(org, channel)
			expect(dish.imageUrl).toContain(`mediaId=${a.id}`)
			expect(dish.photoTest).toMatchObject({
				imageUrlB: expect.stringContaining(`mediaId=${b.id}`),
				imageFocalB: { x: 1, y: 0.2 },
			})
		}
		for (const channel of ['app', 'pos', undefined] as const) {
			const dish = await soup(org, channel)
			expect(dish.imageUrl).toContain(`mediaId=${a.id}`)
			expect(dish).not.toHaveProperty('photoTest')
		}
	})
})

function eqId(id: string) {
	return eq(OrganizationMediaAsset.id, id)
}
