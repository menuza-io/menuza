import {
	db,
	eq,
	Organization,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as sitePageLoader } from '#app/routes/resources+/sites.page.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action } from './pages._index.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn() }
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	const customDomain = `${organization.slug}.example.com`
	await db
		.update(Organization)
		.set({ sitePublished: true, customDomain })
		.where(eq(Organization.id, organization.id))
	const [page] = await db
		.insert(WebsitePage)
		.values({
			organizationId: organization.id,
			createdById: user.id,
			title: 'About',
			slug: 'about',
			status: 'draft',
		})
		.returning({ id: WebsitePage.id })
	const [section] = await db
		.insert(WebsitePageSection)
		.values({
			pageId: page!.id,
			type: 'content',
			position: 0,
			config: JSON.stringify({ title: 'Our story' }),
		})
		.returning({ id: WebsitePageSection.id })
	const { cookie } = await createTestSession(user.id)
	return {
		organization: { ...organization, customDomain },
		cookie,
		pageId: page!.id,
		sectionId: section!.id,
	}
}

async function post(
	orgSlug: string,
	cookie: string,
	fields: Record<string, string>,
) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return (await action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${orgSlug}/website/pages?index`,
			{ method: 'POST', body },
			cookie,
		),
		params: { orgSlug },
		context: {},
	} as never)) as Response
}

async function fetchSitePage(orgSlug: string, pageSlug: string) {
	try {
		return (await sitePageLoader({
			request: new Request(
				`http://localhost/resources/sites/page?slug=${orgSlug}&page=${pageSlug}`,
			),
			params: {},
			context: {},
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

describe('website pages list actions', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockReset().mockResolvedValue(true)
	})

	it('publishes a snapshot, so later edits stay off the public site', async () => {
		const { organization, cookie, pageId, sectionId } = await setup()

		const response = await post(organization.slug, cookie, {
			intent: 'publish-page',
			pageId,
		})
		expect(response.status).toBe(200)

		// What the editor's update-section intent writes: the working copy only.
		await db
			.update(WebsitePageSection)
			.set({ config: JSON.stringify({ title: 'Unannounced merger' }) })
			.where(eq(WebsitePageSection.id, sectionId))

		const sitePage = await fetchSitePage(organization.slug, 'about')
		expect(sitePage.status).toBe(200)
		const body = (await sitePage.json()) as {
			sections: Array<{ type: string; config: Record<string, unknown> }>
		}
		expect(
			body.sections.find((section) => section.type === 'content')?.config.title,
		).toBe('Our story')
		expect(JSON.stringify(body)).not.toContain('Unannounced merger')
	})

	it('purges the public site cache after publish, unpublish and delete', async () => {
		const { organization, cookie, pageId } = await setup()

		for (const intent of ['publish-page', 'unpublish-page', 'delete-page']) {
			vi.mocked(purgeOrganizationSiteCache).mockClear()
			const response = await post(organization.slug, cookie, {
				intent,
				pageId,
			})
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ status: 'success' })
			expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
				organization.id,
				organization.slug,
				organization.customDomain,
			)
		}
		expect((await fetchSitePage(organization.slug, 'about')).status).toBe(404)
	})
})
