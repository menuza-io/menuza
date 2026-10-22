import { type OrderType } from './db.ts'
import { type MenuLocation } from './types.ts'

/**
 * Whether tips are offered for this kind of order, following the restaurant's own
 * setting for the location (dine-in vs pickup). A missing setting means allowed,
 * so an older payload never silently removes tipping.
 */
export function tipsAllowed(
	location: Pick<MenuLocation, 'inHouseTips'> | null,
	orderType: OrderType,
): boolean {
	const setting =
		orderType === 'dine_in'
			? location?.inHouseTips?.dineInTips
			: location?.inHouseTips?.pickupTips
	return setting !== false
}
