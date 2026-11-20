/**
 * #248 through the real redirects route: unsafe destinations are refused with
 * a reason, existing ones are listed and keep working, and a redirect to an
 * unpublished page goes home with a 302 until the page is published again.
 */
import {
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
import { action as pageAction } from './pages._index.tsx'
import { action, loader } from './redirects.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return {
		...actual,
		purgeOrganizationSiteCache: vi.fn(),
		getSiteCacheVersion: vi.fn().mockResolvedValue(null),
	}
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	// Custom domains are unique across organizations.
	const domain = `acme-${organization.id.slice(0, 10)}.com`
	await db
		.update(Organization)
		.set({ sitePublished: true, customDomain: domain })
		.where(eq(Organization.id, organization.id))
	const { cookie } = await createTestSession(user.id)
	return {
		organization: { ...organization, customDomain: domain },
		domain,
		cookie,
	}
}
type Ctx = Awaited<ReturnType<typeof setup>>

async function save(ctx: Ctx, fields: Record<string, string>) {
	const response = await action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/redirects`,
			{ method: 'POST', body: new URLSearchParams(fields) },
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never).catch((thrown: unknown) => thrown)
	// A success redirects with a toast; a refusal is a JSON 400.
	const res = response as Response
	let body: Record<string, any> = {}
	if (res.headers.get('content-type')?.includes('json')) {
		body = (await res.json()) as Record<string, any>
	}
	return { status: res.status, body }
}

const create = (ctx: Ctx, toPath: string) =>
	save(ctx, {
		intent: 'create-redirect',
		fromPath: '/old',
		toPath,
		statusCode: '301',
	})

describe('redirect destinations (#248)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('refuses a destination with credentials', async () => {
		const ctx = await setup()
		const result = await create(ctx, 'https://user:pass@example.com/menu')
		expect(result.status).toBe(400)
		expect(result.body.destinationError).toEqual({
			code: 'credentials',
			suggestedPath: null,
		})
		expect(await db.select().from(WebsiteRedirect)).toHaveLength(0)
	})

	it('refuses a destination on the site’s own domain and offers the path', async () => {
		const ctx = await setup()
		const result = await create(ctx, `https://www.${ctx.domain}/menu?x=1`)
		expect(result.status).toBe(400)
		expect(result.body.destinationError).toEqual({
			code: 'own_domain',
			suggestedPath: '/menu?x=1',
		})
		// The offered path is accepted.
		const converted = await create(ctx, '/menu?x=1')
		expect(converted.status).not.toBe(400)
	})

	it('refuses plain http and system paths', async () => {
		const ctx = await setup()
		expect(
			(await create(ctx, 'http://example.com')).body.destinationError.code,
		).toBe('not_https')
		for (const path of ['/api/orders', '/login', '/profile']) {
			expect((await create(ctx, path)).body.destinationError.code).toBe(
				'system_path',
			)
		}
		expect((await create(ctx, 'https://example.com/menu')).status).not.toBe(400)
	})

	it('refuses the same on edit', async () => {
		const ctx = await setup()
		const [existing] = await db
			.insert(WebsiteRedirect)
			.values({
				organizationId: ctx.organization.id,
				fromPath: '/old',
				toPath: '/menu',
			})
			.returning({ id: WebsiteRedirect.id })
		const result = await save(ctx, {
			intent: 'update-redirect',
			id: existing!.id,
			fromPath: '/old',
			toPath: 'https://user:pw@example.com',
			statusCode: '301',
		})
		expect(result.status).toBe(400)
		expect(result.body.destinationError.code).toBe('credentials')
	})

	it('lists existing redirects that now fail, and they keep working until edited', async () => {
		const ctx = await setup()
		await db.insert(WebsiteRedirect).values([
			{
				organizationId: ctx.organization.id,
				fromPath: '/a',
				toPath: `https://${ctx.domain}/menu`,
			},
			{
				organizationId: ctx.organization.id,
				fromPath: '/b',
				toPath: 'https://user:pw@example.com',
			},
			{ organizationId: ctx.organization.id, fromPath: '/c', toPath: '/ok' },
		])
		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/redirects`,
				{},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as unknown as {
			redirects: Array<{
				fromPath: string
				destinationProblem: { code: string } | null
			}>
		}
		const problems = Object.fromEntries(
			data.redirects.map((r) => [
				r.fromPath,
				r.destinationProblem?.code ?? null,
			]),
		)
		expect(problems).toEqual({
			'/a': 'own_domain',
			'/b': 'credentials',
			'/c': null,
		})

		// Still served as before (the public payload is untouched by the check).
		const payload = (await (
			(await sitesLoader({
				request: new Request(
					`http://localhost/resources/sites?slug=${ctx.organization.slug}`,
				),
				params: {},
				context: {},
			} as never)) as Response
		).json()) as { redirects: Array<{ fromPath: string; toPath: string }> }
		expect(payload.redirects.map((r) => r.fromPath).sort()).toEqual([
			'/a',
			'/b',
			'/c',
		])
	})
})

describe('redirect to an unpublished page (#248)', () => {
	it('goes home with a 302 while the page is unpublished and returns to normal when published', async () => {
		const ctx = await setup()
		const user = await insertTestUser()
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: ctx.organization.id,
				createdById: user.id,
				title: 'Brunch',
				slug: 'brunch',
				status: 'published',
				publishedData: '[]',
			})
			.returning({ id: WebsitePage.id })
		await db.insert(WebsiteRedirect).values({
			organizationId: ctx.organization.id,
			fromPath: '/sunday',
			toPath: '/brunch',
			statusCode: 301,
		})
		const redirectsNow = async () =>
			(
				(await (
					(await sitesLoader({
						request: new Request(
							`http://localhost/resources/sites?slug=${ctx.organization.slug}`,
						),
						params: {},
						context: {},
					} as never)) as Response
				).json()) as {
					redirects: Array<{
						fromPath: string
						toPath: string
						statusCode: number
					}>
				}
			).redirects[0]!
		expect(await redirectsNow()).toMatchObject({
			toPath: '/brunch',
			statusCode: 301,
		})

		const unpublish = await pageAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'unpublish-page',
						pageId: page!.id,
						confirmRedirects: 'true',
					}),
				},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)
		expect((unpublish as Response).status ?? 200).toBe(200)
		expect(await redirectsNow()).toMatchObject({ toPath: '/', statusCode: 302 })
		// The stored redirect is untouched: it is the public payload that changed.
		const [stored] = await db
			.select()
			.from(WebsiteRedirect)
			.where(eq(WebsiteRedirect.fromPath, '/sunday'))
		expect(stored).toMatchObject({ toPath: '/brunch', statusCode: 301 })

		await pageAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/pages`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'publish-page',
						pageId: page!.id,
					}),
				},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)
		expect(await redirectsNow()).toMatchObject({
			toPath: '/brunch',
			statusCode: 301,
		})
	})
})
