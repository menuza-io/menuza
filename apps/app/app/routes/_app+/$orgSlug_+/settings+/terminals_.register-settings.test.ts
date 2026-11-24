import { db, eq, Organization, OrganizationLocation } from '@repo/database'
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
			cashDiscountBp: null,
			idleSignOutMinutes: null,
			tickets: {},
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
			cashDiscountBp: null,
			idleSignOutMinutes: null,
			tickets: {},
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

describe('the cash-payment discount setting (#375)', () => {
	const base = (locationId: string) => ({
		locationId,
		guestDetails: 'none',
		dishNotes: 'true',
		customItems: 'off',
		customItemMaxCents: '50000',
		cashVarianceFlagCents: '',
	})

	async function region(organizationId: string, dataRegion: 'us' | 'ksa') {
		await db
			.update(Organization)
			.set({ dataRegion })
			.where(eq(Organization.id, organizationId))
	}

	it('saves a percentage for a US organization and publishes it to the till', async () => {
		const { organization, location, cookie } = await setup('admin')
		await region(organization.id, 'us')
		const result = await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '3.5',
		})
		expect(getResponseStatus(result)).toBe(200)
		const [loc] = await published(organization)
		expect(loc?.stationSettings?.cashDiscountBp).toBe(350)
		// A blank field turns it off.
		await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '',
		})
		expect(
			(await published(organization))[0]?.stationSettings?.cashDiscountBp,
		).toBeNull()
	})

	it('refuses a percentage that is not one, or over the highest rate', async () => {
		const { organization, location, cookie } = await setup('admin')
		await region(organization.id, 'us')
		for (const bad of ['abc', '10.5', '0', '-1', '3,5']) {
			const result = await post(organization.slug, cookie, {
				...base(location.id),
				cashDiscountPercent: bad,
			})
			expect(getResponseStatus(result)).toBe(400)
		}
		const edge = await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '10',
		})
		expect(getResponseStatus(edge)).toBe(200)
		expect(
			(await published(organization))[0]?.stationSettings?.cashDiscountBp,
		).toBe(1000)
	})

	it('keeps the saved rate when a form open before the field existed posts none', async () => {
		const { organization, location, cookie } = await setup('admin')
		await region(organization.id, 'us')
		await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '3',
		})
		const result = await post(organization.slug, cookie, {
			...base(location.id),
			dishNotes: 'false',
		})
		expect(getResponseStatus(result)).toBe(200)
		const [loc] = await published(organization)
		expect(loc?.stationSettings).toMatchObject({
			dishNotes: false,
			cashDiscountBp: 300,
		})
	})

	it('drops it for a KSA organization, whatever the form says', async () => {
		const { organization, location, cookie } = await setup('admin')
		await region(organization.id, 'ksa')
		const result = await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '3',
		})
		expect(getResponseStatus(result)).toBe(200)
		const [row] = await db
			.select({ stationSettings: OrganizationLocation.stationSettings })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		const saved = JSON.parse(String(row?.stationSettings)) as {
			cashDiscountBp: number | null
		}
		expect(saved.cashDiscountBp).toBeNull()
		expect(
			(await published(organization))[0]?.stationSettings?.cashDiscountBp,
		).toBeNull()
	})

	it('never publishes a rate saved before the organization moved to KSA', async () => {
		const { organization, location, cookie } = await setup('admin')
		await region(organization.id, 'us')
		await post(organization.slug, cookie, {
			...base(location.id),
			cashDiscountPercent: '3',
		})
		expect(
			(await published(organization))[0]?.stationSettings?.cashDiscountBp,
		).toBe(300)
		await region(organization.id, 'ksa')
		expect(
			(await published(organization))[0]?.stationSettings?.cashDiscountBp,
		).toBeNull()
	})
})

describe('the idle sign-out setting (#364)', () => {
	const base = (locationId: string) => ({
		locationId,
		guestDetails: 'none',
		dishNotes: 'true',
		customItems: 'off',
		customItemMaxCents: '50000',
		cashVarianceFlagCents: '',
	})
	const saved = async (
		organization: Awaited<ReturnType<typeof setup>>['organization'],
	) => (await published(organization))[0]?.stationSettings?.idleSignOutMinutes

	it('is off by default, set in minutes per location, and cleared by a blank', async () => {
		const { organization, location, cookie } = await setup('admin')
		expect(await saved(organization)).toBeNull()

		const five = await post(organization.slug, cookie, {
			...base(location.id),
			idleSignOutMinutes: '5',
		})
		expect(getResponseStatus(five)).toBe(200)
		expect(await saved(organization)).toBe(5)

		// A form open before the field existed posts none: the saved value stays.
		const other = await post(organization.slug, cookie, base(location.id))
		expect(getResponseStatus(other)).toBe(200)
		expect(await saved(organization)).toBe(5)

		const off = await post(organization.slug, cookie, {
			...base(location.id),
			idleSignOutMinutes: '',
		})
		expect(getResponseStatus(off)).toBe(200)
		expect(await saved(organization)).toBeNull()
	})

	it('refuses what is not minutes from 1 to 60, and a member who may not write', async () => {
		const { organization, location, cookie } = await setup('admin')
		for (const bad of ['0', '61', '-3', '1.5', 'abc', '100']) {
			const response = await post(organization.slug, cookie, {
				...base(location.id),
				idleSignOutMinutes: bad,
			})
			expect(getResponseStatus(response)).toBe(400)
		}
		expect(await saved(organization)).toBeNull()

		const viewer = await setup('viewer')
		await expect(
			post(viewer.organization.slug, viewer.cookie, {
				...base(viewer.location.id),
				idleSignOutMinutes: '5',
			}),
		).rejects.toThrow()
	})
})
