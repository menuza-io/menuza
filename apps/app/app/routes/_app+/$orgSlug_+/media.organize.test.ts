import {
	db,
	eq,
	OrganizationMediaAsset,
	Organization,
	OrganizationMenuItem,
	OrganizationMediaTag,
	WebsitePage,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { libraryAssetsStillMatch } from '#app/utils/media/library-attach.server.ts'
import type * as storageModule from '#app/utils/storage.server.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './media.tsx'

// Storage is the external boundary: an upload registers a library row.
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof storageModule>()
	return {
		...actual,
		deleteOrganizationStorageObject: vi.fn().mockResolvedValue(undefined),
		uploadOrganizationMediaImage: vi.fn(
			async (organizationId: string, _file: File, userId: string) => {
				const objectKey = `orgs/${organizationId}/media/images/up-${Math.random()}.png`
				await db.insert(OrganizationMediaAsset).values({
					organizationId,
					objectKey,
					mimeType: 'image/png',
					source: 'ai-studio',
					createdById: userId,
				})
				return objectKey
			},
		),
	}
})

async function setup() {
	const { user, organization, cookie } = await setupTestOrgWithUser('admin')
	return { user, organization, cookie }
}

async function addAsset(
	organizationId: string,
	values: Partial<typeof OrganizationMediaAsset.$inferInsert> = {},
) {
	const [asset] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${Math.random()}.png`,
			mimeType: 'image/png',
			...values,
		})
		.returning()
	return asset!
}

async function post(
	slug: string,
	cookie: string,
	fields: Record<string, string | string[] | File>,
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) for (const v of value) body.append(key, v)
		else body.set(key, value)
	}
	try {
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/media`,
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

async function load(slug: string, cookie: string, query = '') {
	return (await loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/media${query}`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)) as unknown as {
		assets: Array<{ id: string; tags: string[]; archived: boolean }>
		allTags: Array<{ tag: string; count: number }>
		archivedCount: number
	}
}

describe('tags (#147)', () => {
	it('adds tags in bulk and filters the library by tag', async () => {
		const { organization, cookie } = await setup()
		const [a, b, c] = await Promise.all([
			addAsset(organization.id),
			addAsset(organization.id),
			addAsset(organization.id),
		])
		const res = await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [a.id, b.id],
			tags: ['Hero', 'Ramadan'],
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			organized: 'tagged',
			updatedCount: 2,
		})

		const all = await load(organization.slug, cookie)
		expect(all.assets).toHaveLength(3)
		expect(all.allTags).toEqual([
			{ tag: 'hero', count: 2 },
			{ tag: 'ramadan', count: 2 },
		])
		const filtered = await load(organization.slug, cookie, '?tag=Hero')
		expect(filtered.assets.map((asset) => asset.id).sort()).toEqual(
			[a.id, b.id].sort(),
		)
		expect(filtered.assets.every((asset) => asset.tags.includes('hero'))).toBe(
			true,
		)
		expect(filtered.assets.some((asset) => asset.id === c.id)).toBe(false)

		const removed = await post(organization.slug, cookie, {
			intent: 'untag',
			ids: [a.id],
			tags: ['hero'],
		})
		expect(removed.status).toBe(200)
		const after = await load(organization.slug, cookie, '?tag=hero')
		expect(after.assets.map((asset) => asset.id)).toEqual([b.id])
	})

	it('refuses a bad tag and more than twenty tags', async () => {
		const { organization, cookie } = await setup()
		const asset = await addAsset(organization.id)
		const bad = await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [asset.id],
			tags: ['<b>x</b>'],
		})
		expect(bad.status).toBe(400)
		expect(await bad.json()).toMatchObject({ code: 'bad_tag' })
		const long = await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [asset.id],
			tags: ['a'.repeat(33)],
		})
		expect(long.status).toBe(400)

		const many = Array.from({ length: 21 }, (_, i) => `tag${i}`)
		const tooMany = await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [asset.id],
			tags: many,
		})
		expect(tooMany.status).toBe(400)
		expect(await tooMany.json()).toMatchObject({ code: 'too_many_tags' })
		const stored = await db
			.select()
			.from(OrganizationMediaTag)
			.where(eq(OrganizationMediaTag.assetId, asset.id))
		expect(stored).toHaveLength(0)
	})

	it('never applies a bulk tag halfway when one asset is full', async () => {
		const { organization, cookie } = await setup()
		const full = await addAsset(organization.id)
		const empty = await addAsset(organization.id)
		await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [full.id],
			tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
		})
		const res = await post(organization.slug, cookie, {
			intent: 'tag',
			ids: [empty.id, full.id],
			tags: ['extra'],
		})
		expect(res.status).toBe(400)
		const rows = await db
			.select()
			.from(OrganizationMediaTag)
			.where(eq(OrganizationMediaTag.assetId, empty.id))
		expect(rows).toHaveLength(0)
	})

	it("treats another organization's ids as not found and touches nothing", async () => {
		const mine = await setup()
		const other = await setup()
		const foreign = await addAsset(other.organization.id)
		const own = await addAsset(mine.organization.id)
		for (const intent of ['tag', 'untag', 'archive', 'restore'] as const) {
			const res = await post(mine.organization.slug, mine.cookie, {
				intent,
				ids: [own.id, foreign.id],
				tags: ['hero'],
			})
			expect(res.status).toBe(404)
		}
		const bulk = await post(mine.organization.slug, mine.cookie, {
			intent: 'bulk-update',
			ids: [foreign.id],
			altText: 'hacked',
		})
		expect(bulk.status).toBe(404)
		const [row] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, foreign.id))
		expect(row?.altText).toBeNull()
		expect(row?.archivedAt).toBeNull()
		const tags = await db
			.select()
			.from(OrganizationMediaTag)
			.where(eq(OrganizationMediaTag.assetId, foreign.id))
		expect(tags).toHaveLength(0)
	})

	it('bulk edits alt text and tags for the selection', async () => {
		const { organization, cookie } = await setup()
		const [a, b] = await Promise.all([
			addAsset(organization.id),
			addAsset(organization.id),
		])
		const res = await post(organization.slug, cookie, {
			intent: 'bulk-update',
			ids: [a.id, b.id],
			altText: 'Our dining room',
			addTags: ['room', 'featured'],
		})
		expect(res.status).toBe(200)
		const rows = await db.select().from(OrganizationMediaAsset)
		expect(rows.filter((r) => r.altText === 'Our dining room')).toHaveLength(2)
		const featured = await load(organization.slug, cookie, '?tag=featured')
		expect(featured.assets).toHaveLength(2)
	})
})

describe('archive and restore (#147)', () => {
	it("refuses to archive a dish's photo and lists where it is used", async () => {
		const { organization, cookie } = await setup()
		const main = await addAsset(organization.id)
		await db.insert(OrganizationMenuItem).values({
			organizationId: organization.id,
			displayName: 'Margherita',
			imageKey: main.id,
			imageKeys: JSON.stringify([main.id]),
		})
		const res = await post(organization.slug, cookie, {
			intent: 'archive',
			ids: [main.id],
		})
		expect(res.status).toBe(409)
		const body = (await res.json()) as {
			code: string
			references: Array<{ type: string; title: string }>
		}
		expect(body.code).toBe('asset_in_use')
		expect(body.references[0]).toMatchObject({ type: 'menu-item' })
		expect(body.references[0]?.title).toContain('Margherita')
		const [row] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, main.id))
		expect(row?.archivedAt).toBeNull()
	})

	it('refuses to archive a photo the website uses', async () => {
		const { user, organization, cookie } = await setup()
		const asset = await addAsset(organization.id)
		await db.insert(WebsitePage).values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'Home',
			slug: `home-${Math.random()}`,
			publishedData: JSON.stringify({ sections: [{ src: asset.objectKey }] }),
		} as never)
		const res = await post(organization.slug, cookie, {
			intent: 'archive',
			ids: [asset.id],
		})
		expect(res.status).toBe(409)
		expect(await res.json()).toMatchObject({ code: 'asset_in_use' })
	})

	it('refuses to archive a photo the live or the draft header or footer shows', async () => {
		const { organization, cookie } = await setup()
		for (const column of [
			'siteHeaderConfig',
			'siteFooterConfig',
			'draftHeaderConfig',
			'draftFooterConfig',
		] as const) {
			const asset = await addAsset(organization.id)
			await db
				.update(Organization)
				.set({ [column]: JSON.stringify({ logo: { src: asset.objectKey } }) })
				.where(eq(Organization.id, organization.id))
			const res = await post(organization.slug, cookie, {
				intent: 'archive',
				ids: [asset.id],
			})
			expect(res.status).toBe(409)
			expect(await res.json()).toMatchObject({ code: 'asset_in_use' })
			await db
				.update(Organization)
				.set({ [column]: null })
				.where(eq(Organization.id, organization.id))
		}
	})

	it('archives another photo, hides it from the library and pickers, and restores it', async () => {
		const { organization, cookie } = await setup()
		const main = await addAsset(organization.id)
		const spare = await addAsset(organization.id)
		await db.insert(OrganizationMenuItem).values({
			organizationId: organization.id,
			displayName: 'Margherita',
			imageKeys: JSON.stringify([main.id]),
		})

		const archive = await post(organization.slug, cookie, {
			intent: 'archive',
			ids: [spare.id],
		})
		expect(archive.status).toBe(200)

		const library = await load(organization.slug, cookie)
		expect(library.assets.map((a) => a.id)).toEqual([main.id])
		expect(library.archivedCount).toBe(1)
		const picker = await load(organization.slug, cookie, '?picker=1')
		expect(picker.assets.map((a) => a.id)).toEqual([main.id])
		const archived = await load(organization.slug, cookie, '?view=archived')
		expect(archived.assets.map((a) => a.id)).toEqual([spare.id])
		expect(archived.assets[0]?.archived).toBe(true)

		const restore = await post(organization.slug, cookie, {
			intent: 'restore',
			ids: [spare.id],
		})
		expect(restore.status).toBe(200)
		const back = await load(organization.slug, cookie)
		expect(back.assets.map((a) => a.id).sort()).toEqual(
			[main.id, spare.id].sort(),
		)
		expect(back.archivedCount).toBe(0)
	})

	it('archived assets keep their row and file (they still count toward storage)', async () => {
		const { organization, cookie } = await setup()
		const asset = await addAsset(organization.id, { fileSize: 4096 })
		await post(organization.slug, cookie, {
			intent: 'archive',
			ids: [asset.id],
		})
		const rows = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.organizationId, organization.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.archivedAt).toBeInstanceOf(Date)
		expect(rows[0]?.fileSize).toBe(4096)
	})
})

describe('versions (#147)', () => {
	it('shows a studio edit under Versions with its original', async () => {
		const { organization, cookie } = await setup()
		const original = await addAsset(organization.id, { source: 'library' })
		const file = new File([new Uint8Array([137, 80, 78, 71])], 'edit.png', {
			type: 'image/png',
		})
		const upload = await post(organization.slug, cookie, {
			intent: 'upload',
			source: 'ai-studio',
			parentAssetId: original.id,
			imageFile: file,
		})
		expect(upload.status).toBe(200)
		const edit = (
			(await upload.json()) as { asset: { id: string; parentAssetId: string } }
		).asset
		expect(edit.parentAssetId).toBe(original.id)

		const fromEdit = await post(organization.slug, cookie, {
			intent: 'get-versions',
			id: edit.id,
		})
		const body = (await fromEdit.json()) as {
			versions: {
				original: { id: string }
				versions: Array<{ id: string; source: string }>
			}
		}
		expect(body.versions.original.id).toBe(original.id)
		expect(body.versions.versions.map((v) => v.id)).toEqual([edit.id])
		expect(body.versions.versions[0]?.source).toBe('ai-studio')

		const fromOriginal = await post(organization.slug, cookie, {
			intent: 'get-versions',
			id: original.id,
		})
		const same = (await fromOriginal.json()) as typeof body
		expect(same.versions.versions.map((v) => v.id)).toEqual([edit.id])
	})

	it('refuses an upload whose original is another organization', async () => {
		const mine = await setup()
		const other = await setup()
		const foreign = await addAsset(other.organization.id)
		const res = await post(mine.organization.slug, mine.cookie, {
			intent: 'upload',
			parentAssetId: foreign.id,
			imageFile: new File([new Uint8Array([1, 2, 3])], 'x.png', {
				type: 'image/png',
			}),
		})
		expect(res.status).toBe(404)
	})

	it('refuses an asset as its own original and any loop (invalid_parent)', async () => {
		const { organization, cookie } = await setup()
		const a = await addAsset(organization.id)
		const b = await addAsset(organization.id)
		const c = await addAsset(organization.id)
		const self = await post(organization.slug, cookie, {
			intent: 'set-parent',
			id: a.id,
			parentAssetId: a.id,
		})
		expect(self.status).toBe(400)
		expect(await self.json()).toMatchObject({ code: 'invalid_parent' })

		expect(
			(
				await post(organization.slug, cookie, {
					intent: 'set-parent',
					id: b.id,
					parentAssetId: a.id,
				})
			).status,
		).toBe(200)
		expect(
			(
				await post(organization.slug, cookie, {
					intent: 'set-parent',
					id: c.id,
					parentAssetId: b.id,
				})
			).status,
		).toBe(200)
		// a -> c would close the loop a <- b <- c <- a.
		const loop = await post(organization.slug, cookie, {
			intent: 'set-parent',
			id: a.id,
			parentAssetId: c.id,
		})
		expect(loop.status).toBe(400)
		expect(await loop.json()).toMatchObject({ code: 'invalid_parent' })
	})

	it("refuses another organization's original", async () => {
		const mine = await setup()
		const other = await setup()
		const own = await addAsset(mine.organization.id)
		const foreign = await addAsset(other.organization.id)
		const res = await post(mine.organization.slug, mine.cookie, {
			intent: 'set-parent',
			id: own.id,
			parentAssetId: foreign.id,
		})
		expect(res.status).toBe(404)
		const [row] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, own.id))
		expect(row?.parentAssetId).toBeNull()
	})

	it('deleting an original keeps its versions and clears the link', async () => {
		const { organization, cookie } = await setup()
		const original = await addAsset(organization.id)
		const edit = await addAsset(organization.id, {
			parentAssetId: original.id,
			source: 'ai-studio',
		})
		const res = await post(organization.slug, cookie, {
			intent: 'delete',
			id: original.id,
		})
		expect(res.status).toBe(200)
		const [kept] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, edit.id))
		expect(kept).toBeDefined()
		expect(kept?.parentAssetId).toBeNull()
	})
})

describe('assets still processing (#147)', () => {
	it('are not offered by the picker and cannot be attached (asset_not_ready)', async () => {
		const { organization, cookie } = await setup()
		const ready = await addAsset(organization.id)
		const processing = await addAsset(organization.id, { status: 'processing' })
		const draft = await addAsset(organization.id, { status: 'draft' })

		const picker = await load(organization.slug, cookie, '?picker=1')
		expect(picker.assets.map((a) => a.id)).toEqual([ready.id])

		expect(
			await libraryAssetsStillMatch(organization.id, [
				{ assetId: ready.id, objectKey: ready.objectKey },
			]),
		).toBe(true)
		for (const asset of [processing, draft]) {
			expect(
				await libraryAssetsStillMatch(organization.id, [
					{ assetId: asset.id, objectKey: asset.objectKey },
				]),
			).toBe(false)
		}
	})
})

describe('a generated hero clip in the library (#301, #147)', () => {
	it('is a draft video, labelled as made by Menuza, linked to its first photo, and never offered by a picker', async () => {
		const { organization, cookie } = await setup()
		const photo = await addAsset(organization.id)
		const clip = await addAsset(organization.id, {
			mimeType: 'video/mp4',
			source: 'hero-video',
			status: 'draft',
			parentAssetId: photo.id,
		})
		const library = (await load(organization.slug, cookie)) as unknown as {
			assets: Array<{
				id: string
				url: string
				status: string
				source: string
				parentAssetId: string | null
			}>
		}
		const listed = library.assets.find((asset) => asset.id === clip.id)!
		expect(listed).toMatchObject({
			status: 'draft',
			source: 'hero-video',
			parentAssetId: photo.id,
		})
		// It plays from the video route, not as an image.
		expect(listed.url).toContain('/resources/videos/source?objectKey=')
		const picker = await load(organization.slug, cookie, '?picker=1')
		expect(picker.assets.map((asset) => asset.id)).toEqual([photo.id])
		// It shows under Versions of the photo it was made from.
		const versions = await post(organization.slug, cookie, {
			intent: 'get-versions',
			id: clip.id,
		})
		const body = (await versions.json()) as {
			versions: {
				original: { id: string }
				versions: Array<{ id: string; source: string }>
			}
		}
		expect(body.versions.original.id).toBe(photo.id)
		expect(body.versions.versions).toEqual([
			expect.objectContaining({ id: clip.id, source: 'hero-video' }),
		])
	})
})

describe('permissions (#147)', () => {
	it('refuses a signed-out archive and changes nothing', async () => {
		const { organization } = await setup()
		const asset = await addAsset(organization.id)
		const body = new FormData()
		body.set('intent', 'archive')
		body.set('ids', asset.id)
		const res = await action({
			request: new Request(`http://localhost:3000/${organization.slug}/media`, {
				method: 'POST',
				body,
			}),
			params: { orgSlug: organization.slug },
			context: {},
		} as never).then(
			(value) => value as Response,
			(thrown: unknown) => thrown as Response,
		)
		expect([401, 403, 302]).toContain(res.status)
		const [row] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, asset.id))
		expect(row?.archivedAt).toBeNull()
	})
})
