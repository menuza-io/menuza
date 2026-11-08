import { db, Organization, WebsitePage } from '@repo/database'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { signSitePreviewToken } from '#app/utils/sites/preview-token.server.ts'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './sites.page.ts'

async function publishedHome() {
	const user = await createTestUser()
	const org = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, org.id))
	await db.insert(WebsitePage).values({
		organizationId: org.id,
		createdById: user.id,
		title: 'Home',
		slug: 'home',
		isHomePage: true,
		status: 'published',
	})
	return org
}

async function fetchPage(slug: string, query: string) {
	const request = new Request(
		`http://localhost/resources/sites/page?slug=${slug}&home=true${query}`,
	)
	const response = (await loader({
		request,
		params: {},
		context: {},
	} as never)) as Response
	return { response, body: (await response.json()) as Record<string, unknown> }
}

// Sites applies a caller-supplied sections/theme override only when this flag
// is set, so it must follow the signed token and nothing else.
describe('sites page preview verdict', () => {
	it('does not mark a request preview-verified without a token', async () => {
		const org = await publishedHome()
		const { body } = await fetchPage(org.slug, '&preview=true')
		expect(body.previewVerified).toBeUndefined()
	})

	it('does not mark a forged or other-org token verified', async () => {
		const org = await publishedHome()
		const other = await publishedHome()
		for (const pt of ['bad', signSitePreviewToken(other.id)]) {
			const { body } = await fetchPage(org.slug, `&preview=true&pt=${pt}`)
			expect(body.previewVerified).toBeUndefined()
		}
	})

	it('marks a validly signed token verified and keeps it out of shared caches', async () => {
		const org = await publishedHome()
		const { response, body } = await fetchPage(
			org.slug,
			`&preview=true&pt=${signSitePreviewToken(org.id)}`,
		)
		expect(body.previewVerified).toBe(true)
		expect(response.headers.get('Cache-Control')).toContain('no-store')
	})
})
