import {
	and,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationLocationTag,
	OrganizationLocationTagLink,
	UserOrganization,
	UserOrganizationLocation,
	UserOrganizationLocationTag,
} from '@repo/database'

/**
 * The one place that turns a member's stored location access into location
 * ids (#374). Every token mint and every scoped loader or action reaches it
 * through `resolveLocationGrantIds` (staffing), `resolveReservationsLocationIds`,
 * `resolveLoyaltyLocationIds` or `resolveDiscountLocationIds`, which all
 * delegate here, so a tag can never widen access in one module and not in
 * another. `location-scope-guards.test.ts` fails when another file reads the
 * grant tables.
 *
 * `null` is every location, `[]` none. An inactive or missing membership, or a
 * stored scope this code does not recognise, resolves to no locations (fail
 * closed). A `selected` member's locations are the explicit grants plus every
 * location that carries a tag they were granted, read now, so a location tagged
 * later is covered and a location untagged later is not. Locations and tags
 * from another organization never count.
 */
export async function resolveMemberLocationIds(
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

	const [explicit, tagged] = await Promise.all([
		db
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
			),
		db
			.select({ locationId: OrganizationLocationTagLink.locationId })
			.from(UserOrganizationLocationTag)
			.innerJoin(
				OrganizationLocationTag,
				and(
					eq(OrganizationLocationTag.id, UserOrganizationLocationTag.tagId),
					eq(OrganizationLocationTag.organizationId, organizationId),
				),
			)
			.innerJoin(
				OrganizationLocationTagLink,
				eq(OrganizationLocationTagLink.tagId, OrganizationLocationTag.id),
			)
			.innerJoin(
				OrganizationLocation,
				and(
					eq(OrganizationLocation.id, OrganizationLocationTagLink.locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.where(
				and(
					eq(UserOrganizationLocationTag.userId, userId),
					eq(UserOrganizationLocationTag.organizationId, organizationId),
				),
			),
	])
	return [
		...new Set([...explicit, ...tagged].map((row) => row.locationId)),
	].sort()
}

/** Location ids carrying any of the given tags (tags of this organization only). */
export async function locationIdsForTags(
	organizationId: string,
	tagIds: readonly string[],
): Promise<string[]> {
	if (tagIds.length === 0) return []
	const rows = await db
		.select({ locationId: OrganizationLocationTagLink.locationId })
		.from(OrganizationLocationTagLink)
		.innerJoin(
			OrganizationLocationTag,
			and(
				eq(OrganizationLocationTag.id, OrganizationLocationTagLink.tagId),
				eq(OrganizationLocationTag.organizationId, organizationId),
			),
		)
		.innerJoin(
			OrganizationLocation,
			and(
				eq(OrganizationLocation.id, OrganizationLocationTagLink.locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.where(inArray(OrganizationLocationTagLink.tagId, [...tagIds]))
	return [...new Set(rows.map((row) => row.locationId))].sort()
}

/** Whether a member's scope reaches this location (`null` scope reaches all). */
export function scopeAllowsLocation(
	scope: readonly string[] | null,
	locationId: string,
): boolean {
	return scope === null || scope.includes(locationId)
}

/** Splits location ids into those inside the member's scope and those outside. */
export function partitionByScope(
	scope: readonly string[] | null,
	locationIds: readonly string[],
): { allowed: string[]; denied: string[] } {
	if (scope === null) return { allowed: [...locationIds], denied: [] }
	const allowed: string[] = []
	const denied: string[] = []
	for (const id of locationIds) {
		;(scope.includes(id) ? allowed : denied).push(id)
	}
	return { allowed, denied }
}
