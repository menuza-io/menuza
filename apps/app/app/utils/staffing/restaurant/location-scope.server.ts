import {
	and,
	asc,
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationTag,
	UserOrganization,
	UserOrganizationLocation,
	UserOrganizationLocationTag,
} from '@repo/database'
import {
	type MemberLocationScopeInput,
	type StaffingLocationScope,
	staffingLocationScopeSchema,
} from '@repo/staffing-restaurant'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'

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
	/** Location tags granted as a group (#374). */
	tagIds: string[]
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
	return resolveMemberLocationIds(userId, organizationId)
}

/** Every active member's stored scope and chosen locations, keyed by user id. */
export async function listMemberLocationAccess(
	organizationId: string,
): Promise<Map<string, MemberLocationAccess>> {
	const [members, grants, tagGrants] = await Promise.all([
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
		db
			.select({
				userId: UserOrganizationLocationTag.userId,
				tagId: UserOrganizationLocationTag.tagId,
			})
			.from(UserOrganizationLocationTag)
			.innerJoin(
				OrganizationLocationTag,
				and(
					eq(OrganizationLocationTag.id, UserOrganizationLocationTag.tagId),
					eq(OrganizationLocationTag.organizationId, organizationId),
				),
			)
			.where(eq(UserOrganizationLocationTag.organizationId, organizationId)),
	])
	const byUser = new Map<string, string[]>()
	for (const grant of grants) {
		byUser.set(grant.userId, [
			...(byUser.get(grant.userId) ?? []),
			grant.locationId,
		])
	}
	const tagsByUser = new Map<string, string[]>()
	for (const grant of tagGrants) {
		tagsByUser.set(grant.userId, [
			...(tagsByUser.get(grant.userId) ?? []),
			grant.tagId,
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
					tagIds: (tagsByUser.get(member.userId) ?? []).sort(),
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
	| {
			ok: false
			reason: 'member_not_found' | 'unknown_location' | 'unknown_tag'
	  }

/**
 * Replaces a member's staffing location access in one transaction. Every
 * submitted id must be a location of this organization (a crafted id from
 * another organization is refused, not stored). Returns what it replaced so
 * the caller can audit the change.
 */
export async function setMemberLocationScope(input: {
	organizationId: string
	userId: string
	value: Omit<MemberLocationScopeInput, 'tagIds'> & { tagIds?: string[] }
}): Promise<SetMemberLocationScopeResult> {
	const { organizationId, userId } = input
	const value = { ...input.value, tagIds: input.value.tagIds ?? [] }

	if (value.locationIds.length > 0) {
		// Read the organization's locations and compare here: D1 allows only 100
		// bound parameters per statement, and a group can hold more locations.
		const owned = new Set(
			(
				await db
					.select({ id: OrganizationLocation.id })
					.from(OrganizationLocation)
					.where(eq(OrganizationLocation.organizationId, organizationId))
			).map((row) => row.id),
		)
		if (!value.locationIds.every((id) => owned.has(id))) {
			return { ok: false, reason: 'unknown_location' }
		}
	}
	if (value.tagIds.length > 0) {
		const ownedTags = new Set(
			(
				await db
					.select({ id: OrganizationLocationTag.id })
					.from(OrganizationLocationTag)
					.where(eq(OrganizationLocationTag.organizationId, organizationId))
			).map((row) => row.id),
		)
		if (!value.tagIds.every((id) => ownedTags.has(id))) {
			return { ok: false, reason: 'unknown_tag' }
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
		const existingTags = await tx
			.select({ tagId: UserOrganizationLocationTag.tagId })
			.from(UserOrganizationLocationTag)
			.where(
				and(
					eq(UserOrganizationLocationTag.userId, userId),
					eq(UserOrganizationLocationTag.organizationId, organizationId),
				),
			)
		const parsedPrevious = staffingLocationScopeSchema.safeParse(
			member.locationScope,
		)
		const previous: MemberLocationAccess = {
			scope: parsedPrevious.success ? parsedPrevious.data : 'selected',
			locationIds: existing.map((row) => row.locationId).sort(),
			tagIds: existingTags.map((row) => row.tagId).sort(),
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
		// A statement binds at most 100 parameters on D1: 3 per grant row.
		for (let i = 0; i < value.locationIds.length; i += 30) {
			await tx.insert(UserOrganizationLocation).values(
				value.locationIds.slice(i, i + 30).map((locationId) => ({
					userId,
					organizationId,
					locationId,
				})),
			)
		}
		await tx
			.delete(UserOrganizationLocationTag)
			.where(
				and(
					eq(UserOrganizationLocationTag.userId, userId),
					eq(UserOrganizationLocationTag.organizationId, organizationId),
				),
			)
		for (let i = 0; i < value.tagIds.length; i += 30) {
			await tx.insert(UserOrganizationLocationTag).values(
				value.tagIds.slice(i, i + 30).map((tagId) => ({
					userId,
					organizationId,
					tagId,
				})),
			)
		}
		return {
			ok: true as const,
			previous,
			next: {
				scope: value.scope,
				locationIds: [...value.locationIds],
				tagIds: [...value.tagIds],
			},
		}
	})
}
