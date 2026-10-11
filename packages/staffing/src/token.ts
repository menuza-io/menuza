import { z } from 'zod'

export const STAFFING_SCOPE = 'staffing'

export const STAFFING_AREAS = ['staff', 'schedule', 'timeclock'] as const
export type StaffingArea = (typeof STAFFING_AREAS)[number]
export type StaffingAccessLevel = 'read' | 'write'

const level = z.enum(['read', 'write'])

/**
 * Claims App adds to a `staffing` operator JWT. Missing areas grant nothing.
 * `locationIds: null` means every location; an empty array means none. The
 * claim is reserved so location-scoped managers can ship without a token break.
 */
export const staffingTokenClaimsSchema = z.object({
	scope: z.literal(STAFFING_SCOPE),
	areas: z
		.object({
			staff: level.optional(),
			schedule: level.optional(),
			timeclock: level.optional(),
		})
		.strict(),
	locationIds: z.array(z.string().min(1).max(64)).max(200).nullable(),
	canViewPay: z.boolean().optional(),
})
export type StaffingTokenClaims = z.infer<typeof staffingTokenClaimsSchema>

export function staffingTokenAllows(
	claims: Pick<StaffingTokenClaims, 'areas'>,
	area: StaffingArea,
	required: StaffingAccessLevel,
) {
	const granted = claims.areas[area]
	if (!granted) return false
	return required === 'read' || granted === 'write'
}

export function staffingTokenAllowsLocation(
	claims: Pick<StaffingTokenClaims, 'locationIds'>,
	locationId: string,
) {
	return claims.locationIds === null || claims.locationIds.includes(locationId)
}
