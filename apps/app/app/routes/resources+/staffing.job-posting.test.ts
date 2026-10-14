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
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './staffing.job-posting.ts'

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

async function call(query: string, authorized = true) {
	const url = new URL(
		`http://localhost:3001/resources/staffing/job-posting?${query}`,
	)
	const response = (await loader({
		request: new Request(url, {
			headers: authorized
				? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
				: {},
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/staffing/job-posting',
	} as never)) as Response
	const text = await response.text()
	let body: any = null
	try {
		body = JSON.parse(text)
	} catch {
		body = null
	}
	return { status: response.status, body, response }
}

async function setup(options: { published?: boolean; hiring?: boolean } = {}) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({
			sitePublished: options.published ?? true,
			hasProvisionedDb: true,
		})
		.where(eq(Organization.id, organization.id))
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
			...overrides,
		})
		.returning()
	return row!
}

describe('GET /resources/staffing/job-posting', () => {
	it('is for the platform only: no token, no answer', async () => {
		const org = await setup()
		await posting(org.id, 'cook')
		const result = await call(`orgId=${org.id}&slug=cook`, false)
		expect(result.status).toBe(403)
		expect(result.body).toBeNull()
	})

	it('returns what intake needs, including the dealbreaker, for a live posting', async () => {
		const org = await setup()
		const row = await posting(org.id, 'cook')
		const result = await call(`orgId=${org.id}&slug=cook`)
		expect(result.status).toBe(200)
		expect(result.response.headers.get('Cache-Control')).toBe(
			'private, no-store',
		)
		expect(result.body).toEqual({
			orgId: org.id,
			posting: {
				id: row.id,
				slug: 'cook',
				title: 'Job cook',
				positionName: 'Cook',
				scopeIds: ['main'],
				questions: [
					expect.objectContaining({
						id: 'weekends',
						dealbreaker: true,
						requiredAnswer: 'yes',
					}),
				],
			},
		})
	})

	it('answers 404 for anything that is not an open posting', async () => {
		const org = await setup()
		await posting(org.id, 'draft', { status: 'draft' })
		await posting(org.id, 'closed', { status: 'closed' })
		await posting(org.id, 'ended', { expiresAt: new Date(Date.now() - 1000) })
		for (const slug of ['draft', 'closed', 'ended', 'missing']) {
			expect((await call(`orgId=${org.id}&slug=${slug}`)).status).toBe(404)
		}
	})

	it('answers 404 while hiring is off or the site is not published', async () => {
		const off = await setup({ hiring: false })
		await posting(off.id, 'cook')
		expect((await call(`orgId=${off.id}&slug=cook`)).status).toBe(404)
		const unpublished = await setup({ published: false })
		await posting(unpublished.id, 'cook')
		expect((await call(`orgId=${unpublished.id}&slug=cook`)).status).toBe(404)
	})

	it("never returns another organization's posting", async () => {
		const a = await setup()
		const b = await setup()
		await posting(b.id, 'secret')
		expect((await call(`orgId=${a.id}&slug=secret`)).status).toBe(404)
	})

	it('rejects malformed parameters', async () => {
		for (const query of [
			'',
			'orgId=../x&slug=cook',
			'orgId=clw9x0a12000008l00cafeorg1&slug=Bad Slug',
			'orgId=clw9x0a12000008l00cafeorg1',
		]) {
			expect((await call(query)).status).toBe(400)
		}
	})
})
