import { db, eq, Organization, WebsitePage } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './sites.pages.ts'

async function call(query: string) {
	const url = new URL(`http://localhost:3001/resources/sites/pages?${query}`)
	try {
		const response = (await loader({
			request: new Request(url),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/sites/pages',
		} as never)) as Response
		return { status: response.status, body: (await response.json()) as any }
	} catch (error) {
		if (error instanceof Response) return { status: error.status, body: null }
		throw error
	}
}

async function setup(published = true) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	const slug = organization.slug.toLowerCase()
	await db
		.update(Organization)
		.set({ sitePublished: published, slug, siteDefaultLocale: 'en' })
		.where(eq(Organization.id, organization.id))
	return { id: organization.id, slug }
}

async function page(
	organizationId: string,
	values: Partial<typeof WebsitePage.$inferInsert> & { slug: string },
) {
	await db.insert(WebsitePage).values({
		organizationId,
		title: values.slug,
		status: 'published',
		...values,
	})
}

describe('GET /resources/sites/pages', () => {
	it('lists published, indexable pages in the default language', async () => {
		const org = await setup()
		await page(org.id, { slug: 'home', isHomePage: true, position: 0 })
		await page(org.id, {
			slug: 'about',
			title: JSON.stringify({ en: 'About us', ar: 'من نحن' }),
			seoDescription: JSON.stringify({ en: 'Our story', ar: 'قصتنا' }),
			position: 1,
		})
		await page(org.id, { slug: 'draft', status: 'draft' })
		await page(org.id, { slug: 'hidden', seoNoIndex: true })

		const { status, body } = await call(`slug=${org.slug}`)
		expect(status).toBe(200)
		expect(body.pages.map((p: any) => p.slug)).toEqual(['home', 'about'])
		expect(body.pages[1]).toMatchObject({
			title: 'About us',
			description: 'Our story',
			isHomePage: false,
		})
		expect(typeof body.pages[1].updatedAt).toBe('string')
	})

	it('answers 404 until the site is published', async () => {
		const org = await setup(false)
		await page(org.id, { slug: 'about' })
		expect((await call(`slug=${org.slug}`)).status).toBe(404)
		expect((await call('')).status).toBe(404)
	})
})
