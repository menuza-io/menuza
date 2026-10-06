import { db, eq, Organization } from '@repo/database'
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
			customDomain: null,
			dataRegion: 'ksa',
			hasProvisionedDb: true,
		})
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')
	})

	it('requires internal authentication before returning metadata', async () => {
		await expect(
			loader(args('clw9x0a12000008l00mailbox1', false)),
		).rejects.toMatchObject({ status: 302 })
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
