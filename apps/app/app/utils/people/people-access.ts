import {
	hasGrantSatisfying,
	RESERVATIONS_PERMISSIONS as P,
	type ReservationsPermission,
} from '@repo/reservations'

/**
 * What the signed-in operator may do on the Customers screen. Computed on the
 * server from permissions and flags, signed into the browser-direct `people`
 * token, and echoed to the UI so it can hide what the token would refuse.
 *
 *  - `customers`: contact, orders summary and marketing consent (`read:settings:any`);
 *  - `dining`: the reservation facet. `full` is the guest read grant
 *    (allergy text, sensitive tags, notes); `flags` is counters and
 *    non-sensitive tags for customer readers who only hold `read:reservation`.
 */
export type PeopleAccess = {
	customers: boolean
	dining: 'none' | 'flags' | 'full'
	canUpdateCustomers: boolean
	canUpdateDining: boolean
	canDelete: boolean
}

export const NO_PEOPLE_ACCESS: PeopleAccess = {
	customers: false,
	dining: 'none',
	canUpdateCustomers: false,
	canUpdateDining: false,
	canDelete: false,
}

export function computePeopleAccess(input: {
	canReadSettings: boolean
	canUpdateSettings: boolean
	/** `reservations.enabled` and the member has a reservation location. */
	reservationsEnabled: boolean
	grants: readonly ReservationsPermission[]
	impersonated: boolean
}): PeopleAccess {
	const has = (grant: ReservationsPermission) =>
		hasGrantSatisfying(input.grants, grant)
	const customers = input.canReadSettings
	let dining: PeopleAccess['dining'] = 'none'
	if (input.reservationsEnabled) {
		if (has(P.READ_RESERVATION_GUEST)) {
			// Sensitive reads are never available while impersonating.
			dining = input.impersonated ? (customers ? 'flags' : 'none') : 'full'
		} else if (customers && has(P.READ_RESERVATION)) {
			dining = 'flags'
		}
	}
	const canUpdateCustomers =
		customers && input.canUpdateSettings && !input.impersonated
	const canUpdateDining =
		dining === 'full' && !input.impersonated && has(P.UPDATE_RESERVATION_GUEST)
	// Erasing removes the customer and every linked guest in one go, so it needs
	// both write rights where both facets exist.
	const canDelete =
		!input.impersonated &&
		canUpdateCustomers &&
		(dining === 'none' || canUpdateDining)
	return { customers, dining, canUpdateCustomers, canUpdateDining, canDelete }
}

export function hasPeopleAccess(access: PeopleAccess): boolean {
	return access.customers || access.dining !== 'none'
}
