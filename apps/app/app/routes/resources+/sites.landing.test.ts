/**
 * Generated pages (#137) and cuisine and price range (#182) as the public
 * site sees them: `/resources/sites/landing` and the organization payload,
 * fed by Settings, the location's Website card, the dish switch and Website,
 * Area pages.
 */
import {
	db,
	eq,
	OrganizationLocation,
	OrganizationMenuItem,
	WebsiteRedirect,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { action as dishPageAction } from '#app/routes/_app+/$orgSlug_+/menu+/items_.$itemId.site-page.ts'
import { action as settingsAction } from '#app/routes/_app+/$orgSlug_+/settings+/_index.tsx'
import { action as locationWebsiteAction } from '#app/routes/_app+/$orgSlug_+/settings+/locations_.$locationId.website.ts'
import { action as areaAction } from '#app/routes/_app+/$orgSlug_+/website+/area-pages.tsx'
import { addLocationPageRedirect } from '#app/utils/seo/landing-pages.server.ts'
import {
	callAction,
	callLoader,
	publicSitePayload,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import { loader } from './sites.landing.ts'

async function landing(slug: string) {
	const response = (await callLoader(loader, {
		url: `http://localhost/resources/sites/landing?slug=${slug}`,
	})) as Response
	expect(response.status).toBe(200)
	return (await response.json()) as Record<string, any>
}

async function addLocation(
	organizationId: string,
	slug: string,
	extra: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: slug,
			slug,
			timezone: 'Asia/Riyadh',
			address: JSON.stringify({ city: 'Riyadh', lat: 24.7, lng: 46.68 }),
			storeHours: JSON.stringify([
				{
					day: 'monday',
					isOpen: true,
					slots: [{ start: '09:00', end: '22:00' }],
				},
			]),
			deliveryZones: JSON.stringify([
				{
					id: 'z1',
					name: 'Al Malqa',
					enabled: true,
					restriction: 'allowed',
					provider: 'in_house',
					minimumOrder: 30,
					deliveryFee: 9,
				},
			]),
			...extra,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

describe('cuisine and price range (#182)', () => {
	it('Settings saves up to three known cuisines and a price range for the public site', async () => {
		const { organization, cookie } = await setupSeoOrganization('admin', {
			dataRegion: 'ksa',
		})
		const url = `http://localhost:3000/${organization.slug}/settings`
		const response = await callAction(settingsAction, {
			url,
			cookie,
			params: { orgSlug: organization.slug },
			fields: {
				intent: 'update-cuisine',
				cuisines: ['lebanese', 'shawarma'],
				priceRange: '2',
			},
		})
		expect(response.status).toBe(200)
		const payload = await publicSitePayload(organization.slug)
		expect(payload.cuisines).toEqual(['lebanese', 'shawarma'])
		expect(payload.priceRange).toBe('﷼﷼')

		const refusals: Array<Record<string, string | string[]>> = [
			{ intent: 'update-cuisine', cuisines: ['other'] },
			{
				intent: 'update-cuisine',
				cuisines: ['pizza', 'sushi', 'coffee', 'thai'],
			},
			{ intent: 'update-cuisine', priceRange: '5' },
		]
		for (const fields of refusals) {
			const refused = await callAction(settingsAction, {
				url,
				cookie,
				params: { orgSlug: organization.slug },
				fields,
			})
			expect(refused.status).toBe(400)
		}
	})

	it("a location's override wins on its page; members without settings access are refused", async () => {
		const { organization, cookie } = await setupSeoOrganization()
		const locationId = await addLocation(organization.id, 'olaya')
		const url = `http://localhost:3000/${organization.slug}/settings/locations/${locationId}/website`
		const response = await callAction(locationWebsiteAction, {
			url,
			cookie,
			params: { orgSlug: organization.slug, locationId },
			fields: {
				intent: 'update-location-cuisine',
				cuisines: ['sushi'],
				priceRange: '4',
			},
		})
		expect(response.status).toBe(200)
		const data = await landing(organization.slug)
		expect(data.locations[0]).toMatchObject({
			cuisines: ['sushi'],
			priceRange: 4,
		})

		const viewer = await setupSeoOrganization('viewer')
		const viewerLocation = await addLocation(viewer.organization.id, 'malqa')
		const refused = await callAction(locationWebsiteAction, {
			url,
			cookie: viewer.cookie,
			params: { orgSlug: viewer.organization.slug, locationId: viewerLocation },
			fields: { intent: 'update-location-cuisine', cuisines: ['sushi'] },
		})
		expect(refused.status).toBe(403)
		// Another organization's location id changes nothing.
		const forged = await callAction(locationWebsiteAction, {
			url,
			cookie,
			params: { orgSlug: organization.slug, locationId: viewerLocation },
			fields: { intent: 'update-location-page', pageEnabled: 'false' },
		})
		expect(forged.status).toBe(404)
	})
})

describe('location pages (#137)', () => {
	it('lists active locations with hours, address and copy; a deactivated one is gone', async () => {
		const { organization, cookie } = await setupSeoOrganization('admin', {
			cuisines: JSON.stringify(['lebanese']),
			priceRange: 2,
		})
		const olaya = await addLocation(organization.id, 'olaya')
		await addLocation(organization.id, 'closed', { isActive: false })
		const response = await callAction(locationWebsiteAction, {
			url: `http://localhost:3000/${organization.slug}/settings/locations/${olaya}/website`,
			cookie,
			params: { orgSlug: organization.slug, locationId: olaya },
			fields: {
				intent: 'update-location-page',
				pageEnabled: 'true',
				'intro.en': 'Our first branch.',
				seoTitle: 'Al Bait Olaya',
			},
		})
		expect(response.status).toBe(200)
		const data = await landing(organization.slug)
		expect(data.features.locationPages).toBe(true)
		expect(data.locations).toHaveLength(1)
		expect(data.locations[0]).toMatchObject({
			slug: 'olaya',
			timezone: 'Asia/Riyadh',
			intro: '{"en":"Our first branch."}',
			seoTitle: 'Al Bait Olaya',
			cuisines: ['lebanese'],
			priceRange: 2,
			address: { city: 'Riyadh', lat: 24.7, lng: 46.68 },
		})
		expect(data.locations[0].storeHours[0].day).toBe('monday')
		expect(data.goneLocationSlugs).toEqual(['closed'])

		// Deactivating answers 410 from then on (Sites reads goneLocationSlugs).
		await db
			.update(OrganizationLocation)
			.set({ isActive: false })
			.where(eq(OrganizationLocation.id, olaya))
		const after = await landing(organization.slug)
		expect(after.locations).toEqual([])
		expect(after.goneLocationSlugs.sort()).toEqual(['closed', 'olaya'])
	})

	it('a new location address keeps the old page working with a 301', async () => {
		const { organization } = await setupSeoOrganization()
		await addLocationPageRedirect(organization.id, 'olaya', 'olaya-center')
		const rows = await db
			.select({
				from: WebsiteRedirect.fromPath,
				to: WebsiteRedirect.toPath,
				source: WebsiteRedirect.source,
			})
			.from(WebsiteRedirect)
			.where(eq(WebsiteRedirect.organizationId, organization.id))
		expect(rows).toEqual([
			{
				from: '/locations/olaya',
				to: '/locations/olaya-center',
				source: 'location_rename',
			},
		])
	})

	it('is a 404 until the site is published', async () => {
		const { organization } = await setupSeoOrganization('admin', {
			sitePublished: false,
		})
		const response = (await callLoader(loader, {
			url: `http://localhost/resources/sites/landing?slug=${organization.slug}`,
		})) as Response
		expect(response.status).toBe(404)
	})
})

describe('dish pages (#137)', () => {
	it('enabling a dish page gives it a slug that is never an ordering path', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		await setOrgFlag(organization.id, 'website.dish_pages', true)
		const [dish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: '{"en":"Checkout"}',
				price: 12,
			})
			.returning({ id: OrganizationMenuItem.id })
		const response = await callAction(dishPageAction, {
			url: `http://localhost:3000/${organization.slug}/menu/items/${dish!.id}/site-page`,
			cookie,
			params: { orgSlug: organization.slug, itemId: dish!.id },
			fields: { enabled: 'true' },
		})
		expect(response.status).toBe(200)
		const data = await landing(organization.slug)
		expect(data.dishes).toEqual([{ id: dish!.id, slug: 'checkout-2' }])

		await callAction(dishPageAction, {
			url: `http://localhost:3000/${organization.slug}/menu/items/${dish!.id}/site-page`,
			cookie,
			params: { orgSlug: organization.slug, itemId: dish!.id },
			fields: { enabled: 'false' },
		})
		expect((await landing(organization.slug)).dishes).toEqual([])
	})

	it('is refused while website.dish_pages is off', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		const [dish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: 'Falafel',
				price: 12,
			})
			.returning({ id: OrganizationMenuItem.id })
		const response = await callAction(dishPageAction, {
			url: `http://localhost:3000/${organization.slug}/menu/items/${dish!.id}/site-page`,
			cookie,
			params: { orgSlug: organization.slug, itemId: dish!.id },
			fields: { enabled: 'true' },
		})
		expect(response.status).toBe(404)
		expect((await landing(organization.slug)).dishes).toEqual([])
	})
})

describe('area pages (#137)', () => {
	it('are noindex until they have an introduction, and can be switched off', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		await setOrgFlag(organization.id, 'website.area_pages', true)
		const locationId = await addLocation(organization.id, 'olaya')
		let data = await landing(organization.slug)
		expect(data.areas).toEqual([
			expect.objectContaining({
				slug: 'al-malqa',
				locationSlug: 'olaya',
				noIndex: true,
				minimumOrder: 30,
				deliveryFee: 9,
			}),
		])
		const save = (fields: Record<string, string>) =>
			callAction(areaAction, {
				url: `http://localhost:3000/${organization.slug}/website/area-pages`,
				cookie,
				params: { orgSlug: organization.slug },
				fields: { intent: 'save-area', locationId, zoneId: 'z1', ...fields },
			})
		expect(
			(
				await save({
					slug: 'malqa-delivery',
					'intro.en': 'Hot food in 30 minutes.',
				})
			).status,
		).toBe(200)
		data = await landing(organization.slug)
		expect(data.areas[0]).toMatchObject({
			slug: 'malqa-delivery',
			noIndex: false,
		})
		expect((await save({ enabled: 'false' })).status).toBe(200)
		expect((await landing(organization.slug)).areas).toEqual([])
		expect((await save({ slug: '../evil' })).status).toBe(400)
	})
})
