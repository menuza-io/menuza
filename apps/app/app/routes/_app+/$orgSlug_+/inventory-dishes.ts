import { data, type LoaderFunctionArgs } from 'react-router'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { loadWasteDishes } from '#app/utils/inventory/waste-dishes.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/**
 * The menu's dishes for the Log waste picker (#517):
 * `GET /:orgSlug/inventory-dishes`. Names, sizes and option groups only, and
 * only while recipes are on (a dish is wasted by its recipe); the region
 * knows dishes by id and the App joins the names.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireInventoryAccess(request, params.orgSlug)
	if (!access.features.recipes) return data({ dishes: [] })
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const dishes = await loadWasteDishes({
		id: access.organizationId,
		siteLocales: (organization as { siteLocales: string | null }).siteLocales,
		siteDefaultLocale: (organization as { siteDefaultLocale: string | null })
			.siteDefaultLocale,
	})
	return data({ dishes }, { headers: { 'Cache-Control': 'private, no-store' } })
}
