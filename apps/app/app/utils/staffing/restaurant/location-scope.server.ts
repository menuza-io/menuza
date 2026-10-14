import {
	and,
	asc,
	db,
	eq,
	inArray,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import {
	locationIdsClaim,
	type MemberLocationScopeInput,
	type StaffingLocationScope,
	staffingLocationScopeSchema,
} from '@repo/staffing-restaurant'

/**
 * Location scoping for staffing access (control plane, ids only).
 *
 * A member's staffing grants are org-wide by default. An admin may limit a
 * member to chosen locations; the choice is stored here as opaque location ids
 * and travels in the staffing token's `scopeIds` claim, which tenant-api
 * applies on every route through `scopeToScopes`. Nothing about staff is
 * stored or read here.
 *
 * Tokens are stateless, so a change takes effect when the member's current
 * token expires: at most 15 minutes, or 5 for tokens carrying pay or private
 * grants. See ADR 047 for why that lag is accepted.
 */

export type MemberLocationAccess = {
	scope: StaffingLocationScope
	locationIds: string[]
}

/**
 * The `scopeIds` claim for a member: `null` means every location. An
 * inactive or missing membership, or a stored value this code does not
 * recognize, resolves to no locations at all (fail closed). Locations that no
 * longer belong to the organization never count.
 */
export async function resolveLocationGrantIds(
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
	return locationIdsClaim(
		'selected',
		rows.map((row) => row.locationId),
	)
}

/** Every active member's stored scope and chosen locations, keyed by user id. */
export async function listMemberLocationAccess(
	organizationId: string,
): Promise<Map<string, MemberLocationAccess>> {
	const [members, grants] = await Promise.all([
		db
			.select({
				userId: UserOrganization.userId,
				locationScope: UserOrganization.locationScope,
			})
			.from(UserOrganization)
			.where(eq(UserOrganization.organizationId, organizationId)),
		db
			.select({
				userId: UserOrganizationLocation.userId,
				locationId: UserOrganizationLocation.locationId,
			})
			.from(UserOrganizationLocation)
			.innerJoin(
				OrganizationLocation,
				and(
					eq(OrganizationLocation.id, UserOrganizationLocation.locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.where(eq(UserOrganizationLocation.organizationId, organizationId)),
	])
	const byUser = new Map<string, string[]>()
	for (const grant of grants) {
		byUser.set(grant.userId, [
			...(byUser.get(grant.userId) ?? []),
			grant.locationId,
		])
	}
	return new Map(
		members.map((member) => {
			const parsed = staffingLocationScopeSchema.safeParse(member.locationScope)
			return [
				member.userId,
				{
					// An unrecognized stored value reads as the most restrictive scope.
					scope: parsed.success ? parsed.data : 'selected',
					locationIds: (byUser.get(member.userId) ?? []).sort(),
				},
			]
		}),
	)
}

/** The organization's active locations, for the picker. Ids and names only. */
export async function listScopableLocations(organizationId: string) {
	return db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(asc(OrganizationLocation.name))
}

export type SetMemberLocationScopeResult =
	| { ok: true; previous: MemberLocationAccess; next: MemberLocationAccess }
	| { ok: false; reason: 'member_not_found' | 'unknown_location' }

/**
 * Replaces a member's staffing location access in one transaction. Every
 * submitted id must be a location of this organization (a crafted id from
 * another organization is refused, not stored). Returns what it replaced so
 * the caller can audit the change.
 */
export async function setMemberLocationScope(input: {
	organizationId: string
	userId: string
	value: MemberLocationScopeInput
}): Promise<SetMemberLocationScopeResult> {
	const { organizationId, userId, value } = input

	if (value.locationIds.length > 0) {
		const owned = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					inArray(OrganizationLocation.id, value.locationIds),
				),
			)
		if (owned.length !== value.locationIds.length) {
			return { ok: false, reason: 'unknown_location' }
		}
	}

	return db.transaction(async (tx) => {
		const [member] = await tx
			.select({ locationScope: UserOrganization.locationScope })
			.from(UserOrganization)
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!member)
			return { ok: false as const, reason: 'member_not_found' as const }

		const existing = await tx
			.select({ locationId: UserOrganizationLocation.locationId })
			.from(UserOrganizationLocation)
			.where(
				and(
					eq(UserOrganizationLocation.userId, userId),
					eq(UserOrganizationLocation.organizationId, organizationId),
				),
			)
		const parsedPrevious = staffingLocationScopeSchema.safeParse(
			member.locationScope,
		)
		const previous: MemberLocationAccess = {
			scope: parsedPrevious.success ? parsedPrevious.data : 'selected',
			locationIds: existing.map((row) => row.locationId).sort(),
		}

		await tx
			.update(UserOrganization)
			.set({ locationScope: value.scope })
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organizationId),
				),
			)
		await tx
			.delete(UserOrganizationLocation)
			.where(
				and(
					eq(UserOrganizationLocation.userId, userId),
					eq(UserOrganizationLocation.organizationId, organizationId),
				),
			)
		if (value.locationIds.length > 0) {
			await tx.insert(UserOrganizationLocation).values(
				value.locationIds.map((locationId) => ({
					userId,
					organizationId,
					locationId,
				})),
			)
		}
		return {
			ok: true as const,
			previous,
			next: { scope: value.scope, locationIds: [...value.locationIds] },
		}
	})
}
