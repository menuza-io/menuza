import { db, eq, OrganizationLocation } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './terminals_.register-settings.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const { organization, cookie } = await setupTestOrgWithUser(role)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Downtown',
			slug: `dt-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'Asia/Riyadh',
		})
		.returning()
	return { organization, location: location!, cookie }
}

function post(orgSlug: string, cookie: string, values: Record<string, string>) {
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/settings/terminals/register-settings`,
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
			currency: 'SAR',
			siteDefaultLocale: 'en',
			siteLocales: null,
			customDomain: null,
		} as never,
		null,
	)
	return payload.locations
}

describe('Station register settings route (#372, #171, #380)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('saves per-location register settings and publishes them with the menu', async () => {
		const { organization, location, cookie } = await setup('admin')
		expect((await published(organization))[0]?.stationSettings).toEqual({
			guestDetails: 'none',
			dishNotes: true,
			customItems: 'off',
			customItemMaxCents: 50_000,
			cashVarianceFlagCents: null,
		})

		const result = await post(organization.slug, cookie, {
			locationId: location.id,
			guestDetails: 'phone',
			dishNotes: 'false',
			customItems: 'managers',
			customItemMaxCents: '75000',
			cashVarianceFlagCents: '500',
		})
		expect(getResponseStatus(result)).toBe(200)
		expect(purgeOrganizationSiteCache).toHaveBeenCalled()

		const [loc] = await published(organization)
		expect(loc?.stationSettings).toEqual({
			guestDetails: 'phone',
			dishNotes: false,
			customItems: 'managers',
			customItemMaxCents: 75_000,
			cashVarianceFlagCents: 500,
		})
		const [row] = await db
			.select({ stationSettings: OrganizationLocation.stationSettings })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(row?.stationSettings).toContain('"guestDetails":"phone"')
	})

	it('rejects members without menu write permission and rejects invalid values', async () => {
		const { organization, location, cookie } = await setup('viewer')
		await expect(
			post(organization.slug, cookie, {
				locationId: location.id,
				guestDetails: 'phone',
				dishNotes: 'true',
				customItems: 'everyone',
				customItemMaxCents: '1000',
				cashVarianceFlagCents: '',
			}),
		).rejects.toThrow()

		const admin = await setup('admin')
		const bad = await post(admin.organization.slug, admin.cookie, {
			locationId: admin.location.id,
			guestDetails: 'phone',
			dishNotes: 'true',
			customItems: 'everyone',
			customItemMaxCents: '0',
			cashVarianceFlagCents: '',
		})
		expect(getResponseStatus(bad)).toBe(400)
	})
})
