import { z } from 'zod'

/**
 * Which locations a member's staffing access covers.
 *
 * - `all`: every location, including ones added later. The default, and what
 *   every member had before location scoping existed.
 * - `selected`: only the chosen locations. Choosing none means no staffing
 *   access at all (the member keeps every other permission they hold).
 */
export const STAFFING_LOCATION_SCOPES = ['all', 'selected'] as const
export const staffingLocationScopeSchema = z.enum(STAFFING_LOCATION_SCOPES)
export type StaffingLocationScope = z.infer<typeof staffingLocationScopeSchema>

/** More than any restaurant group has, so a crafted form cannot send a huge list. */
export const STAFFING_MAX_SCOPED_LOCATIONS = 200
/** Tags a member can be granted (an organization has at most 50 tags). */
export const STAFFING_MAX_SCOPED_TAGS = 50

const locationIdSchema = z.string().trim().min(1).max(64)

/** A member's staffing location access as submitted by an admin. */
export const memberLocationScopeInputSchema = z
	.object({
		scope: staffingLocationScopeSchema,
		locationIds: z
			.array(locationIdSchema)
			.max(STAFFING_MAX_SCOPED_LOCATIONS)
			.default([]),
		/** Location tags granted as a group (#374); resolved to locations when read. */
		tagIds: z.array(locationIdSchema).max(STAFFING_MAX_SCOPED_TAGS).default([]),
	})
	.strict()
	.transform((value) => ({
		scope: value.scope,
		// `all` never stores rows: any list that came with it is dropped, so the
		// two states cannot disagree.
		locationIds:
			value.scope === 'all' ? [] : [...new Set(value.locationIds)].sort(),
		tagIds: value.scope === 'all' ? [] : [...new Set(value.tagIds)].sort(),
	}))
export type MemberLocationScopeInput = z.output<
	typeof memberLocationScopeInputSchema
>

/**
 * Turns the stored scope and rows into the token's `locationIds` claim:
 * `null` for every location, otherwise the (possibly empty) list. Anything
 * unrecognized fails closed to "no locations" rather than to "all".
 */
export function locationIdsClaim(
	scope: string | null | undefined,
	selectedLocationIds: readonly string[],
): string[] | null {
	if (scope === 'all') return null
	if (scope === 'selected') return [...new Set(selectedLocationIds)].sort()
	return []
}
