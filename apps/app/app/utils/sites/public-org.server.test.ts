import { faker } from '@faker-js/faker'
import {
	and,
	db,
	eq,
	Organization,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as sitePageLoader } from '#app/routes/resources+/sites.page.ts'
import { createOrganization } from '#app/utils/organization/organizations.server.ts'
import { signSitePreviewToken } from '#app/utils/sites/preview-token.server.ts'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	provisionTenantDatabase: vi.fn(),
	deprovisionTenantDatabase: vi.fn(),
}))

type PublicPageBody = {
	sections: Array<{ type: string; config: Record<string, unknown> }>
}

async function fetchHome(slug: string, query = '') {
	const response = (await sitePageLoader({
		request: new Request(
			`http://localhost/resources/sites/page?slug=${slug}&home=true${query}`,
		),
		params: {},
		context: {},
	} as never)) as Response
	expect(response.status).toBe(200)
	return (await response.json()) as PublicPageBody
}

function heroHeading(body: PublicPageBody) {
	return body.sections.find((section) => section.type === 'hero')?.config
		.heading
}

describe('public site pages', () => {
	beforeEach(() => {
		vi.mocked(provisionTenantDatabase).mockReset().mockResolvedValue({
			region: 'us',
		})
		vi.mocked(deprovisionTenantDatabase).mockReset().mockResolvedValue({
			region: 'us',
		})
	})

	it('serves a new organization home page as published, not the edits made after it', async () => {
		const user = await insertTestUser()
		const organization = await createOrganization({
			name: 'Snapshot Bakery',
			slug: `snapshot-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
			userId: user.id,
		})
		await db
			.update(Organization)
			.set({ sitePublished: true })
			.where(eq(Organization.id, organization.id))

		const [home] = await db
			.select({ id: WebsitePage.id })
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, organization.id),
					eq(WebsitePage.isHomePage, true),
				),
			)
		const [hero] = await db
			.select({ id: WebsitePageSection.id, config: WebsitePageSection.config })
			.from(WebsitePageSection)
			.where(
				and(
					eq(WebsitePageSection.pageId, home!.id),
					eq(WebsitePageSection.type, 'hero'),
				),
			)
		// What the editor's section intents write: the working copy, nothing else.
		await db
			.update(WebsitePageSection)
			.set({
				config: JSON.stringify({
					...(JSON.parse(hero!.config) as Record<string, unknown>),
					heading: 'Unannounced spring menu',
				}),
			})
			.where(eq(WebsitePageSection.id, hero!.id))
		await db.insert(WebsitePageSection).values({
			pageId: home!.id,
			type: 'content',
			position: 99,
			config: JSON.stringify({ title: 'Draft price list' }),
		})

		const published = await fetchHome(organization.slug)
		expect(heroHeading(published)).toBe('Welcome to Snapshot Bakery')
		expect(JSON.stringify(published)).not.toContain('Unannounced spring menu')
		expect(JSON.stringify(published)).not.toContain('Draft price list')

		// Editors holding a signed preview token still see their working copy.
		const preview = await fetchHome(
			organization.slug,
			`&preview=true&pt=${signSitePreviewToken(organization.id)}`,
		)
		expect(heroHeading(preview)).toBe('Unannounced spring menu')
	})
})
