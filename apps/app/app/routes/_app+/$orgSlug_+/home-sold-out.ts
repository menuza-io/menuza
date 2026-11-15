/**
 * The sold-out dishes at one location, for the home page's "Mark available"
 * dialog (Needs attention, `dishes_unavailable`). Loader only: menu names,
 * ids and whether inventory holds a dish off. Marking dishes available is
 * the home action's `restore-dishes` intent.
 */
import { requireUserId } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import {
	loadAttentionLocations,
	loadAttentionOrganization,
	loadPermissionChecker,
} from '#app/utils/dashboards/attention.server.ts'
import { listSoldOutDishes } from '#app/utils/dashboards/sold-out.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true },
	)
	const has = await loadPermissionChecker(userId, organization.id)
	if (!has(ORG_PERMISSIONS.READ_MENU_ANY)) {
		throw data({ error: 'forbidden' }, { status: 403 })
	}
	const locationId =
		new URL(request.url).searchParams.get('locationId')?.trim() || null
	const { locations, hasLocations } = await loadAttentionLocations(
		userId,
		organization.id,
	)
	if (
		hasLocations
			? !locations.some((location) => location.id === locationId)
			: locationId !== null
	) {
		throw data({ error: 'location_not_found' }, { status: 404 })
	}
	const attentionOrganization = await loadAttentionOrganization(organization.id)
	if (!attentionOrganization) {
		throw data({ error: 'not_found' }, { status: 404 })
	}
	const result = await listSoldOutDishes({
		organization: attentionOrganization,
		locationId,
	})
	return data(
		{ ...result, canRestore: has(ORG_PERMISSIONS.UPDATE_MENU_ANY) },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
