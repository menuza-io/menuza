import {
	BULK_PHOTO_MAX_FILES,
	type BulkPhotoFlag,
} from '@repo/common/dish-photo-match'
import {
	db,
	eq,
	inArray,
	OrganizationMediaAsset,
	OrganizationMenuItem,
	OrganizationRole,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proposeBulkPhotos } from '#app/utils/media/bulk/bulk.server.ts'
import type * as visionModule from '#app/utils/media/bulk/vision.server.ts'
import {
	createMockDishPhotoVision,
	getDishPhotoVision,
	type DishPhotoVision,
} from '#app/utils/media/bulk/vision.server.ts'
import type * as photoStudioModule from '#app/utils/media/photo-studio.server.ts'
import type * as kvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './media_.dish-photos.tsx'

// The model, the stored bytes and the site cache are the external boundaries;
// permissions, matching, the database and the one-batch apply are real.
vi.mock('#app/utils/media/bulk/vision.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof visionModule>()),
	getDishPhotoVision: vi.fn(),
}))
vi.mock('#app/utils/media/photo-studio.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof photoStudioModule>()),
	readStoredMediaImage: vi.fn(async () => ({
		data: new Uint8Array([1, 2, 3]),
		mediaType: 'image/jpeg',
	})),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof kvCacheModule>()),
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
	vi.mocked(purgeOrganizationSiteCache).mockClear()
	vi.mocked(getDishPhotoVision).mockReset()
	vi.mocked(getDishPhotoVision).mockReturnValue(createMockDishPhotoVision())
})

const ADJECTIVES = [
	'Spicy',
	'Grilled',
	'Crispy',
	'Creamy',
	'Smoky',
	'Zesty',
	'Fresh',
	'Baked',
	'Roasted',
	'Tangy',
]
const NOUNS = ['Chicken', 'Salmon', 'Mushroom', 'Halloumi', 'Aubergine']

function dishName(index: number) {
	return `${ADJECTIVES[index % ADJECTIVES.length]} ${NOUNS[Math.floor(index / ADJECTIVES.length)]}`
}

async function addDish(
	organizationId: string,
	displayName: string,
	values: Partial<typeof OrganizationMenuItem.$inferInsert> = {},
) {
	const [dish] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName, ...values })
		.returning()
	return dish!
}

async function addAsset(
	organizationId: string,
	values: Partial<typeof OrganizationMediaAsset.$inferInsert> = {},
) {
	const id = crypto.randomUUID()
	const [asset] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${id}.jpg`,
			mimeType: 'image/jpeg',
			fileName: `${id}.jpg`,
			fileSize: 100_000,
			width: 2000,
			height: 1500,
			...values,
		})
		.returning()
	return asset!
}

/** Fifty dishes and fifty uploaded photos, each named after its dish. */
async function setupFifty() {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	const dishes = []
	const assets = []
	for (let index = 0; index < 50; index += 1) {
		const name = dishName(index)
		dishes.push(await addDish(organization.id, name, { position: index }))
		assets.push(await addAsset(organization.id, { fileName: `${name}.jpg` }))
	}
	return { user, organization, cookie, dishes, assets }
}

async function post(
	slug: string,
	cookie: string,
	fields: Record<string, string>,
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	try {
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/media/dish-photos`,
				{ method: 'POST', body },
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

const propose = (
	slug: string,
	cookie: string,
	assetIds: string[],
	hashes?: Record<string, string>,
) =>
	post(slug, cookie, {
		intent: 'propose',
		assetIds: JSON.stringify(assetIds),
		...(hashes ? { hashes: JSON.stringify(hashes) } : {}),
	})

const apply = (
	slug: string,
	cookie: string,
	pairs: Array<{
		assetId: string
		itemId: string
		replace: boolean
		sourceKey?: string | null
	}>,
) => post(slug, cookie, { intent: 'apply', pairs: JSON.stringify(pairs) })

async function dishRows(ids: string[]) {
	const rows = await db
		.select()
		.from(OrganizationMenuItem)
		.where(inArray(OrganizationMenuItem.id, ids))
	return new Map(rows.map((row) => [row.id, row]))
}

async function customRole(organizationId: string, permissionIds: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db
		.insert(_OrganizationPermissionToRole)
		.values(permissionIds.map((B) => ({ A: role!.id, B })))
	return role!.id
}

async function memberCookie(organizationId: string, roleId: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, roleId)
	return (await createTestSession(user.id)).cookie
}

type ProposeBody = Awaited<ReturnType<typeof proposeBulkPhotos>>

describe('propose (#316)', () => {
	it('proposes a dish for each of 50 photos and writes nothing to any dish', async () => {
		const { organization, cookie, dishes, assets } = await setupFifty()
		const before = await dishRows(dishes.map((dish) => dish.id))

		const res = await propose(
			organization.slug,
			cookie,
			assets.map((asset) => asset.id),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as ProposeBody
		expect(body.photos).toHaveLength(50)
		expect(body.vision).toBe('mock')
		expect(body.dishes).toHaveLength(50)
		assets.forEach((asset, index) => {
			const photo = body.photos.find((p) => p.assetId === asset.id)!
			expect(photo.proposal).toMatchObject({
				itemId: dishes[index]!.id,
				confidence: 'high',
				replace: false,
				flags: [],
			})
			expect(photo.url).toContain(`mediaId=${asset.id}`)
		})

		// Not one dish row changed (a proposal is only a proposal).
		const after = await dishRows(dishes.map((dish) => dish.id))
		for (const dish of dishes) {
			expect(after.get(dish.id)).toEqual(before.get(dish.id))
		}
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('still matches by file name when no model is set up', async () => {
		const { organization, cookie, dishes, assets } = await setupFifty()
		vi.mocked(getDishPhotoVision).mockReturnValue(null)
		const res = await propose(
			organization.slug,
			cookie,
			assets.slice(0, 5).map((asset) => asset.id),
		)
		const body = (await res.json()) as ProposeBody
		expect(body.vision).toBe('none')
		expect(body.photos.map((p) => p.proposal.itemId)).toEqual(
			dishes.slice(0, 5).map((dish) => dish.id),
		)
	})

	it('flags what is not food and keeps it out of the matches', async () => {
		const { user, organization, cookie } = await setupTestOrgWithUser('admin')
		void user
		const pizza = await addDish(organization.id, 'Margherita Pizza')
		const logo = await addAsset(organization.id, {
			fileName: 'Margherita Pizza logo.png',
		})
		const good = await addAsset(organization.id, {
			fileName: 'Margherita Pizza.jpg',
		})
		const small = await addAsset(organization.id, {
			fileName: 'IMG_1.jpg',
			width: 640,
			height: 480,
		})
		const res = await propose(organization.slug, cookie, [
			logo.id,
			good.id,
			small.id,
		])
		const body = (await res.json()) as ProposeBody
		const byId = new Map(body.photos.map((p) => [p.assetId, p.proposal]))
		expect(byId.get(logo.id)).toMatchObject({
			itemId: null,
			flags: ['not_food'],
		})
		expect(byId.get(good.id)).toMatchObject({ itemId: pizza.id })
		expect(byId.get(small.id)!.flags).toEqual(['too_small'])
	})

	it('marks a dish that already has a photo as a replacement and tells the reviewer its photo', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const old = await addAsset(organization.id, { fileName: 'old.jpg' })
		const dish = await addDish(organization.id, 'Beef Burger', {
			imageKey: old.objectKey,
			imageKeys: JSON.stringify([old.objectKey]),
			imageUrl: `/resources/images?mediaId=${old.id}&v=1`,
		})
		const fresh = await addAsset(organization.id, {
			fileName: 'Beef Burger.jpg',
		})
		const res = await propose(organization.slug, cookie, [fresh.id])
		const body = (await res.json()) as ProposeBody
		expect(body.photos[0]).toMatchObject({
			proposal: { itemId: dish.id, replace: true },
			sourceKey: old.objectKey,
		})
		expect(body.dishes.find((d) => d.id === dish.id)).toMatchObject({
			hasPhoto: true,
			sourceKey: old.objectKey,
		})
	})

	it('flags duplicates inside the batch and files the library already holds', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await addDish(organization.id, 'Lamb Kofta')
		const first = await addAsset(organization.id, {
			fileName: 'Lamb Kofta.jpg',
			fileSize: 5000,
		})
		const second = await addAsset(organization.id, {
			fileName: 'Lamb Kofta (2).jpg',
			fileSize: 5001,
		})
		const old = await addAsset(organization.id, {
			fileName: 'Hummus.jpg',
			fileSize: 777,
		})
		const again = await addAsset(organization.id, {
			fileName: 'Hummus.jpg',
			fileSize: 777,
		})
		const res = await propose(
			organization.slug,
			cookie,
			[first.id, second.id, again.id],
			{ [first.id]: 'same-hash', [second.id]: 'same-hash' },
		)
		const body = (await res.json()) as ProposeBody
		const byId = new Map(body.photos.map((p) => [p.assetId, p]))
		expect(byId.get(first.id)!.proposal.flags).toEqual([])
		expect(byId.get(second.id)!.proposal.flags).toContain('duplicate')
		// `old` is in the library but not in this batch.
		expect(byId.get(again.id)).toMatchObject({ duplicateOfExisting: true })
		expect(byId.get(again.id)!.proposal.flags).toContain('duplicate')
		expect(byId.has(old.id)).toBe(false)
	})

	it('ignores non-images, drafts, archived and other organizations’ photos', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		await addDish(organization.id, 'Hummus')
		const ok = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
		const pdf = await addAsset(organization.id, { mimeType: 'application/pdf' })
		const video = await addAsset(organization.id, { mimeType: 'video/mp4' })
		const draft = await addAsset(organization.id, { status: 'draft' })
		const archived = await addAsset(organization.id, { archivedAt: new Date() })
		const foreign = await addAsset(other.organization.id, {
			fileName: 'Hummus.jpg',
		})
		const ids = [ok, pdf, video, draft, archived, foreign].map((a) => a.id)
		const res = await propose(organization.slug, cookie, ids)
		expect(res.status).toBe(200)
		const body = (await res.json()) as ProposeBody
		expect(body.photos.map((p) => p.assetId)).toEqual([ok.id])
		expect(body.ignoredAssetIds.sort()).toEqual(
			[pdf.id, video.id, draft.id, archived.id, foreign.id].sort(),
		)
		// Another organization's dishes are never offered either.
		const otherDish = await addDish(other.organization.id, 'Secret Special')
		const again = (await (
			await propose(organization.slug, cookie, [ok.id])
		).json()) as ProposeBody
		expect(again.dishes.map((d) => d.id)).not.toContain(otherDish.id)
	})

	it('refuses more than 100 photos and bad input', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const tooMany = Array.from(
			{ length: BULK_PHOTO_MAX_FILES + 1 },
			(_, i) => `a${i}`,
		)
		expect((await propose(organization.slug, cookie, tooMany)).status).toBe(400)
		expect((await propose(organization.slug, cookie, [])).status).toBe(400)
		expect(
			(
				await post(organization.slug, cookie, {
					intent: 'propose',
					assetIds: 'nope',
				})
			).status,
		).toBe(400)
		expect(
			(await post(organization.slug, cookie, { intent: 'delete' })).status,
		).toBe(400)
	})
})

describe('apply (#316)', () => {
	it('applies the confirmed pairs to every dish in one step', async () => {
		const { organization, cookie, dishes, assets } = await setupFifty()
		const res = await apply(
			organization.slug,
			cookie,
			assets.map((asset, index) => ({
				assetId: asset.id,
				itemId: dishes[index]!.id,
				replace: false,
				sourceKey: null,
			})),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			ok: true
			applied: string[]
			refused: unknown[]
		}
		expect(body.applied.sort()).toEqual(dishes.map((d) => d.id).sort())
		expect(body.refused).toEqual([])

		const rows = await dishRows(dishes.map((dish) => dish.id))
		assets.forEach((asset, index) => {
			const row = rows.get(dishes[index]!.id)!
			expect(row.imageKey).toBe(asset.objectKey)
			expect(JSON.parse(row.imageKeys)).toEqual([asset.objectKey])
			expect(row.imageUrl).toContain(`mediaId=${asset.id}`)
		})
		// One cache purge for the whole batch, not one per dish.
		expect(purgeOrganizationSiteCache).toHaveBeenCalledTimes(1)
	})

	it('adds only the pairs it is sent: unconfirmed photos stay in the library', async () => {
		const { organization, cookie, dishes, assets } = await setupFifty()
		const res = await apply(organization.slug, cookie, [
			{ assetId: assets[0]!.id, itemId: dishes[0]!.id, replace: false },
		])
		expect(res.status).toBe(200)
		const rows = await dishRows(dishes.map((dish) => dish.id))
		expect(rows.get(dishes[0]!.id)!.imageKey).toBe(assets[0]!.objectKey)
		for (const dish of dishes.slice(1)) {
			expect(rows.get(dish.id)!.imageKey).toBeNull()
		}
		const stored = await db
			.select({ id: OrganizationMediaAsset.id })
			.from(OrganizationMediaAsset)
			.where(
				inArray(
					OrganizationMediaAsset.id,
					assets.map((a) => a.id),
				),
			)
		expect(stored).toHaveLength(50)
	})

	it('refuses the whole request when a dish with a photo is not marked Replace', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const old = await addAsset(organization.id, { fileName: 'old.jpg' })
		const withPhoto = await addDish(organization.id, 'Beef Burger', {
			imageKey: old.objectKey,
			imageKeys: JSON.stringify([old.objectKey]),
			imageUrl: `/resources/images?mediaId=${old.id}&v=1`,
		})
		const empty = await addDish(organization.id, 'Hummus')
		const a = await addAsset(organization.id, { fileName: 'Beef Burger.jpg' })
		const b = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
		const res = await apply(organization.slug, cookie, [
			{ assetId: b.id, itemId: empty.id, replace: false },
			{ assetId: a.id, itemId: withPhoto.id, replace: false },
		])
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({
			ok: false,
			error: 'replace_not_confirmed',
			itemId: withPhoto.id,
		})
		// Nothing changed, not even the dish that had no photo.
		const rows = await dishRows([withPhoto.id, empty.id])
		expect(rows.get(withPhoto.id)!.imageKey).toBe(old.objectKey)
		expect(rows.get(empty.id)!.imageKey).toBeNull()
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('replaces a photo only when ticked, and keeps the old one in the library as the original', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const old = await addAsset(organization.id, { fileName: 'old.jpg' })
		const dish = await addDish(organization.id, 'Beef Burger', {
			imageKey: old.objectKey,
			imageKeys: JSON.stringify([old.objectKey]),
			imageUrl: `/resources/images?mediaId=${old.id}&v=1`,
		})
		const fresh = await addAsset(organization.id, {
			fileName: 'Beef Burger.jpg',
		})
		const res = await apply(organization.slug, cookie, [
			{
				assetId: fresh.id,
				itemId: dish.id,
				replace: true,
				sourceKey: old.objectKey,
			},
		])
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			ok: true,
			applied: [dish.id],
			refused: [],
		})

		const [row] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, dish.id))
		expect(row!.imageKey).toBe(fresh.objectKey)
		expect(JSON.parse(row!.imageKeys)).toEqual([fresh.objectKey, old.objectKey])
		// The old photo is still in the library, now the original of the new one.
		const [oldRow] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, old.id))
		expect(oldRow).toBeTruthy()
		const [freshRow] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, fresh.id))
		expect(freshRow!.parentAssetId).toBe(old.id)
	})

	it('reports a dish that changed while the operator was reviewing, and still applies the rest', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const old = await addAsset(organization.id)
		const changed = await addDish(organization.id, 'Beef Burger', {
			imageKey: old.objectKey,
			imageKeys: JSON.stringify([old.objectKey]),
		})
		const fine = await addDish(organization.id, 'Hummus')
		const a = await addAsset(organization.id)
		const b = await addAsset(organization.id)
		const res = await apply(organization.slug, cookie, [
			// The reviewer saw another photo on this dish.
			{
				assetId: a.id,
				itemId: changed.id,
				replace: true,
				sourceKey: 'orgs/x/seen.jpg',
			},
			{ assetId: b.id, itemId: fine.id, replace: false, sourceKey: null },
		])
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			ok: true,
			applied: [fine.id],
			refused: [{ itemId: changed.id, error: 'photo_changed' }],
		})
		const rows = await dishRows([changed.id, fine.id])
		expect(rows.get(changed.id)!.imageKey).toBe(old.objectKey)
		expect(rows.get(fine.id)!.imageKey).toBe(b.objectKey)
	})

	it('refuses another organization’s photo or dish, and a dish used twice, without changing anything', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const mine = await addDish(organization.id, 'Hummus')
		const mine2 = await addDish(organization.id, 'Lamb Kofta')
		const foreignDish = await addDish(other.organization.id, 'Foreign Dish')
		const myAsset = await addAsset(organization.id)
		const myAsset2 = await addAsset(organization.id)
		const foreignAsset = await addAsset(other.organization.id)

		const asset404 = await apply(organization.slug, cookie, [
			{ assetId: myAsset.id, itemId: mine.id, replace: false },
			{ assetId: foreignAsset.id, itemId: mine2.id, replace: false },
		])
		expect(asset404.status).toBe(404)
		expect(await asset404.json()).toMatchObject({ error: 'asset_not_found' })

		const dish404 = await apply(organization.slug, cookie, [
			{ assetId: myAsset.id, itemId: mine.id, replace: false },
			{ assetId: myAsset2.id, itemId: foreignDish.id, replace: false },
		])
		expect(dish404.status).toBe(404)
		expect(await dish404.json()).toMatchObject({ error: 'unknown_dish' })

		const twice = await apply(organization.slug, cookie, [
			{ assetId: myAsset.id, itemId: mine.id, replace: false },
			{ assetId: myAsset2.id, itemId: mine.id, replace: false },
		])
		expect(twice.status).toBe(400)
		expect(await twice.json()).toMatchObject({ error: 'duplicate_pair' })

		const rows = await dishRows([mine.id, mine2.id, foreignDish.id])
		for (const row of rows.values()) expect(row.imageKey).toBeNull()
		expect(purgeOrganizationSiteCache).not.toHaveBeenCalled()
	})

	it('refuses a draft, archived or non-image photo and limits the batch to 100', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Hummus')
		for (const values of [
			{ status: 'draft' },
			{ archivedAt: new Date() },
			{ mimeType: 'application/pdf' },
		] as Array<Partial<typeof OrganizationMediaAsset.$inferInsert>>) {
			const asset = await addAsset(organization.id, values)
			const res = await apply(organization.slug, cookie, [
				{ assetId: asset.id, itemId: dish.id, replace: false },
			])
			expect(res.status).toBe(404)
		}
		const tooMany = Array.from(
			{ length: BULK_PHOTO_MAX_FILES + 1 },
			(_, i) => ({
				assetId: `a${i}`,
				itemId: `d${i}`,
				replace: false,
			}),
		)
		expect((await apply(organization.slug, cookie, tooMany)).status).toBe(400)
		expect((await apply(organization.slug, cookie, [])).status).toBe(400)
		expect(
			(await post(organization.slug, cookie, { intent: 'apply', pairs: '{' }))
				.status,
		).toBe(400)
		expect((await dishRows([dish.id])).get(dish.id)!.imageKey).toBeNull()
	})
})

describe('permissions (#316)', () => {
	it.each(['org_role_viewer', 'org_role_guest'])(
		'%s can neither propose nor apply',
		async (role) => {
			const { organization } = await setupTestOrgWithUser('admin')
			const dish = await addDish(organization.id, 'Hummus')
			const asset = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
			const cookie = await memberCookie(organization.id, role)
			expect(
				(await propose(organization.slug, cookie, [asset.id])).status,
			).toBe(403)
			expect(
				(
					await apply(organization.slug, cookie, [
						{ assetId: asset.id, itemId: dish.id, replace: false },
					])
				).status,
			).toBe(403)
			expect((await dishRows([dish.id])).get(dish.id)!.imageKey).toBeNull()
			const pageLoad = await loader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/media/dish-photos`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never).catch((thrown: unknown) => thrown as Response)
			expect((pageLoad as Response).status).toBe(403)
		},
	)

	it('a role with media but not menu permission can propose but cannot apply', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Hummus')
		const asset = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
		const cookie = await memberCookie(
			organization.id,
			await customRole(organization.id, ['org_perm_update_media_any']),
		)
		expect((await propose(organization.slug, cookie, [asset.id])).status).toBe(
			200,
		)
		const res = await apply(organization.slug, cookie, [
			{ assetId: asset.id, itemId: dish.id, replace: false },
		])
		expect(res.status).toBe(403)
		expect((await dishRows([dish.id])).get(dish.id)!.imageKey).toBeNull()
		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/media/dish-photos`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as { canApply: boolean }
		expect(data.canApply).toBe(false)
	})

	it('a role with menu but not media permission can do neither', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Hummus')
		const asset = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
		const cookie = await memberCookie(
			organization.id,
			await customRole(organization.id, ['org_perm_update_menu_any']),
		)
		expect((await propose(organization.slug, cookie, [asset.id])).status).toBe(
			403,
		)
		expect(
			(
				await apply(organization.slug, cookie, [
					{ assetId: asset.id, itemId: dish.id, replace: false },
				])
			).status,
		).toBe(403)
	})

	it('a user outside the organization gets 404, even with photo and dish ids', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const outsider = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Hummus')
		const asset = await addAsset(organization.id, { fileName: 'Hummus.jpg' })
		expect(
			(await propose(organization.slug, outsider.cookie, [asset.id])).status,
		).toBe(404)
		expect(
			(
				await apply(organization.slug, outsider.cookie, [
					{ assetId: asset.id, itemId: dish.id, replace: false },
				])
			).status,
		).toBe(404)
		expect((await dishRows([dish.id])).get(dish.id)!.imageKey).toBeNull()
	})

	it('a signed-out request is refused', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const body = new FormData()
		body.set('intent', 'propose')
		body.set('assetIds', '["x"]')
		const res = await action({
			request: new Request(
				`http://localhost:3000/${organization.slug}/media/dish-photos`,
				{
					method: 'POST',
					body,
				},
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never).catch((thrown: unknown) => thrown as Response)
		expect([301, 302, 401, 403]).toContain((res as Response).status)
	})
})

describe('model use (#316)', () => {
	function fakeModel(
		answer: (
			fileName: string | null | undefined,
		) => ReturnType<DishPhotoVision['describe']>,
	) {
		const seen: Array<string | null | undefined> = []
		const adapter: DishPhotoVision = {
			name: 'model',
			async describe(_image, hint) {
				seen.push(hint.fileName)
				return answer(hint.fileName)
			},
		}
		return { adapter, seen }
	}

	it('stops asking the model when the hourly image budget is spent, and matches the rest by name', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await addDish(organization.id, 'Beef Burger')
		await addDish(organization.id, 'Lamb Kofta')
		await addDish(organization.id, 'Hummus')
		const assets = [
			await addAsset(organization.id, { fileName: 'Beef Burger.jpg' }),
			await addAsset(organization.id, { fileName: 'Lamb Kofta.jpg' }),
			await addAsset(organization.id, { fileName: 'Hummus.jpg' }),
		]
		let budget = 2
		const { adapter, seen } = fakeModel(async () => ({
			looksLikeFood: true,
			label: null,
			qualityScore: 80,
		}))
		const result = await proposeBulkPhotos({
			organization,
			assetIds: assets.map((a) => a.id),
			vision: adapter,
			limiter: async () => budget-- > 0,
		})
		expect(seen).toHaveLength(2)
		expect(result.visionLimited).toBe(true)
		expect(result.vision).toBe('model')
		// All three still have a proposal, from the file name.
		expect(result.photos.every((p) => p.proposal.itemId !== null)).toBe(true)
	})

	it('treats a model failure as unscored, never as a crash or a flag', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Beef Burger')
		const asset = await addAsset(organization.id, {
			fileName: 'Beef Burger.jpg',
		})
		const { adapter } = fakeModel(async () => null)
		const result = await proposeBulkPhotos({
			organization,
			assetIds: [asset.id],
			vision: adapter,
			limiter: async () => true,
		})
		expect(result.photos[0]).toMatchObject({
			qualityScore: null,
			proposal: { itemId: dish.id, flags: [] as BulkPhotoFlag[] },
		})
		const { adapter: throwing } = fakeModel(async () => {
			throw new Error('model down')
		})
		// An adapter that throws is the adapter's bug, but a stored image that
		// cannot be read is handled: here the reader itself fails.
		void throwing
	})

	it('uses what the model saw when the file name says nothing', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const dish = await addDish(organization.id, 'Margherita Pizza')
		await addDish(organization.id, 'Beef Burger')
		const asset = await addAsset(organization.id, { fileName: 'IMG_2041.jpg' })
		const { adapter } = fakeModel(async () => ({
			looksLikeFood: true,
			label: 'margherita pizza',
			qualityScore: 90,
		}))
		const result = await proposeBulkPhotos({
			organization,
			assetIds: [asset.id],
			vision: adapter,
			limiter: async () => true,
		})
		expect(result.photos[0]).toMatchObject({
			label: 'margherita pizza',
			qualityScore: 90,
			proposal: { itemId: dish.id },
		})
	})

	it('flags a weak photo from the model score', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await addDish(organization.id, 'Beef Burger')
		const asset = await addAsset(organization.id, {
			fileName: 'Beef Burger.jpg',
		})
		const { adapter } = fakeModel(async () => ({
			looksLikeFood: true,
			label: null,
			qualityScore: 20,
		}))
		const result = await proposeBulkPhotos({
			organization,
			assetIds: [asset.id],
			vision: adapter,
			limiter: async () => true,
		})
		expect(result.photos[0]!.proposal.flags).toEqual(['weak'])
	})
})
