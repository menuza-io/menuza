import { parseCateringSettings } from '@repo/common/catering'
import { pickLocalized } from '@repo/common/site-locales'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'

export type CateringLocation = {
	id: string
	name: string
	timezone: string
	currency: string
	cateringOn: boolean
}

export type CateringDish = { id: string; name: string; priceCents: number }

/**
 * What the Catering tab needs from the control plane: the member's locations
 * (with the zone the event times are read in) and the dishes of the catering
 * menus, by id. Business data only; the guest-side data stays in the region.
 */
export async function loadCateringTabData(input: {
	organization: {
		id: string
		name: string
		slug: string
		dataRegion: string | null
		siteDefaultLocale: string | null
		siteLocales: string | null
		customDomain: string | null
		siteIconKey: string | null
	}
	userId: string
}): Promise<{ locations: CateringLocation[]; dishes: CateringDish[] }> {
	const { organization } = input
	const scope = await resolveMemberLocationIds(input.userId, organization.id)
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
			catering: OrganizationLocation.catering,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.isActive, true),
			),
		)
	const dataRegion = (organization.dataRegion || 'us').toLowerCase()
	const defaultCurrency = dataRegion === 'ksa' ? 'SAR' : 'USD'
	const locations: CateringLocation[] = rows
		.filter((row) => scope === null || scope.includes(row.id))
		.map((row) => {
			const cateringOn = parseCateringSettings(row.catering)?.enabled === true
			return {
				id: row.id,
				name: row.name,
				timezone: row.timezone,
				// The organization's region decides the currency, as the order context does.
				currency: defaultCurrency,
				cateringOn,
			}
		})
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			currency: defaultCurrency,
			siteDefaultLocale: organization.siteDefaultLocale,
			siteLocales: organization.siteLocales,
			customDomain: organization.customDomain,
			siteIconKey: organization.siteIconKey,
		},
		null,
	)
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const dishes: CateringDish[] = []
	const seen = new Set<string>()
	const visit = (categories: unknown[]) => {
		for (const raw of categories) {
			const category = raw as {
				items?: Array<{ id: string; displayName?: unknown; price?: unknown }>
				subcategories?: unknown[]
			}
			for (const item of category.items ?? []) {
				if (seen.has(item.id)) continue
				seen.add(item.id)
				dishes.push({
					id: item.id,
					name:
						pickLocalized(
							typeof item.displayName === 'string' ? item.displayName : null,
							defaultLocale,
							defaultLocale,
						) || item.id,
					priceCents: Math.round(Number(item.price ?? 0) * 100),
				})
			}
			if (Array.isArray(category.subcategories)) visit(category.subcategories)
		}
	}
	for (const menu of payload.menus) {
		if ((menu as { menuType?: string }).menuType !== 'catering') continue
		visit(((menu as { categories?: unknown[] }).categories ?? []) as unknown[])
	}
	return { locations, dishes }
}
