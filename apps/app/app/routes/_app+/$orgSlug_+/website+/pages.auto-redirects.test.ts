/**
 * #88: a published page that changes address, or is deleted, keeps its old
 * address working with a 301 the public site applies.
 */
import {
	and,
	db,
	eq,
	Organization,
	WebsitePage,
	WebsiteRedirect,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as sitesLoader } from '#app/routes/resources+/sites.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action as editorAction } from './pages.$pageId.tsx'
import { action as listAction } from './pages._index.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return {
		...actual,
		purgeOrganizationSiteCache: vi.fn(),
		getSiteCacheVersion: vi.fn().mockResolvedValue(null),
	}
})

async function setup(options: { published: boolean }) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'About',
			slug: 'about-us',
			status: options.published ? 'published' : 'draft',
			publishedData: options.published ? '[]' : null,
		})
		.returning({ id: WebsitePage.id })
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie, pageId: page!.id, userId: user.id }
}

async function rename(
	ctx: { organization: { slug: string }; cookie: string; pageId: string },
	slug: string,
) {
	const body = new URLSearchParams()
	body.set('intent', 'update-page-settings')
	body.set('slug', slug)
	body.set('seoNoIndex', 'false')
	const response = (await editorAction({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}`,
			{ method: 'POST', body },
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
		context: {},
	} as never)) as Response
	expect(response.status).toBe(200)
	return (await response.json()) as {
		status: string
		redirect: { id: string; fromPath: string; toPath: string } | null
	}
}

async function redirectsOf(organizationId: string) {
	return db
		.select({
			id: WebsiteRedirect.id,
			fromPath: WebsiteRedirect.fromPath,
			toPath: WebsiteRedirect.toPath,
			statusCode: WebsiteRedirect.statusCode,
			source: WebsiteRedirect.source,
		})
		.from(WebsiteRedirect)
		.where(eq(WebsiteRedirect.organizationId, organizationId))
}

describe('automatic redirects (#88)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('renaming a published page adds a 301 the public site serves', async () => {
		const ctx = await setup({ published: true })
		const result = await rename(ctx, 'our-story')
		expect(result.redirect).toMatchObject({
			fromPath: '/about-us',
			toPath: '/our-story',
		})
		expect(await redirectsOf(ctx.organization.id)).toEqual([
			expect.objectContaining({
				fromPath: '/about-us',
				toPath: '/our-story',
				statusCode: 301,
				source: 'page_rename',
			}),
		])
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()

		// Sites reads redirects from the public organization payload and answers
		// the old path with this 301 before rendering anything.
		const response = (await sitesLoader({
			request: new Request(
				`http://localhost/resources/sites?slug=${ctx.organization.slug}`,
			),
			params: {},
			context: {},
		} as never)) as Response
		const payload = (await response.json()) as {
			redirects: Array<{ fromPath: string; toPath: string; statusCode: number }>
		}
		expect(payload.redirects).toEqual([
			expect.objectContaining({
				fromPath: '/about-us',
				toPath: '/our-story',
				statusCode: 301,
			}),
		])
	})

	it('renaming a never-published draft adds nothing', async () => {
		const ctx = await setup({ published: false })
		const result = await rename(ctx, 'our-story')
		expect(result.redirect).toBeNull()
		expect(await redirectsOf(ctx.organization.id)).toEqual([])
	})

	it('renaming back removes the conflicting redirect and adds the reverse one', async () => {
		const ctx = await setup({ published: true })
		await rename(ctx, 'our-story')
		await rename(ctx, 'about-us')
		expect(await redirectsOf(ctx.organization.id)).toEqual([
			expect.objectContaining({ fromPath: '/our-story', toPath: '/about-us' }),
		])
	})

	it('collapses an existing chain to one hop', async () => {
		const ctx = await setup({ published: true })
		await rename(ctx, 'b')
		await rename(ctx, 'c')
		const rows = await redirectsOf(ctx.organization.id)
		expect(rows).toHaveLength(2)
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ fromPath: '/about-us', toPath: '/c' }),
				expect.objectContaining({ fromPath: '/b', toPath: '/c' }),
			]),
		)
	})

	it("keeps the operator's own redirect from the old path", async () => {
		const ctx = await setup({ published: true })
		await db.insert(WebsiteRedirect).values({
			organizationId: ctx.organization.id,
			fromPath: '/about-us',
			toPath: '/contact',
			source: 'manual',
		})
		const result = await rename(ctx, 'our-story')
		expect(result.redirect).toBeNull()
		expect(await redirectsOf(ctx.organization.id)).toEqual([
			expect.objectContaining({ fromPath: '/about-us', toPath: '/contact' }),
		])
	})

	it('undo removes only the redirect the rename added', async () => {
		const ctx = await setup({ published: true })
		const { redirect } = await rename(ctx, 'our-story')
		const body = new URLSearchParams()
		body.set('intent', 'undo-auto-redirect')
		body.set('id', redirect!.id)
		const response = (await editorAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages/${ctx.pageId}`,
				{ method: 'POST', body },
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug, pageId: ctx.pageId },
			context: {},
		} as never)) as Response
		expect(response.status).toBe(200)
		expect(await redirectsOf(ctx.organization.id)).toEqual([])
	})

	it('deleting a published page redirects its path to the chosen page', async () => {
		const ctx = await setup({ published: true })
		const [menuPage] = await db
			.insert(WebsitePage)
			.values({
				organizationId: ctx.organization.id,
				createdById: ctx.userId,
				title: 'Contact',
				slug: 'contact',
				status: 'published',
			})
			.returning({ id: WebsitePage.id })
		expect(menuPage).toBeTruthy()

		const post = async (fields: Record<string, string>) => {
			const body = new FormData()
			for (const [key, value] of Object.entries(fields)) body.set(key, value)
			return (await listAction({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${ctx.organization.slug}/website/pages?index`,
					{ method: 'POST', body },
					ctx.cookie,
				),
				params: { orgSlug: ctx.organization.slug },
				context: {},
			} as never)) as Response
		}

		// A destination that is not a published page of this site is refused.
		const refused = await post({
			intent: 'delete-page',
			pageId: ctx.pageId,
			redirectTo: 'https://evil.example',
		})
		expect(refused.status).toBe(400)

		const response = await post({
			intent: 'delete-page',
			pageId: ctx.pageId,
			redirectTo: '/contact',
		})
		expect(response.status).toBe(200)
		const [page] = await db
			.select({ id: WebsitePage.id })
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, ctx.organization.id),
					eq(WebsitePage.slug, 'about-us'),
				),
			)
		expect(page).toBeUndefined()
		expect(await redirectsOf(ctx.organization.id)).toEqual([
			expect.objectContaining({
				fromPath: '/about-us',
				toPath: '/contact',
				statusCode: 301,
				source: 'page_delete',
			}),
		])
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
	})

	it('deleting with no choice sends visitors home', async () => {
		const ctx = await setup({ published: true })
		const body = new FormData()
		body.set('intent', 'delete-page')
		body.set('pageId', ctx.pageId)
		const response = (await listAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages?index`,
				{ method: 'POST', body },
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as Response
		expect(response.status).toBe(200)
		expect(await redirectsOf(ctx.organization.id)).toEqual([
			expect.objectContaining({ fromPath: '/about-us', toPath: '/' }),
		])
	})
})
