/**
 * #301: the Website hero video route. Starting only queues work; the live hero
 * is untouched; every action is guarded.
 */
import {
	db,
	eq,
	HeroVideoGeneration,
	OrganizationMediaAsset,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '#tests/mocks/index.ts'
import {
	callAction,
	callLoader,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import { action, loader } from './hero-video.ts'

// A renderer is set up for these tests; it is never called by the route.
vi.mock('#app/utils/website/hero-video/renderer.server.ts', () => ({
	isHeroVideoRendererConfigured: () => true,
	getHeroVideoRenderer: () => ({ name: 'mock', render: vi.fn() }),
}))

const wakes = vi.hoisted(() => ({ calls: 0 }))
beforeEach(() => {
	wakes.calls = 0
	server.use(
		http.post(/\/workflows\/hero-video\/start$/u, () => {
			wakes.calls++
			return HttpResponse.json({ success: true })
		}),
	)
})

async function setup(role: 'admin' | 'viewer' = 'admin', flag = true) {
	const ctx = await setupSeoOrganization(role)
	if (flag) await setOrgFlag(ctx.organization.id, 'website.hero_video', true)
	return ctx
}
async function photos(organizationId: string, count = 4) {
	const rows = []
	for (let i = 0; i < count; i++) {
		const [row] = await db
			.insert(OrganizationMediaAsset)
			.values({
				organizationId,
				objectKey: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.jpg`,
				mimeType: 'image/jpeg',
				width: 1600,
				height: 900,
			})
			.returning()
		rows.push(row!)
	}
	return rows
}
const url = (ctx: Awaited<ReturnType<typeof setup>>) =>
	`http://localhost:3000/${ctx.organization.slug}/website/hero-video`
const post = (
	ctx: Awaited<ReturnType<typeof setup>>,
	fields: Record<string, string | string[]>,
) =>
	callAction(action as never, {
		url: url(ctx),
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug },
		fields,
	})

describe('Website hero video route (#301)', () => {
	it('is 404 while the feature is off, for the list and every action', async () => {
		const ctx = await setup('admin', false)
		const listed = (await callLoader(loader as never, {
			url: url(ctx),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as Response
		expect(listed.status).toBe(404)
		expect(
			(await post(ctx, { intent: 'start', style: 'slow_pans', auto: 'true' }))
				.status,
		).toBe(404)
	})

	it('a viewer cannot start, accept or discard', async () => {
		const ctx = await setup('viewer')
		const attempts: Array<Record<string, string>> = [
			{ intent: 'start', style: 'slow_pans', auto: 'true' },
			{ intent: 'accept', generationId: 'x', sectionId: 'y' },
			{ intent: 'discard', generationId: 'x' },
		]
		for (const fields of attempts) {
			expect((await post(ctx, fields)).status).toBe(403)
		}
	})

	it('starting queues a background job and changes nothing on the website', async () => {
		const ctx = await setup()
		const chosen = await photos(ctx.organization.id)
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: ctx.organization.id,
				createdById: ctx.userId,
				title: 'Home',
				slug: 'home',
				isHomePage: true,
			} as never)
			.returning({ id: WebsitePage.id })
		const config = JSON.stringify({ assetType: 'image', imageUrl: '/live.jpg' })
		const [section] = await db
			.insert(WebsitePageSection)
			.values({ pageId: page!.id, type: 'hero', position: 1, config } as never)
			.returning({ id: WebsitePageSection.id })
		const response = await post(ctx, {
			intent: 'start',
			style: 'warm_fade',
			photoAssetIds: chosen.map((p) => p.id),
			pageId: page!.id,
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			ok: boolean
			generationId: string
		}
		expect(body.ok).toBe(true)
		const [row] = await db
			.select()
			.from(HeroVideoGeneration)
			.where(eq(HeroVideoGeneration.id, body.generationId))
		expect(row).toMatchObject({
			status: 'queued',
			style: 'warm_fade',
			pageId: page!.id,
		})
		expect(wakes.calls).toBe(1)
		const [after] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, section!.id))
		expect(after!.config).toBe(config)
		// The list now shows it, queued.
		const listed = (await callLoader(loader as never, {
			url: url(ctx),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as unknown as {
			generations: Array<{ status: string }>
			usedToday: number
		}
		expect(listed.generations[0]!.status).toBe('queued')
		expect(listed.usedToday).toBe(1)
	})

	it('answers with the reason for a refused request', async () => {
		const ctx = await setup()
		const chosen = await photos(ctx.organization.id, 2)
		const few = await post(ctx, {
			intent: 'start',
			style: 'slow_pans',
			photoAssetIds: chosen.map((p) => p.id),
		})
		expect(few.status).toBe(400)
		expect(await few.json()).toMatchObject({
			ok: false,
			error: 'not_enough_photos',
		})
		const style = await post(ctx, {
			intent: 'start',
			style: 'nope',
			auto: 'true',
		})
		expect(await style.json()).toMatchObject({ error: 'invalid_style' })
	})

	it('another organization cannot accept or discard a request', async () => {
		const ctx = await setup()
		const other = await setup()
		const chosen = await photos(ctx.organization.id)
		const started = (await (
			await post(ctx, {
				intent: 'start',
				style: 'slow_pans',
				photoAssetIds: chosen.map((p) => p.id),
			})
		).json()) as { generationId: string }
		expect(
			(
				await post(other, {
					intent: 'discard',
					generationId: started.generationId,
				})
			).status,
		).toBe(404)
		expect(
			(
				await post(other, {
					intent: 'accept',
					generationId: started.generationId,
					sectionId: 'x',
				})
			).status,
		).toBe(404)
		const [row] = await db
			.select()
			.from(HeroVideoGeneration)
			.where(eq(HeroVideoGeneration.id, started.generationId))
		expect(row!.status).toBe('queued')
	})
})
