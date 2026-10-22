/**
 * Availability rules, matching the regional pricing engine
 * (`priceRestaurantOrder`): only `available` can be sold. `hidden` is not shown
 * at all; every other status (`unavailable`, `unavailable_until`, …) is shown as
 * sold out. A missing status counts as available.
 */
export const isAvailable = (status: string | null | undefined): boolean =>
	status == null || status === 'available'

export const isHiddenStatus = (status: string | null | undefined): boolean =>
	status === 'hidden'
