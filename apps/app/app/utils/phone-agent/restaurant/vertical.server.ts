import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { type PhoneAgentVertical } from '@repo/phone-agent'
import {
	describeRestaurantLocation,
	listMenuCategories,
	restaurantConfigParts,
	restaurantDataOf,
	restaurantVertical,
} from '@repo/phone-agent-restaurant'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { type PhoneAgentServerVertical } from '../vertical.server.ts'

const DEFAULT_CURRENCY = 'USD'

const locationColumns = {
	id: OrganizationLocation.id,
	name: OrganizationLocation.name,
	phone: OrganizationLocation.phone,
	isActive: OrganizationLocation.isActive,
	isDefault: OrganizationLocation.isDefault,
}

/** Scopes are the organization's locations; menus and hours come from Sites. */
export const restaurantServerVertical: PhoneAgentServerVertical = {
	vertical: restaurantVertical as unknown as PhoneAgentVertical,
	providesBusinessProfile: true,

	async listScopes(organizationId) {
		const rows = await db
			.select(locationColumns)
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(
				desc(OrganizationLocation.isDefault),
				asc(OrganizationLocation.name),
			)
		return rows.map((row) => ({
			...row,
			isActive: row.isActive === true,
			isDefault: row.isDefault === true,
		}))
	},

	async findScope(organizationId, scopeId) {
		const [row] = await db
			.select(locationColumns)
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, scopeId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.limit(1)
		return row
			? {
					...row,
					isActive: row.isActive === true,
					isDefault: row.isDefault === true,
				}
			: null
	},

	async configParts({ organization, scopeId, now, strictScope }) {
		const { payload } = await buildPublicSiteMenuPayload(
			{
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				siteDefaultLocale: organization.siteDefaultLocale,
				siteLocales: organization.siteLocales,
				customDomain: null,
				currency: DEFAULT_CURRENCY,
			},
			scopeId,
		)
		const exact = scopeId
			? payload.locations.find((candidate) => candidate.id === scopeId)
			: undefined
		// A phone number belongs to one location; answering for another one
		// would quote the wrong hours and menu.
		if (!exact && strictScope) return { ok: false, reason: 'scope_unavailable' }
		const location =
			exact ??
			payload.locations.find((candidate) => candidate.isDefault) ??
			payload.locations[0]
		if (!location) return { ok: false, reason: 'scope_not_found' }
		return {
			ok: true,
			currency: location.currency ?? DEFAULT_CURRENCY,
			parts: restaurantConfigParts({
				businessName: organization.name,
				location,
				menus: payload.menus,
				now,
			}),
		}
	},

	faqFacts(config, now) {
		const { location, menus } = restaurantDataOf(config)
		const categories = listMenuCategories(menus)
			.slice(0, 40)
			.map((category) => `- ${category.name} (${category.itemCount} items)`)
			.join('\n')
		return {
			businessKind: 'a restaurant',
			sections: [
				{
					heading: 'Store facts',
					body: describeRestaurantLocation(location, now),
				},
				...(categories
					? [{ heading: 'Menu categories', body: categories }]
					: []),
			],
		}
	},

	advancedPageData(config) {
		if (!config) return { categories: [] }
		const { menus } = restaurantDataOf(config)
		return {
			categories: listMenuCategories(menus).map(({ id, name }) => ({
				id,
				name,
			})),
		}
	},
}
