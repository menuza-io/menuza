/**
 * #301: a hero video made from the restaurant's own photos. The renderer and
 * storage are the external boundaries (a mock renderer, in-memory storage);
 * the rules, records, privacy and acceptance are real.
 */
import {
	HERO_VIDEO_MAX_PER_DAY,
	HERO_VIDEO_STALE_MS,
} from '@repo/common/hero-video'
import {
	and,
	db,
	eq,
	HeroVideoGeneration,
	Notification,
	OrganizationMediaAsset,
	OrganizationMediaTag,
	OrganizationMenuItem,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import {
	authorizeRegisteredObject,
	isPublicMediaAsset,
} from '#app/utils/media-access.server.ts'
import { setOrgFlag, setupSeoOrganization } from '#tests/seo-utils.ts'
import { createMockHeroVideoRenderer } from './renderer.server.ts'
import {
	acceptHeroVideo,
	discardHeroVideo,
	listHeroVideos,
	processHeroVideo,
	startHeroVideo,
	sweepHeroVideos,
	type HeroVideoDeps,
} from './service.server.ts'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

async function setup(options: { flag?: boolean } = {}) {
	const ctx = await setupSeoOrganization()
	if (options.flag !== false) {
		await setOrgFlag(ctx.organization.id, 'website.hero_video', true)
	}
	return ctx
}

async function photo(
	organizationId: string,
	values: Partial<typeof OrganizationMediaAsset.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId,
			objectKey: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`,
			mimeType: 'image/jpeg',
			width: 1600,
			height: 900,
			...values,
		})
		.returning()
	return row!
}

async function photos(organizationId: string, count = 4) {
	return Promise.all(Array.from({ length: count }, () => photo(organizationId)))
}

function harness(overrides: Partial<HeroVideoDeps> = {}) {
	const stored: Array<{ key: string; bytes: Uint8Array; mimeType: string }> = []
	const removed: string[] = []
	const renderer = createMockHeroVideoRenderer()
	const wake = vi.fn(async (_generationId: string) => true)
	const deps: HeroVideoDeps = {
		renderer,
		now: () => NOW,
		wake,
		readPhoto: async (asset) =>
			new TextEncoder().encode(`bytes-of:${asset.objectKey}`),
		presign: async (asset) => `https://signed.test/${asset.objectKey}?x=1`,
		store: vi.fn(async (input) => {
			const key = `orgs/${input.organizationId}/media/hero-video/${crypto.randomUUID()}${input.suffix ?? ''}.${input.extension}`
			stored.push({ key, bytes: input.bytes, mimeType: input.mimeType })
			return key
		}),
		remove: vi.fn(async (key: string) => {
			removed.push(key)
		}),
		...overrides,
	}
	return { deps, stored, removed, renderer, wake }
}

async function start(
	ctx: Awaited<ReturnType<typeof setup>>,
	ids: string[],
	deps: HeroVideoDeps,
	style: unknown = 'slow_pans',
	extra: { auto?: boolean; pageId?: string | null } = {},
) {
	return startHeroVideo(
		{
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			style,
			photoAssetIds: ids,
			...extra,
		},
		deps,
	)
}

async function pageWithHero(ctx: Awaited<ReturnType<typeof setup>>) {
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: ctx.organization.id,
			createdById: ctx.userId,
			title: 'Home',
			slug: `home-${crypto.randomUUID().slice(0, 8)}`,
			isHomePage: true,
		} as never)
		.returning({ id: WebsitePage.id })
	const config = {
		heading: 'Welcome',
		assetType: 'image',
		imageUrl: '/resources/images?objectKey=orgs/x/hero.jpg',
		slides: [{ url: '/a.jpg', alt: 'A' }],
	}
	const [section] = await db
		.insert(WebsitePageSection)
		.values({
			pageId: page!.id,
			type: 'hero',
			position: 1,
			config: JSON.stringify(config),
		} as never)
		.returning({ id: WebsitePageSection.id })
	return { pageId: page!.id, sectionId: section!.id, config }
}

const generation = async (id: string) =>
	(
		await db
			.select()
			.from(HeroVideoGeneration)
			.where(eq(HeroVideoGeneration.id, id))
	)[0]!

describe('asking for a hero video (#301)', () => {
	it('refuses while the feature is off or no renderer is set up', async () => {
		const off = await setup({ flag: false })
		const h = harness()
		const ids = (await photos(off.organization.id)).map((p) => p.id)
		expect(await start(off, ids, h.deps)).toEqual({
			ok: false,
			error: 'hero_video_disabled',
		})
		const on = await setup()
		const onIds = (await photos(on.organization.id)).map((p) => p.id)
		expect(await start(on, onIds, { ...h.deps, renderer: null })).toEqual({
			ok: false,
			error: 'renderer_not_configured',
		})
		expect(h.wake).not.toHaveBeenCalled()
	})

	it('needs a known style and 3 to 6 photos', async () => {
		const ctx = await setup()
		const h = harness()
		const all = await photos(ctx.organization.id, 7)
		const ids = all.map((p) => p.id)
		expect(await start(ctx, ids.slice(0, 4), h.deps, 'glitchy')).toEqual({
			ok: false,
			error: 'invalid_style',
		})
		expect(await start(ctx, ids.slice(0, 2), h.deps)).toEqual({
			ok: false,
			error: 'not_enough_photos',
		})
		expect(await start(ctx, [ids[0]!, ids[0]!, ids[1]!], h.deps)).toEqual({
			ok: false,
			error: 'not_enough_photos',
		})
		expect(await start(ctx, ids, h.deps)).toEqual({
			ok: false,
			error: 'too_many_photos',
		})
		expect((await start(ctx, ids.slice(0, 3), h.deps)).ok).toBe(true)
	})

	it("only takes this organization's own photos", async () => {
		const ctx = await setup()
		const other = await setup()
		const h = harness()
		const own = await photos(ctx.organization.id, 2)
		const foreign = await photo(other.organization.id)
		const result = await start(
			ctx,
			[...own.map((p) => p.id), foreign.id],
			h.deps,
		)
		expect(result).toEqual({ ok: false, error: 'invalid_photos' })
		expect(
			await start(ctx, [...own.map((p) => p.id), 'does-not-exist'], h.deps),
		).toEqual({
			ok: false,
			error: 'invalid_photos',
		})
		expect(
			await db
				.select()
				.from(HeroVideoGeneration)
				.where(eq(HeroVideoGeneration.organizationId, ctx.organization.id)),
		).toHaveLength(0)
		expect(h.renderer.calls).toHaveLength(0)
	})

	it('refuses archived photos, files that are not photos and photos still processing', async () => {
		const ctx = await setup()
		const h = harness()
		const good = await photos(ctx.organization.id, 2)
		const archived = await photo(ctx.organization.id, {
			archivedAt: new Date(NOW),
		})
		const pdf = await photo(ctx.organization.id, {
			mimeType: 'application/pdf',
		})
		const video = await photo(ctx.organization.id, { mimeType: 'video/mp4' })
		const processing = await photo(ctx.organization.id, {
			status: 'processing',
		})
		const ids = good.map((p) => p.id)
		expect(await start(ctx, [...ids, archived.id], h.deps)).toEqual({
			ok: false,
			error: 'invalid_photos',
		})
		expect(await start(ctx, [...ids, pdf.id], h.deps)).toEqual({
			ok: false,
			error: 'invalid_photos',
		})
		expect(await start(ctx, [...ids, video.id], h.deps)).toEqual({
			ok: false,
			error: 'invalid_photos',
		})
		expect(await start(ctx, [...ids, processing.id], h.deps)).toEqual({
			ok: false,
			error: 'asset_not_ready',
		})
	})

	it('allows a limited number a day and one at a time', async () => {
		const ctx = await setup()
		const h = harness()
		const ids = (await photos(ctx.organization.id)).map((p) => p.id)
		const first = await start(ctx, ids, h.deps)
		expect(first.ok).toBe(true)
		expect(await start(ctx, ids, h.deps)).toEqual({
			ok: false,
			error: 'already_running',
		})
		const other = await setup()
		const otherIds = (await photos(other.organization.id)).map((p) => p.id)
		// Another organization is not held up by it.
		expect((await start(other, otherIds, harness().deps)).ok).toBe(true)

		const busy = await setup()
		const busyIds = (await photos(busy.organization.id)).map((p) => p.id)
		for (let i = 0; i < HERO_VIDEO_MAX_PER_DAY; i++) {
			await db.insert(HeroVideoGeneration).values({
				organizationId: busy.organization.id,
				style: 'slow_pans',
				photoAssetIds: JSON.stringify(busyIds),
				durationSeconds: 12,
				status: i === 0 ? 'failed' : 'discarded',
				createdAt: new Date(NOW - 3_600_000),
			})
		}
		expect(await start(busy, busyIds, h.deps)).toEqual({
			ok: false,
			error: 'daily_limit',
		})
		// Yesterday's do not count.
		await db
			.update(HeroVideoGeneration)
			.set({ createdAt: new Date(NOW - 25 * 3_600_000) })
			.where(eq(HeroVideoGeneration.organizationId, busy.organization.id))
		expect((await start(busy, busyIds, harness().deps)).ok).toBe(true)
	})

	it('two clicks at once make one request: the later one is taken back out', async () => {
		const ctx = await setup()
		const h = harness()
		const chosen = await photos(ctx.organization.id, 3)
		const ids = chosen.map((p) => p.id)
		const results = await Promise.all([
			start(ctx, ids, h.deps),
			start(ctx, ids, h.deps),
		])
		expect(results.filter((r) => r.ok)).toHaveLength(1)
		expect(results.filter((r) => !r.ok)).toEqual([
			{ ok: false, error: 'already_running' },
		])
		expect(
			await db
				.select()
				.from(HeroVideoGeneration)
				.where(eq(HeroVideoGeneration.organizationId, ctx.organization.id)),
		).toHaveLength(1)
	})

	it('records the request, starts the background job and answers at once', async () => {
		const ctx = await setup()
		const h = harness()
		const chosen = await photos(ctx.organization.id, 5)
		const result = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
			'warm_fade',
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const row = await generation(result.generationId)
		expect(row).toMatchObject({
			status: 'queued',
			style: 'warm_fade',
			selection: 'picked',
			requestedById: ctx.userId,
		})
		expect(JSON.parse(row.photoAssetIds)).toEqual(chosen.map((p) => p.id))
		expect(row.durationSeconds).toBeGreaterThanOrEqual(8)
		expect(row.durationSeconds).toBeLessThanOrEqual(12)
		expect(h.wake).toHaveBeenCalledWith(result.generationId)
		// Nothing is rendered in the request itself.
		expect(h.renderer.calls).toHaveLength(0)
	})

	it('lets Menuza choose, preferring Featured photos, and only from ready library photos', async () => {
		const ctx = await setup()
		const h = harness()
		const plain = await photos(ctx.organization.id, 4)
		const featured = await photo(ctx.organization.id)
		await db.insert(OrganizationMediaTag).values({
			assetId: featured.id,
			organizationId: ctx.organization.id,
			tag: 'featured',
		})
		const dish = await photo(ctx.organization.id)
		await db.insert(OrganizationMenuItem).values({
			organizationId: ctx.organization.id,
			displayName: 'Margherita',
			imageKeys: JSON.stringify([dish.id]),
		})
		await photo(ctx.organization.id, { archivedAt: new Date(NOW) })
		await photo(ctx.organization.id, { status: 'processing' })
		await photo(ctx.organization.id, { source: 'hero-video' })
		await photo(ctx.organization.id, { width: 200, height: 100 })
		await photo(ctx.organization.id, { mimeType: 'image/gif' })
		const result = await start(ctx, [], h.deps, 'slow_pans', { auto: true })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const row = await generation(result.generationId)
		const ids = JSON.parse(row.photoAssetIds) as string[]
		expect(row.selection).toBe('auto')
		expect(ids[0]).toBe(featured.id)
		expect(ids[1]).toBe(dish.id)
		expect(ids).toHaveLength(6)
		const allowed = new Set([...plain.map((p) => p.id), featured.id, dish.id])
		expect(ids.every((id) => allowed.has(id))).toBe(true)
	})

	it('says so when the library has too few photos to choose from', async () => {
		const ctx = await setup()
		await photos(ctx.organization.id, 2)
		expect(
			await start(ctx, [], harness().deps, 'slow_pans', { auto: true }),
		).toEqual({ ok: false, error: 'not_enough_photos' })
	})
})

describe('making the clip in the background (#301)', () => {
	async function ready(
		ctx: Awaited<ReturnType<typeof setup>>,
		extra: { pageId?: string } = {},
	) {
		const h = harness()
		const chosen = await photos(ctx.organization.id, 4)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
			'slow_pans',
			extra,
		)
		if (!started.ok) throw new Error(started.error)
		const outcome = await processHeroVideo(started.generationId, h.deps)
		return { h, chosen, id: started.generationId, outcome }
	}

	it('hands only the chosen photos to the renderer, in order, with short-lived links', async () => {
		const ctx = await setup()
		const { h, chosen, outcome } = await ready(ctx)
		expect(outcome).toEqual({ ok: true, status: 'ready' })
		expect(h.renderer.calls).toHaveLength(1)
		const call = h.renderer.calls[0]!
		expect(call.stills).toHaveLength(4)
		expect(call.stills.map((still) => still.url)).toEqual(
			chosen.map((p) => `https://signed.test/${p.objectKey}?x=1`),
		)
		expect(call.stills.every((still) => still.mimeType === 'image/jpeg')).toBe(
			true,
		)
		// The plan: 8 to 12 seconds, silent, looping, 16:9.
		expect(call.plan.silent).toBe(true)
		expect(call.plan.durationS).toBeGreaterThanOrEqual(8)
		expect(call.plan.durationS).toBeLessThanOrEqual(12)
		// Nothing about the organization or a person goes out.
		expect(JSON.stringify(call.plan)).not.toContain(ctx.organization.id)
	})

	it('stores the clip and a poster as draft assets linked to the first photo, and tells the requester', async () => {
		const ctx = await setup()
		const page = await pageWithHero(ctx)
		const { h, chosen, id } = await ready(ctx, { pageId: page.pageId })
		const row = await generation(id)
		expect(row.status).toBe('ready')
		const [video] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.videoAssetId!))
		const [poster] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.posterAssetId!))
		expect(video).toMatchObject({
			mimeType: 'video/mp4',
			source: 'hero-video',
			status: 'draft',
			parentAssetId: chosen[0]!.id,
			width: 1280,
			height: 720,
		})
		expect(poster).toMatchObject({
			mimeType: 'image/jpeg',
			source: 'hero-video',
			status: 'draft',
			parentAssetId: chosen[0]!.id,
		})
		expect(h.stored.map((file) => file.mimeType)).toEqual([
			'video/mp4',
			'image/jpeg',
		])
		// The poster is the restaurant's own first photo.
		expect(new TextDecoder().decode(h.stored[1]!.bytes)).toBe(
			`bytes-of:${chosen[0]!.objectKey}`,
		)
		const [notice] = await db
			.select()
			.from(Notification)
			.where(eq(Notification.entityId, id))
		expect(notice).toMatchObject({
			userId: ctx.userId,
			organizationId: ctx.organization.id,
			type: 'hero-video-ready',
		})
		expect(JSON.parse(notice!.payload)).toMatchObject({
			orgSlug: ctx.organization.slug,
			pageId: page.pageId,
		})
	})

	it('leaves the live hero alone until the operator accepts', async () => {
		const ctx = await setup()
		const page = await pageWithHero(ctx)
		const { id } = await ready(ctx, { pageId: page.pageId })
		const [section] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, page.sectionId))
		expect(JSON.parse(section!.config)).toEqual(page.config)
		expect((await generation(id)).status).toBe('ready')
	})

	it('keeps the preview private until it is accepted, then serves it to visitors', async () => {
		const ctx = await setup()
		const page = await pageWithHero(ctx)
		const { id } = await ready(ctx, { pageId: page.pageId })
		const row = await generation(id)
		const [video] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, row.videoAssetId!))
		const anonymous = new Request('http://localhost/resources/videos/source')
		// A draft needs membership: a visitor is refused.
		expect(isPublicMediaAsset(video!)).toBe(false)
		await expect(
			authorizeRegisteredObject(anonymous, video!.objectKey),
		).rejects.toBeTruthy()
		const accepted = await acceptHeroVideo({
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			generationId: id,
			sectionId: page.sectionId,
		})
		expect(accepted.ok).toBe(true)
		const [after] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, video!.id))
		expect(isPublicMediaAsset(after!)).toBe(true)
		expect(
			await authorizeRegisteredObject(anonymous, after!.objectKey),
		).toMatchObject({
			isPublic: true,
		})
	})

	it('fails cleanly, touching nothing, when the renderer fails or returns too much', async () => {
		for (const [renderer, error] of [
			[createMockHeroVideoRenderer({ fail: true }), 'renderer_failed'],
			[createMockHeroVideoRenderer({ tooLarge: true }), 'output_too_large'],
		] as const) {
			const ctx = await setup()
			const page = await pageWithHero(ctx)
			const h = harness({ renderer })
			const chosen = await photos(ctx.organization.id, 3)
			const started = await start(
				ctx,
				chosen.map((p) => p.id),
				h.deps,
				'quick_cuts',
				{
					pageId: page.pageId,
				},
			)
			if (!started.ok) throw new Error(started.error)
			// A renderer that only fails is tried again; the last attempt fails the
			// request for good. Too large an answer will not change: fails at once.
			let outcome = await processHeroVideo(started.generationId, h.deps)
			if (error === 'renderer_failed') {
				for (let attempt = 1; attempt < 3; attempt++) {
					expect(outcome).toMatchObject({ ok: false, retry: true })
					expect(await generation(started.generationId)).toMatchObject({
						status: 'queued',
					})
					outcome = await processHeroVideo(started.generationId, h.deps)
				}
			}
			expect(outcome).toMatchObject({ ok: false, error })
			expect(outcome).not.toHaveProperty('retry')
			expect(await generation(started.generationId)).toMatchObject({
				status: 'failed',
				error,
			})
			expect(h.stored).toHaveLength(0)
			const [section] = await db
				.select()
				.from(WebsitePageSection)
				.where(eq(WebsitePageSection.id, page.sectionId))
			expect(JSON.parse(section!.config)).toEqual(page.config)
			const [notice] = await db
				.select()
				.from(Notification)
				.where(eq(Notification.entityId, started.generationId))
			expect(notice?.type).toBe('hero-video-failed')
		}
	})

	it('a renderer that recovers is not a failure: the request is made on a later attempt, nobody is told of the first', async () => {
		const ctx = await setup()
		let calls = 0
		const real = createMockHeroVideoRenderer()
		const h = harness({
			renderer: {
				name: 'mock',
				render: async (input) => {
					calls++
					return calls === 1
						? ({ ok: false, error: 'renderer_failed' } as const)
						: real.render(input)
				},
			},
		})
		const chosen = await photos(ctx.organization.id, 3)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
		)
		if (!started.ok) throw new Error(started.error)
		expect(await processHeroVideo(started.generationId, h.deps)).toMatchObject({
			ok: false,
			retry: true,
		})
		expect(
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.entityId, started.generationId)),
		).toHaveLength(0)
		expect(await processHeroVideo(started.generationId, h.deps)).toEqual({
			ok: true,
			status: 'ready',
		})
	})

	it('a request the renderer could not make does not use up a daily try', async () => {
		const ctx = await setup()
		const h = harness({ renderer: createMockHeroVideoRenderer({ fail: true }) })
		const chosen = await photos(ctx.organization.id, 3)
		for (let i = 0; i < HERO_VIDEO_MAX_PER_DAY + 1; i++) {
			const started = await start(
				ctx,
				chosen.map((p) => p.id),
				h.deps,
			)
			if (!started.ok) throw new Error(`try ${i}: ${started.error}`)
			for (let attempt = 0; attempt < 3; attempt++) {
				await processHeroVideo(started.generationId, h.deps)
			}
			expect(await generation(started.generationId)).toMatchObject({
				status: 'failed',
			})
		}
	})

	it('removes what it stored when saving the result fails', async () => {
		const ctx = await setup()
		let calls = 0
		const h = harness({
			store: vi.fn(async (input) => {
				calls++
				if (calls === 2) throw new Error('storage down')
				return `orgs/${input.organizationId}/media/hero-video/${crypto.randomUUID()}.mp4`
			}),
		})
		const chosen = await photos(ctx.organization.id, 3)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
		)
		if (!started.ok) throw new Error(started.error)
		const outcome = await processHeroVideo(started.generationId, h.deps)
		expect(outcome).toMatchObject({ ok: false, error: 'renderer_failed' })
		expect(h.removed).toHaveLength(1)
		expect(
			await db
				.select()
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
						eq(OrganizationMediaAsset.source, 'hero-video'),
					),
				),
		).toHaveLength(0)
	})

	it('fails when a chosen photo was deleted meanwhile, and only one caller renders a job', async () => {
		const ctx = await setup()
		const h = harness()
		const chosen = await photos(ctx.organization.id, 4)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
		)
		if (!started.ok) throw new Error(started.error)
		await db
			.delete(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, chosen[2]!.id))
		const [a, b] = await Promise.all([
			processHeroVideo(started.generationId, h.deps),
			processHeroVideo(started.generationId, h.deps),
		])
		const outcomes = [a, b]
		expect(
			outcomes.filter((o) => !o.ok && o.error === 'invalid_photos'),
		).toHaveLength(1)
		expect(outcomes.filter((o) => !o.ok && o.error === 'skipped')).toHaveLength(
			1,
		)
		expect(h.renderer.calls).toHaveLength(0)
	})
})

describe('the preview, accept and discard (#301)', () => {
	async function made() {
		const ctx = await setup()
		const page = await pageWithHero(ctx)
		const h = harness()
		const chosen = await photos(ctx.organization.id, 4)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
			'slow_pans',
			{
				pageId: page.pageId,
			},
		)
		if (!started.ok) throw new Error(started.error)
		await processHeroVideo(started.generationId, h.deps)
		return { ctx, page, h, id: started.generationId }
	}

	it("lists the preview with its links, and today's use", async () => {
		const { ctx, id } = await made()
		const list = await listHeroVideos(ctx.organization.id, NOW)
		expect(list.usedToday).toBe(1)
		expect(list.limit).toBe(HERO_VIDEO_MAX_PER_DAY)
		expect(list.generations[0]).toMatchObject({
			id,
			status: 'ready',
			error: null,
		})
		expect(list.generations[0]!.videoUrl).toContain(
			'/resources/videos/source?objectKey=',
		)
		expect(list.generations[0]!.posterUrl).toContain(
			'/resources/images?objectKey=',
		)
	})

	it('accepting puts the clip and its poster in the hero, and nothing else changes', async () => {
		const { ctx, page, id } = await made()
		const result = await acceptHeroVideo({
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			generationId: id,
			sectionId: page.sectionId,
		})
		expect(result.ok).toBe(true)
		const [section] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, page.sectionId))
		const config = JSON.parse(section!.config) as Record<string, unknown>
		expect(config).toMatchObject({
			assetType: 'video',
			videoAutoPlay: true,
			videoLoop: true,
			videoMuted: true,
			videoControls: false,
			// What was there stays: the slideshow and the heading.
			heading: 'Welcome',
			slides: page.config.slides,
		})
		expect(String(config.videoSrc)).toContain(
			'/resources/videos/source?objectKey=',
		)
		expect(String(config.videoPoster)).toContain('/resources/images?objectKey=')
		const row = await generation(id)
		expect(row).toMatchObject({ status: 'accepted', acceptedById: ctx.userId })
		const assets = await db
			.select({ status: OrganizationMediaAsset.status })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
					eq(OrganizationMediaAsset.source, 'hero-video'),
				),
			)
		expect(assets.map((a) => a.status)).toEqual(['ready', 'ready'])
	})

	it("refuses to accept what is not ready, a section that is not a hero, or another organization's section", async () => {
		const ctx = await setup()
		const page = await pageWithHero(ctx)
		const h = harness()
		const chosen = await photos(ctx.organization.id, 3)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
		)
		if (!started.ok) throw new Error(started.error)
		expect(
			await acceptHeroVideo({
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				generationId: started.generationId,
				sectionId: page.sectionId,
			}),
		).toEqual({ ok: false, error: 'not_ready' })
		await processHeroVideo(started.generationId, h.deps)
		const [content] = await db
			.insert(WebsitePageSection)
			.values({
				pageId: page.pageId,
				type: 'content',
				position: 2,
				config: '{}',
			} as never)
			.returning({ id: WebsitePageSection.id })
		expect(
			await acceptHeroVideo({
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				generationId: started.generationId,
				sectionId: content!.id,
			}),
		).toEqual({ ok: false, error: 'not_found' })
		const other = await setup()
		const otherPage = await pageWithHero(other)
		expect(
			await acceptHeroVideo({
				organizationId: ctx.organization.id,
				userId: ctx.userId,
				generationId: started.generationId,
				sectionId: otherPage.sectionId,
			}),
		).toEqual({ ok: false, error: 'not_found' })
		expect(
			await acceptHeroVideo({
				organizationId: other.organization.id,
				userId: other.userId,
				generationId: started.generationId,
				sectionId: otherPage.sectionId,
			}),
		).toEqual({ ok: false, error: 'not_found' })
		const [untouched] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, otherPage.sectionId))
		expect(JSON.parse(untouched!.config)).toEqual(otherPage.config)
	})

	it('discarding removes the draft files and the live hero never changed', async () => {
		const { ctx, page, h, id } = await made()
		const row = await generation(id)
		const result = await discardHeroVideo(
			{ organizationId: ctx.organization.id, generationId: id },
			{ remove: h.deps.remove },
		)
		expect(result).toEqual({ ok: true })
		expect(h.removed).toHaveLength(2)
		expect(
			await db
				.select()
				.from(OrganizationMediaAsset)
				.where(eq(OrganizationMediaAsset.id, row.videoAssetId!)),
		).toHaveLength(0)
		expect(await generation(id)).toMatchObject({ status: 'discarded' })
		const [section] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, page.sectionId))
		expect(JSON.parse(section!.config)).toEqual(page.config)
		// Not another organization's, and not one in use.
		const other = await setup()
		expect(
			await discardHeroVideo({
				organizationId: other.organization.id,
				generationId: id,
			}),
		).toEqual({
			ok: false,
			error: 'not_found',
		})
	})

	it('cannot discard what was accepted', async () => {
		const { ctx, page, id } = await made()
		await acceptHeroVideo({
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			generationId: id,
			sectionId: page.sectionId,
		})
		expect(
			await discardHeroVideo({
				organizationId: ctx.organization.id,
				generationId: id,
			}),
		).toEqual({
			ok: false,
			error: 'not_ready',
		})
	})
})

describe('the hourly sweep (#301)', () => {
	it('renders a request that was never woken and fails one that ran out of attempts', async () => {
		const ctx = await setup()
		const h = harness()
		const chosen = await photos(ctx.organization.id, 4)
		const started = await start(
			ctx,
			chosen.map((p) => p.id),
			h.deps,
		)
		if (!started.ok) throw new Error(started.error)
		// Fresh requests are left to their own wake-up.
		expect(await sweepHeroVideos(h.deps)).toMatchObject({ found: 0 })
		const later = { ...h.deps, now: () => NOW + HERO_VIDEO_STALE_MS + 60_000 }
		await db
			.update(HeroVideoGeneration)
			.set({ updatedAt: new Date(NOW - HERO_VIDEO_STALE_MS - 60_000) })
			.where(eq(HeroVideoGeneration.id, started.generationId))
		const swept = await sweepHeroVideos(later)
		expect(swept.found).toBeGreaterThanOrEqual(1)
		expect((await generation(started.generationId)).status).toBe('ready')

		const doomed = await setup()
		const doomedPhotos = await photos(doomed.organization.id, 3)
		const [row] = await db
			.insert(HeroVideoGeneration)
			.values({
				organizationId: doomed.organization.id,
				requestedById: doomed.userId,
				style: 'slow_pans',
				photoAssetIds: JSON.stringify(doomedPhotos.map((p) => p.id)),
				durationSeconds: 9,
				status: 'rendering',
				attempts: 3,
				startedAt: new Date(NOW - 3 * HERO_VIDEO_STALE_MS),
			})
			.returning({ id: HeroVideoGeneration.id })
		await db
			.update(HeroVideoGeneration)
			.set({ updatedAt: new Date(NOW - 3 * HERO_VIDEO_STALE_MS) })
			.where(eq(HeroVideoGeneration.id, row!.id))
		const result = await sweepHeroVideos(later)
		expect(result.failed).toBeGreaterThanOrEqual(1)
		expect(await generation(row!.id)).toMatchObject({ status: 'failed' })
	})
})
