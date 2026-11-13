import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './terminals_.ready-text.ts'

// The site cache is the external boundary; permissions and the database are real.
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

async function setup(dataRegion: 'us' | 'ksa' = 'us') {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ dataRegion })
		.where(eq(Organization.id, organization.id))
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'America/New_York',
		})
		.returning()
	return { organization, location: location!, cookie }
}

function post(orgSlug: string, cookie: string, values: Record<string, string>) {
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/settings/terminals/ready-text`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	return action({ request, params: { orgSlug }, context: {} } as never)
}

async function published(organization: {
	id: string
	name: string
	slug: string
}) {
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			currency: 'USD',
			siteDefaultLocale: 'en',
			siteLocales: null,
			customDomain: null,
		} as never,
		null,
	)
	return payload.locations
}

describe('ready texts switch (Settings, Terminals)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('is off by default, turns on for one location and is published as policy only', async () => {
		const { organization, location, cookie } = await setup()
		expect((await published(organization))[0]?.readyText).toBe(false)
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			enabled: 'true',
		})
		expect(getResponseStatus(result)).toBe(200)
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()
		const [entry] = await published(organization)
		expect(entry?.readyText).toBe(true)
		await post(organization.slug, cookie, {
			locationId: location.id,
			enabled: 'false',
		})
		expect((await published(organization))[0]?.readyText).toBe(false)
	})

	it('cannot be turned on without an SMS route (KSA), and is never published there', async () => {
		const { organization, location, cookie } = await setup('ksa')
		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			enabled: 'true',
		})
		expect(getResponseStatus(result)).toBe(409)
		// Even a switch left on from before is not offered in a KSA organization.
		await db
			.update(OrganizationLocation)
			.set({ readyTextEnabled: true })
			.where(eq(OrganizationLocation.id, location.id))
		expect((await published(organization))[0]?.readyText).toBe(false)
	})

	it('refuses a location of another organization', async () => {
		const { organization, cookie } = await setup()
		const { location: theirs } = await setup()
		const result = await post(organization.slug, cookie, {
			locationId: theirs.id,
			enabled: 'true',
		})
		expect(getResponseStatus(result)).toBe(404)
		const [row] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, theirs.id))
		expect(row?.readyTextEnabled).toBe(false)
	})
})
