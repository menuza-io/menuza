/**
 * The one way a dish's main photo changes outside the dish form (bulk apply,
 * phone, A/B winner, restyle). Real database; only the cache purge is faked.
 */
import {
	db,
	eq,
	Integration,
	MenuItemPhotoTest,
	OrganizationMediaAsset,
	OrganizationMenuItem,
	OrganizationMenuPosLink,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { setupSeoOrganization } from '#tests/seo-utils.ts'
import {
	readDishPhotoStates,
	replaceDishMainPhoto,
	replaceDishMainPhotosBatch,
} from './dish-photo.server.ts'

const purge = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purge,
}))

async function setup() {
	const ctx = await setupSeoOrganization()
	return {
		...ctx,
		org: { id: ctx.organization.id, slug: ctx.organization.slug },
	}
}

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

async function dish(
	organizationId: string,
	keys: string[],
	imageKey?: string | null,
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Soup' }),
			price: 10,
			imageKey: imageKey === undefined ? (keys[0] ?? null) : imageKey,
			imageKeys: JSON.stringify(keys),
		})
		.returning()
	return row!
}

const reload = async (id: string) =>
	(
		await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, id))
	)[0]!

describe('replaceDishMainPhoto', () => {
	it('puts the new photo first, keeps the old one in the library as its original, and purges', async () => {
		const { org, userId } = await setup()
		const old = await asset(org.id)
		const next = await asset(org.id)
		const item = await dish(org.id, [old.objectKey])
		purge.mockClear()
		const result = await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: next,
			details: 'test',
		})
		expect(result).toMatchObject({ ok: true, previousKey: old.objectKey })
		const row = await reload(item.id)
		expect(JSON.parse(row.imageKeys)).toEqual([next.objectKey, old.objectKey])
		expect(row.imageKey).toBe(next.objectKey)
		const [linked] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, next.id))
		expect(linked!.parentAssetId).toBe(old.id)
		expect(purge).toHaveBeenCalledTimes(1)
	})

	it('refuses with photo_changed when the main photo is no longer the one the caller saw', async () => {
		const { org, userId } = await setup()
		const old = await asset(org.id)
		const other = await asset(org.id)
		const next = await asset(org.id)
		const item = await dish(org.id, [other.objectKey])
		const result = await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: next,
			expectSourceKey: old.objectKey,
			details: 'test',
		})
		expect(result).toEqual({ ok: false, error: 'photo_changed' })
		expect(JSON.parse((await reload(item.id)).imageKeys)).toEqual([
			other.objectKey,
		])
	})

	it('refuses an asset of another organization, a draft, and a photo that was deleted', async () => {
		const { org, userId } = await setup()
		const theirs = await setup()
		const item = await dish(org.id, [])
		const foreign = await asset(theirs.org.id)
		expect(
			await replaceDishMainPhoto({
				organization: org,
				userId,
				itemId: item.id,
				asset: foreign,
				details: 't',
			}),
		).toEqual({ ok: false, error: 'asset_not_found' })
		const draft = await asset(org.id, { status: 'draft' })
		expect(
			await replaceDishMainPhoto({
				organization: org,
				userId,
				itemId: item.id,
				asset: draft,
				details: 't',
			}),
		).toEqual({ ok: false, error: 'asset_not_ready' })
		// A draft promoted by the caller may be used with allowDraft...
		const promoted = await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: draft,
			allowDraft: true,
			details: 't',
		})
		expect(promoted.ok).toBe(true)
		// ...but a photo that vanished between the read and the write is not attached.
		const gone = await asset(org.id)
		const item2 = await dish(org.id, [])
		const real = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, gone.id))
		await db
			.delete(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, gone.id))
		expect(
			await replaceDishMainPhoto({
				organization: org,
				userId,
				itemId: item2.id,
				asset: real[0]!,
				details: 't',
			}),
		).toEqual({ ok: false, error: 'asset_not_found' })
		expect(JSON.parse((await reload(item2.id)).imageKeys)).toEqual([])
	})

	it('a photo change ends a running photo test of the dish', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const b = await asset(org.id)
		const x = await asset(org.id)
		const item = await dish(org.id, [a.objectKey])
		const [test] = await db
			.insert(MenuItemPhotoTest)
			.values({
				organizationId: org.id,
				itemId: item.id,
				imageKeyA: a.objectKey,
				imageKeyB: b.objectKey,
			})
			.returning()
		await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: x,
			details: 't',
		})
		const [ended] = await db
			.select()
			.from(MenuItemPhotoTest)
			.where(eq(MenuItemPhotoTest.id, test!.id))
		expect(ended).toMatchObject({ endedReason: 'stopped' })
		expect(ended!.endedAt).toBeInstanceOf(Date)
	})

	it('an older dish that stores asset ids resolves them, so the old photo is not listed twice', async () => {
		const { org, userId } = await setup()
		const old = await asset(org.id)
		const next = await asset(org.id)
		const item = await dish(org.id, [old.id], old.id)
		const state = (await readDishPhotoStates(org.id, [item.id])).get(item.id)!
		expect(state.mainKey).toBe(old.objectKey)
		await replaceDishMainPhoto({
			organization: org,
			userId,
			itemId: item.id,
			asset: next,
			dropKey: old.objectKey,
			details: 't',
		})
		expect(JSON.parse((await reload(item.id)).imageKeys)).toEqual([
			next.objectKey,
		])
	})
})

describe('a dish whose photo a connected POS owns', () => {
	it('is refused by the single-dish helper too (restyle Use new, Switch back, keep B)', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const n = await asset(org.id)
		const item = await dish(org.id, [a.objectKey])
		const [integration] = await db
			.insert(Integration)
			.values({
				organizationId: org.id,
				providerName: 'toast',
				providerType: 'pos',
				config: '{}',
			})
			.returning()
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: org.id,
			integrationId: integration!.id,
			providerName: 'toast',
			entityType: 'item',
			remoteId: 'remote-9',
			localId: item.id,
		})
		expect(
			await replaceDishMainPhoto({
				organization: org,
				userId,
				itemId: item.id,
				asset: n,
				details: 't',
			}),
		).toEqual({ ok: false, error: 'pos_owned' })
		expect((await reload(item.id)).imageKey).toBe(a.objectKey)
		// A provider that does not read photos (Clover) does not own them.
		const clover = await dish(org.id, [a.objectKey])
		const [cloverIntegration] = await db
			.insert(Integration)
			.values({
				organizationId: org.id,
				providerName: 'clover',
				providerType: 'pos',
				config: '{}',
			})
			.returning()
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: org.id,
			integrationId: cloverIntegration!.id,
			providerName: 'clover',
			entityType: 'item',
			remoteId: 'remote-10',
			localId: clover.id,
		})
		expect(
			(
				await replaceDishMainPhoto({
					organization: org,
					userId,
					itemId: clover.id,
					asset: n,
					details: 't',
				})
			).ok,
		).toBe(true)
	})
})

describe('replaceDishMainPhotosBatch', () => {
	it('changes every dish in one batch with one purge, and ends their tests', async () => {
		const { org, userId } = await setup()
		const a1 = await asset(org.id)
		const a2 = await asset(org.id)
		const n1 = await asset(org.id)
		const n2 = await asset(org.id)
		const i1 = await dish(org.id, [a1.objectKey])
		const i2 = await dish(org.id, [a2.objectKey])
		purge.mockClear()
		const result = await replaceDishMainPhotosBatch({
			organization: org,
			userId,
			details: 'bulk',
			changes: [
				{ itemId: i1.id, asset: n1, expectSourceKey: a1.objectKey },
				{ itemId: i2.id, asset: n2, expectSourceKey: a2.objectKey },
			],
		})
		expect(result.applied.sort()).toEqual([i1.id, i2.id].sort())
		expect(result.refused).toEqual([])
		expect((await reload(i1.id)).imageKey).toBe(n1.objectKey)
		expect((await reload(i2.id)).imageKey).toBe(n2.objectKey)
		expect(purge).toHaveBeenCalledTimes(1)
	})

	it('refuses a dish a connected POS owns the photo of, and one that changed meanwhile', async () => {
		const { org, userId } = await setup()
		const a = await asset(org.id)
		const n = await asset(org.id)
		const posDish = await dish(org.id, [a.objectKey])
		const [integration] = await db
			.insert(Integration)
			.values({
				organizationId: org.id,
				providerName: 'square',
				providerType: 'pos',
				config: '{}',
			})
			.returning()
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: org.id,
			integrationId: integration!.id,
			providerName: 'square',
			entityType: 'item',
			remoteId: 'remote-1',
			localId: posDish.id,
		})
		const changed = await dish(org.id, [a.objectKey])
		const result = await replaceDishMainPhotosBatch({
			organization: org,
			userId,
			details: 'bulk',
			changes: [
				{ itemId: posDish.id, asset: n },
				{
					itemId: changed.id,
					asset: n,
					expectSourceKey: 'orgs/x/something-else.jpg',
				},
			],
		})
		expect(result.applied).toEqual([])
		expect(result.refused).toEqual(
			expect.arrayContaining([
				{ itemId: posDish.id, error: 'pos_owned' },
				{ itemId: changed.id, error: 'photo_changed' },
			]),
		)
		expect((await reload(posDish.id)).imageKey).toBe(a.objectKey)
	})
})
