import { getSelectedRestaurantLocationId } from '@repo/common/restaurant-location-cookie'

import {
	getDefaultOrganizationLocationId,
	getOrganizationLocation,
} from '#app/utils/organization/locations.server.ts'

/**
 * Resolves which branch menu rows apply to for operator menu editing.
 *
 * | Cookie context | Menu scope |
 * |----------------|------------|
 * | Brand (no branch) | Edits **brand shared catalog** (`location_id` null / default template — tenant epic). UI shows all locations; saves apply to shared defaults until per-branch overrides ship. |
 * | Single branch | Edits **that branch's** catalog (`location_id` = selected id). |
 *
 * Read path: brand context loads **default location** menu as preview until brand-wide menu API exists.
 */
export async function resolveMenuLocationId(
	request: Request,
	organizationId: string,
): Promise<{
	menuLocationId: string | null
	operatorContext: 'brand' | 'branch'
	selectedBranchId: string | null
}> {
	const selectedBranchId = await getSelectedRestaurantLocationId(
		request,
		organizationId,
	)

	if (selectedBranchId) {
		const branch = await getOrganizationLocation(
			organizationId,
			selectedBranchId,
		)
		if (branch?.active) {
			return {
				menuLocationId: selectedBranchId,
				operatorContext: 'branch',
				selectedBranchId,
			}
		}
	}

	const defaultId = await getDefaultOrganizationLocationId(organizationId)
	return {
		menuLocationId: defaultId,
		operatorContext: 'brand',
		selectedBranchId: null,
	}
}
