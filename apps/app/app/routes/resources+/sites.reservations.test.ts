import { ConfigFlag, db, eq, inArray, Organization } from '@repo/database'
import {
	RESERVATIONS_FLAG_KEYS,
	type ReservationsFeature,
} from '@repo/reservations'
import { RouterContextProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './sites.reservations.ts'

const flagIds: string[] = []

async function setFlag(
	feature: ReservationsFeature,
	organizationId: string,
	value = true,
) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS[feature],
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
	const url = new URL(
		`http://localhost:3001/resources/sites/reservations?${query}`,
	)
	try {
		const response = (await loader({
			request: new Request(url),
			params: {},
			context: new RouterContextProvider(),
			url,
			pattern: '/resources/sites/reservations',
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

async function setup(
	options: {
		published?: boolean
		flags?: ReservationsFeature[]
	} = {},
) {
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
	for (const feature of options.flags ?? ['enabled', 'online']) {
		await setFlag(feature, organization.id)
	}
	return organization
}

describe('GET /resources/sites/reservations', () => {
	it('needs an organization', async () => {
		expect((await call('')).status).toBe(404)
		expect((await call('slug=nope-' + Date.now())).status).toBe(404)
	})

	it('returns only flags, uncached, when master and online are on', async () => {
		const org = await setup()
		const result = await call(`slug=${org.slug}`)
		expect(result.status).toBe(200)
		expect(result.response.headers.get('Cache-Control')).toBe('no-store')
		expect(result.body).toEqual({
			online: true,
			waitlist: false,
			experiences: false,
			notifyMe: false,
		})
	})

	it('reflects the waitlist and experiences flags', async () => {
		const org = await setup({
			flags: ['enabled', 'online', 'waitlist', 'experiences'],
		})
		const result = await call(`slug=${org.slug}`)
		expect(result.body).toEqual({
			online: true,
			waitlist: true,
			experiences: true,
			notifyMe: true,
		})
	})

	it('answers 404 when the master flag is off, whatever the children say', async () => {
		const org = await setup({ flags: ['online', 'waitlist'] })
		expect((await call(`slug=${org.slug}`)).status).toBe(404)
	})

	it('answers 404 when online is off', async () => {
		const org = await setup({ flags: ['enabled', 'waitlist'] })
		expect((await call(`slug=${org.slug}`)).status).toBe(404)
	})

	it('answers 404 when the flag is explicitly false', async () => {
		const org = await setup({ flags: ['enabled'] })
		await setFlag('online', org.id, false)
		expect((await call(`slug=${org.slug}`)).status).toBe(404)
	})

	it('answers 404 until the website is published', async () => {
		const org = await setup({ published: false })
		expect((await call(`slug=${org.slug}`)).status).toBe(404)
	})

	it('finds an organization by its connected domain', async () => {
		const org = await setup()
		const host = `reserve-${Date.now()}.example.test`
		await db
			.update(Organization)
			.set({ customDomain: host, customDomainStatus: 'active' })
			.where(eq(Organization.id, org.id))
		expect((await call(`host=${host}:3008`)).status).toBe(200)
		expect((await call(`host=other-${host}`)).status).toBe(404)
	})
})
