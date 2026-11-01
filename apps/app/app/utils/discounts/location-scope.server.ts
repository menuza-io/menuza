import {
	and,
	db,
	eq,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import { z } from 'zod'

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

/**
 * A discount's stored location list: ids, `null` for every location, or
 * `undefined` when the stored value no longer parses. An unreadable list fails
 * closed: only members with every location see or change the discount.
 */
export type StoredDiscountLocations = readonly string[] | null | undefined

const storedLocationsSchema = z.array(z.string().min(1)).nullable()

/** Reads the `Discount.locationIds` column; `undefined` when it no longer parses. */
export function parseStoredDiscountLocations(
	value: string | null,
): StoredDiscountLocations {
	if (value === null) return null
	try {
		const parsed = storedLocationsSchema.safeParse(JSON.parse(value))
		return parsed.success ? parsed.data : undefined
	} catch {
		return undefined
	}
}

/** Whether a member may view a discount from its location list. */
export function discountVisibleInScope(
	discountLocationIds: StoredDiscountLocations,
	operatorLocationIds: readonly string[] | null,
): boolean {
	if (operatorLocationIds === null) return true
	if (operatorLocationIds.length === 0) return false
	if (discountLocationIds === undefined) return false
	if (discountLocationIds === null || discountLocationIds.length === 0) {
		return true
	}
	return discountLocationIds.some((id) => operatorLocationIds.includes(id))
}

/**
 * Whether a member may change a discount (save, pause, resume, archive,
 * restore or duplicate it). A member scoped to some locations changes only a
 * discount that runs at their locations alone. One shared with other locations,
 * or with every location, stays read-only for them: saving it as "only mine"
 * would take it away from the others.
 */
export function discountEditableInScope(
	discountLocationIds: StoredDiscountLocations,
	operatorLocationIds: readonly string[] | null,
): boolean {
	if (operatorLocationIds === null) return true
	if (operatorLocationIds.length === 0) return false
	if (!discountLocationIds || discountLocationIds.length === 0) return false
	return discountLocationIds.every((id) => operatorLocationIds.includes(id))
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
