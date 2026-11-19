import { ConfigFlag, db, eq, inArray, Organization } from '@repo/database'
import { LOYALTY_FLAG_KEYS } from '@repo/loyalty'
import { RouterContextProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './sites.loyalty.ts'

const flagIds: string[] = []

async function setLoyaltyEnabled(organizationId: string, value = true) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: LOYALTY_FLAG_KEYS.enabled,
			value,
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
	const url = new URL(`http://localhost:3001/resources/sites/loyalty?${query}`)
	try {
		const response = (await loader({
			request: new Request(url),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/sites/loyalty',
		} as never)) as Response
		return {
			status: response.status,
			body: (await response.json()) as unknown,
			response,
		}
	} catch (error) {
		if (error instanceof Response) {
			return { status: error.status, body: null, response: error }
		}
		throw error
	}
}

async function setup(options: { published?: boolean; enabled?: boolean } = {}) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({
			sitePublished: options.published ?? true,
			slug: organization.slug.toLowerCase(),
		})
		.where(eq(Organization.id, organization.id))
	organization.slug = organization.slug.toLowerCase()
	if (options.enabled ?? true) {
		await setLoyaltyEnabled(organization.id, true)
	}
	return organization
}

describe('GET /resources/sites/loyalty (#295)', () => {
	it('returns 404 when missing slug or unknown org', async () => {
		expect((await call('')).status).toBe(404)
		expect((await call(`slug=nope-${Date.now()}`)).status).toBe(404)
	})

	it('returns 404 when site is unpublished or loyalty flag is off', async () => {
		const unpub = await setup({ published: false, enabled: true })
		expect((await call(`slug=${unpub.slug}`)).status).toBe(404)

		const disabled = await setup({ published: true, enabled: false })
		expect((await call(`slug=${disabled.slug}`)).status).toBe(404)
	})

	it('returns { enabled: true } uncached when published and loyalty is on', async () => {
		const org = await setup({ published: true, enabled: true })
		const res = await call(`slug=${org.slug}`)
		expect(res.status).toBe(200)
		expect(res.response.headers.get('Cache-Control')).toBe('no-store')
		expect(res.body).toEqual({ enabled: true })
	})
})
