import {
	and,
	db,
	eq,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'

/**
 * Location scoping for discount operators (`null` = every location; `[]` = none).
 * Mirrors reservations and loyalty.
 */
export async function resolveDiscountLocationIds(
	userId: string,
	organizationId: string,
): Promise<string[] | null> {
	const [membership] = await db
		.select({
			locationScope: UserOrganization.locationScope,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!membership?.active) return []
	if (membership.locationScope === 'all') return null
	if (membership.locationScope !== 'selected') return []

	const rows = await db
		.select({ locationId: UserOrganizationLocation.locationId })
		.from(UserOrganizationLocation)
		.innerJoin(
			OrganizationLocation,
			and(
				eq(OrganizationLocation.id, UserOrganizationLocation.locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(UserOrganizationLocation.userId, userId),
				eq(UserOrganizationLocation.organizationId, organizationId),
			),
		)
	return [...new Set(rows.map((row) => row.locationId))].sort()
}

/** Whether a member may view or edit a discount from its location list. */
export function discountVisibleInScope(
	discountLocationIds: readonly string[] | null,
	operatorLocationIds: readonly string[] | null,
): boolean {
	if (operatorLocationIds === null) return true
	if (operatorLocationIds.length === 0) return false
	if (discountLocationIds === null || discountLocationIds.length === 0) {
		return true
	}
	return discountLocationIds.some((id) => operatorLocationIds.includes(id))
}

/** Refuse a save when scoped operators pick locations outside their grant. */
export function discountLocationsAllowedInScope(
	chosenLocationIds: readonly string[] | null,
	allLocations: boolean,
	operatorLocationIds: readonly string[] | null,
): boolean {
	if (operatorLocationIds === null) return true
	if (operatorLocationIds.length === 0) return false
	if (allLocations || chosenLocationIds === null) return false
	if (chosenLocationIds.length === 0) return false
	return chosenLocationIds.every((id) => operatorLocationIds.includes(id))
}
