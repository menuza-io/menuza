import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loader } from './tenant-organization.ts'

function args(orgId: string, authorized = true) {
	const url = new URL('http://localhost:3001/resources/tenant-organization')
	url.searchParams.set('orgId', orgId)
	return {
		request: new Request(url, {
			headers: authorized
				? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
				: {},
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/tenant-organization',
	}
}

describe('internal tenant organization metadata', () => {
	it('returns only routing metadata for active unpublished organizations', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id)
		await db
			.update(Organization)
			.set({ sitePublished: false, dataRegion: 'ksa', hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))

		const response = await loader(args(organization.id))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			id: organization.id,
			slug: organization.slug,
			name: organization.name,
			customDomain: null,
			dataRegion: 'ksa',
			hasProvisionedDb: true,
			emailSender: null,
			guestPhotosEnabled: false,
			// Business data a marketing text needs (#75, #159): zones, the site, a flag.
			timeZone: 'UTC',
			locationTimeZones: {},
			siteOrigin: expect.stringContaining(organization.slug),
			features: { shortLinks: false },
		})
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	})

	it('names the time zone of the first location and of each location (#75)', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id)
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const [first, second] = await db
			.insert(OrganizationLocation)
			.values([
				{
					organizationId: organization.id,
					name: 'Downtown',
					slug: 'downtown',
					timezone: 'Asia/Riyadh',
					createdAt: new Date(1_000),
				},
				{
					organizationId: organization.id,
					name: 'Airport',
					slug: 'airport',
					timezone: 'America/Los_Angeles',
					createdAt: new Date(2_000),
				},
			])
			.returning()
		const body = (await (await loader(args(organization.id))).json()) as {
			timeZone: string
			locationTimeZones: Record<string, string>
		}
		expect(body.timeZone).toBe('Asia/Riyadh')
		expect(body.locationTimeZones).toEqual({
			[first!.id]: 'Asia/Riyadh',
			[second!.id]: 'America/Los_Angeles',
		})
	})

	it('requires internal authentication before returning metadata', async () => {
		await expect(
			loader(args('clw9x0a12000008l00mailbox1', false)),
		).rejects.toMatchObject({ status: 401 })
	})

	it('rejects malformed IDs', async () => {
		expect((await loader(args('../invalid'))).status).toBe(400)
	})

	it('does not return inactive or missing organizations', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id)
		await db
			.update(Organization)
			.set({ active: false })
			.where(eq(Organization.id, organization.id))

		expect((await loader(args(organization.id))).status).toBe(404)
		expect((await loader(args('clw9x0a12000008l00missing1'))).status).toBe(404)
	})
})
