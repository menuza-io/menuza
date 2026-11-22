/**
 * #394 focal point and #145 quality in the media library route: the focal
 * point is saved on the asset (and clears), a replaced image starts over, the
 * library filters "Needs a better photo", and Menu health's studio link opens
 * the studio on that photo with its issues.
 */
import {
	db,
	eq,
	MenuItemPhotoTest,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import type * as storageModule from '#app/utils/storage.server.ts'
import { setOrgFlag } from '#tests/seo-utils.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './media.tsx'

const purge = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purge,
}))
const wake = vi.hoisted(() => vi.fn(async () => true))
vi.mock('#app/utils/media/photo-quality.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	wakePhotoQualityWorkflow: wake,
}))
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof storageModule>()
	return {
		...actual,
		deleteOrganizationStorageObject: vi.fn().mockResolvedValue(undefined),
		uploadOrganizationMediaFileOnly: vi.fn(async (organizationId: string) => ({
			key: `orgs/${organizationId}/media/images/new-${Math.random()}.png`,
			mimeType: 'image/png',
			file: new File([new Uint8Array(4)], 'new.png'),
			width: 2000,
			height: 1500,
		})),
	}
})

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
			width: 2000,
			height: 1500,
			source: 'library',
			...values,
		})
		.returning()
	return asset!
}

async function post(
	slug: string,
	cookie: string,
	fields: Record<string, string | File>,
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
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
		assets: Array<{
			id: string
			focal: { x: number; y: number } | null
			qualityScore: number | null
			qualityIssues: string[]
		}>
		qualityEnabled: boolean
		studioPrefill: { assetId: string; issues: string[] } | null
		restyleEnabled: boolean
	}
}

const reload = async (id: string) =>
	(
		await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, id))
	)[0]!

describe('focal point (#394)', () => {
	it('saves a point on the asset, bumps updatedAt so every crop refreshes, and purges the site cache', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const asset = await addAsset(organization.id)
		purge.mockClear()
		const res = await post(organization.slug, cookie, {
			intent: 'set-focal',
			id: asset.id,
			x: '0',
			y: '0',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			focalSet: true,
			asset: { focal: { x: 0, y: 0 } },
		})
		const row = await reload(asset.id)
		expect([row.focalX, row.focalY]).toEqual([0, 0])
		expect(row.updatedAt.getTime()).toBeGreaterThan(
			asset.updatedAt.getTime() - 1,
		)
		expect(purge).toHaveBeenCalledWith(organization.id, organization.slug)
	})

	it('clears the point (and the exact centre is no point): existing photos keep centre crops', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const asset = await addAsset(organization.id, { focalX: 0.1, focalY: 0.2 })
		const cleared = await post(organization.slug, cookie, {
			intent: 'set-focal',
			id: asset.id,
		})
		expect(cleared.status).toBe(200)
		expect([
			(await reload(asset.id)).focalX,
			(await reload(asset.id)).focalY,
		]).toEqual([null, null])
		await post(organization.slug, cookie, {
			intent: 'set-focal',
			id: asset.id,
			x: '0.5',
			y: '0.5',
		})
		expect((await reload(asset.id)).focalX).toBeNull()
		// A photo nobody touched has none.
		const untouched = await addAsset(organization.id)
		const { assets } = await load(organization.slug, cookie)
		expect(assets.find((a) => a.id === untouched.id)!.focal).toBeNull()
	})

	it('refuses a point outside the photo, another organization, and a member without media permission', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		const asset = await addAsset(mine.organization.id)
		expect(
			(
				await post(mine.organization.slug, mine.cookie, {
					intent: 'set-focal',
					id: asset.id,
					x: '2',
					y: '0',
				})
			).status,
		).toBe(400)
		const foreign = await addAsset(theirs.organization.id)
		expect(
			(
				await post(mine.organization.slug, mine.cookie, {
					intent: 'set-focal',
					id: foreign.id,
					x: '0',
					y: '0',
				})
			).status,
		).toBe(404)
		expect((await reload(foreign.id)).focalX).toBeNull()

		const viewer = await createTestUser()
		await addOrganizationMember(
			viewer.id,
			mine.organization.id,
			'org_role_viewer',
		)
		const { cookie } = await createTestSession(viewer.id)
		expect(
			(
				await post(mine.organization.slug, cookie, {
					intent: 'set-focal',
					id: asset.id,
					x: '0',
					y: '0',
				})
			).status,
		).toBe(403)
		expect((await reload(asset.id)).focalX).toBeNull()
	})

	it('a replaced image starts over: no old crop point, no old score, scored again', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setOrgFlag(organization.id, 'media.photo_quality', true)
		const asset = await addAsset(organization.id, {
			focalX: 0,
			focalY: 0,
			qualityScore: 20,
			qualityIssues: '["blurry"]',
			qualityAttempts: 1,
			analyzedAt: new Date(),
		})
		wake.mockClear()
		const res = await post(organization.slug, cookie, {
			intent: 'replace',
			id: asset.id,
			imageFile: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', {
				type: 'image/png',
			}),
		})
		expect(res.status).toBe(200)
		const row = await reload(asset.id)
		expect(row).toMatchObject({
			focalX: null,
			focalY: null,
			qualityScore: null,
			qualityIssues: null,
			qualityAttempts: 0,
			analyzedAt: null,
		})
		expect(wake).toHaveBeenCalledWith(organization.id)
	})
})

describe('photo quality in the library (#145)', () => {
	it('shows scores and filters "Needs a better photo" (under 50 or too small)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setOrgFlag(organization.id, 'media.photo_quality', true)
		const weak = await addAsset(organization.id, {
			qualityScore: 31,
			qualityIssues: '["too_dark"]',
			analyzedAt: new Date(),
		})
		const small = await addAsset(organization.id, {
			qualityScore: null,
			qualityIssues: '["low_resolution"]',
			analyzedAt: new Date(),
		})
		const good = await addAsset(organization.id, {
			qualityScore: 88,
			qualityIssues: '[]',
			analyzedAt: new Date(),
		})
		const unscored = await addAsset(organization.id)

		const all = await load(organization.slug, cookie)
		expect(all.qualityEnabled).toBe(true)
		expect(all.assets.find((a) => a.id === weak.id)).toMatchObject({
			qualityScore: 31,
			qualityIssues: ['too_dark'],
		})

		const filtered = await load(organization.slug, cookie, '?quality=weak')
		const ids = filtered.assets.map((a) => a.id)
		expect(ids).toContain(weak.id)
		expect(ids).toContain(small.id)
		expect(ids).not.toContain(good.id)
		expect(ids).not.toContain(unscored.id)
	})

	it('hides the quality controls while the flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).qualityEnabled).toBe(false)
	})

	it('opens the studio on a photo with its issues filled in (Menu health "Fix in photo studio")', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const asset = await addAsset(organization.id)
		const data = await load(
			organization.slug,
			cookie,
			`?studio=${asset.id}&issues=too_dark,blurry,<script>`,
		)
		expect(data.studioPrefill).toEqual({
			assetId: asset.id,
			issues: ['too_dark', 'blurry'],
		})
	})

	it("ignores a studio link to another organization's photo", async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		const foreign = await addAsset(theirs.organization.id)
		const data = await load(
			mine.organization.slug,
			mine.cookie,
			`?studio=${foreign.id}&issues=blurry`,
		)
		expect(data.studioPrefill).toBeNull()
	})
})

describe('restyle drafts stay out of the library list (#146)', () => {
	it('hides restyle drafts until they are used, then shows them like any photo', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const draft = await addAsset(organization.id, {
			source: 'restyle',
			status: 'draft',
		})
		const used = await addAsset(organization.id, {
			source: 'restyle',
			status: 'ready',
		})
		const normal = await addAsset(organization.id)
		const ids = (await load(organization.slug, cookie)).assets.map((a) => a.id)
		expect(ids).toContain(normal.id)
		expect(ids).toContain(used.id)
		expect(ids).not.toContain(draft.id)
	})
})

describe('a photo in a running test (#192)', () => {
	it('cannot be deleted or archived until the test ends', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const a = await addAsset(organization.id)
		const b = await addAsset(organization.id)
		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: JSON.stringify({ en: 'Soup' }),
				price: 10,
				imageKey: a.objectKey,
				imageKeys: JSON.stringify([a.objectKey]),
			})
			.returning()
		const [test] = await db
			.insert(MenuItemPhotoTest)
			.values({
				organizationId: organization.id,
				itemId: item!.id,
				imageKeyA: a.objectKey,
				imageKeyB: b.objectKey,
			})
			.returning()

		const del = await post(organization.slug, cookie, {
			intent: 'delete',
			id: b.id,
		})
		expect(del.status).toBe(409)
		const archive = await post(organization.slug, cookie, {
			intent: 'archive',
			id: b.id,
		})
		expect(archive.status).toBe(409)
		expect((await reload(b.id)).archivedAt).toBeNull()

		await db
			.update(MenuItemPhotoTest)
			.set({ endedAt: new Date() })
			.where(eq(MenuItemPhotoTest.id, test!.id))
		const archived = await post(organization.slug, cookie, {
			intent: 'archive',
			id: b.id,
		})
		expect(archived.status).toBe(200)
	})
})
