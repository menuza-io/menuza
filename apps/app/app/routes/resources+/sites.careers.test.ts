import {
	ConfigFlag,
	db,
	eq,
	inArray,
	JobPosting,
	Organization,
} from '@repo/database'
import { STAFFING_FLAG_KEYS, type StaffingFeature } from '@repo/staffing'
import { RouterContextProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './sites.careers.ts'

const flagIds: string[] = []

async function setFlag(feature: StaffingFeature, organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

async function call(query: string) {
	const url = new URL(`http://localhost:3001/resources/sites/careers?${query}`)
	try {
		const response = (await loader({
			request: new Request(url),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/sites/careers',
		} as never)) as Response
		return {
			status: response.status,
			body: (await response.json()) as any,
			response,
		}
	} catch (error) {
		if (error instanceof Response)
			return { status: error.status, body: null, response: error }
		throw error
	}
}

async function setup(options: { published?: boolean; hiring?: boolean } = {}) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({
			sitePublished: options.published ?? true,
			// Public slugs are lowercase; the route lowercases what it is asked for.
			slug: organization.slug.toLowerCase(),
		})
		.where(eq(Organization.id, organization.id))
	organization.slug = organization.slug.toLowerCase()
	if (options.hiring !== false) {
		await setFlag('enabled', organization.id)
		await setFlag('hiring', organization.id)
	}
	return organization
}

async function posting(
	organizationId: string,
	slug: string,
	overrides: Partial<typeof JobPosting.$inferInsert> = {},
) {
	const [row] = await db
		.insert(JobPosting)
		.values({
			organizationId,
			slug,
			title: `Job ${slug}`,
			positionName: 'Cook',
			status: 'published',
			publishedAt: new Date(),
			descriptionHtml: '<p>Cook on the line during busy dinner service.</p>',
			...overrides,
		})
		.returning()
	return row!
}

describe('GET /resources/sites/careers', () => {
	it('needs an organization', async () => {
		expect((await call('')).status).toBe(404)
		expect((await call('slug=nope-' + Date.now())).status).toBe(404)
	})

	it('lists live postings without descriptions or questions', async () => {
		const org = await setup()
		await posting(org.id, 'live')
		await posting(org.id, 'draft', { status: 'draft' })
		await posting(org.id, 'closed', { status: 'closed' })
		await posting(org.id, 'ended', { expiresAt: new Date(Date.now() - 1000) })
		const result = await call(`slug=${org.slug}`)
		expect(result.status).toBe(200)
		expect(result.response.headers.get('Cache-Control')).toBe('no-store')
		expect(result.body.organization.name).toBe(org.name)
		expect(result.body.postings.map((p: any) => p.slug)).toEqual(['live'])
		expect(result.body.postings[0]).not.toHaveProperty('descriptionHtml')
		expect(result.body.postings[0]).not.toHaveProperty('questions')
	})

	it('returns one posting with its questions but never the dealbreaker', async () => {
		const org = await setup()
		await posting(org.id, 'cook', {
			questions: [
				{
					id: 'weekends',
					kind: 'yes_no',
					prompt: 'Can you work weekends?',
					category: 'availability',
					dealbreaker: true,
					requiredAnswer: 'yes',
				},
			],
		})
		const result = await call(`slug=${org.slug}&posting=cook`)
		expect(result.status).toBe(200)
		expect(result.body.posting.questions).toHaveLength(1)
		expect(JSON.stringify(result.body)).not.toMatch(
			/dealbreaker|requiredAnswer|createdByUserId|organizationId/,
		)
	})

	it('answers 404 for drafts, other organizations’ slugs and malformed slugs', async () => {
		const org = await setup()
		const other = await setup()
		await posting(org.id, 'draft', { status: 'draft' })
		await posting(other.id, 'theirs')
		expect((await call(`slug=${org.slug}&posting=draft`)).status).toBe(404)
		expect((await call(`slug=${org.slug}&posting=theirs`)).status).toBe(404)
		for (const bad of ['..%2Fx', 'A%20B', 'a'.repeat(200), "x'--"]) {
			expect((await call(`slug=${org.slug}&posting=${bad}`)).status).toBe(404)
		}
	})

	it('answers 404 until the website is published and the hiring flag is on', async () => {
		const unpublished = await setup({ published: false })
		await posting(unpublished.id, 'live')
		expect((await call(`slug=${unpublished.slug}`)).status).toBe(404)

		const noFlag = await setup({ hiring: false })
		await posting(noFlag.id, 'live')
		expect((await call(`slug=${noFlag.slug}`)).status).toBe(404)
		expect((await call(`slug=${noFlag.slug}&posting=live`)).status).toBe(404)

		const masterOnly = await setup({ hiring: false })
		await setFlag('enabled', masterOnly.id)
		await posting(masterOnly.id, 'live')
		expect((await call(`slug=${masterOnly.slug}`)).status).toBe(404)
	})

	it('finds an organization by its connected domain', async () => {
		const org = await setup()
		const host = `careers-${Date.now()}.example.test`
		await db
			.update(Organization)
			.set({ customDomain: host, customDomainStatus: 'active' })
			.where(eq(Organization.id, org.id))
		await posting(org.id, 'live')
		const result = await call(`host=${host}`)
		expect(result.status).toBe(200)
		expect(result.body.postings).toHaveLength(1)
		expect((await call(`host=other-${host}`)).status).toBe(404)
	})
})
