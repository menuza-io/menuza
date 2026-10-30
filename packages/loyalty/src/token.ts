import { z } from 'zod'
import { loyaltyFeaturesSchema } from './flags.ts'
import {
	expandLoyaltyGrants,
	hasSensitiveLoyaltyGrant,
	LOYALTY_PERMISSION_LIST,
	LOYALTY_PERMISSIONS,
	type LoyaltyPermission,
	restrictLoyaltyGrantsForImpersonation,
} from './permissions.ts'

/**
 * Short-lived operator token the US App mints for the browser, which then
 * calls the regional `/operator/loyalty/*` routes directly. Holds ids, grants
 * and flags only, never member data.
 */
export const LOYALTY_TOKEN_AUDIENCE = 'tenant-api-loyalty-operator' as const
export const LOYALTY_TOKEN_TYP = 'lty+jwt' as const

export const LOYALTY_TOKEN_MAX_TTL_SECONDS = 15 * 60
/** Any grant that moves points, or support impersonation, shortens the token. */
export const LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS = 5 * 60

export const LOYALTY_SCOPES = [
	'read',
	'setup',
	'members',
	'reconcile',
	'reports',
] as const
export type LoyaltyScope = (typeof LOYALTY_SCOPES)[number]
export const loyaltyScopeSchema = z.enum(LOYALTY_SCOPES)

/** Grants a token of each scope may carry (a subset of what the member holds). */
export const LOYALTY_SCOPE_GRANTS: Readonly<
	Record<LoyaltyScope, readonly LoyaltyPermission[]>
> = {
	read: [LOYALTY_PERMISSIONS.READ_LOYALTY],
	setup: [
		LOYALTY_PERMISSIONS.READ_LOYALTY,
		LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM,
	],
	members: [
		LOYALTY_PERMISSIONS.READ_LOYALTY,
		LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
	],
	reconcile: [
		LOYALTY_PERMISSIONS.READ_LOYALTY,
		LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION,
	],
	reports: [LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT],
}

export function loyaltyTokenTtlSeconds(
	grants: readonly string[],
	impersonated: boolean,
): number {
	return impersonated || hasSensitiveLoyaltyGrant(grants)
		? LOYALTY_TOKEN_SENSITIVE_TTL_SECONDS
		: LOYALTY_TOKEN_MAX_TTL_SECONDS
}

/**
 * The grants a token for `scope` gets from what the member holds: implied
 * reads added, impersonation-disallowed grants removed, then limited to the
 * scope. An empty result means the member may not have this token.
 */
export function loyaltyScopeGrantsFor(
	scope: LoyaltyScope,
	held: readonly string[],
	impersonated = false,
): LoyaltyPermission[] {
	const expanded = expandLoyaltyGrants(held)
	const safe = restrictLoyaltyGrantsForImpersonation(expanded, impersonated)
	const allowed = new Set<LoyaltyPermission>(LOYALTY_SCOPE_GRANTS[scope])
	return safe.filter((grant) => allowed.has(grant))
}

export const loyaltyGrantSchema = z.enum(
	LOYALTY_PERMISSION_LIST as [LoyaltyPermission, ...LoyaltyPermission[]],
)

export const loyaltyDataRegionSchema = z.enum(['us', 'ksa'])

export const loyaltyLocationIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid location ID')

export const loyaltyTokenClaimsSchema = z
	.object({
		aud: z.literal(LOYALTY_TOKEN_AUDIENCE),
		iss: z.string().min(1).max(120).optional(),
		role: z.literal('operator'),
		region: loyaltyDataRegionSchema,
		orgId: z.string().min(1).max(64),
		sub: z.string().min(1).max(64),
		scope: loyaltyScopeSchema,
		grants: z.array(loyaltyGrantSchema).min(1).max(5),
		/** `null` allows every location; `[]` none. */
		locationIds: z.array(loyaltyLocationIdSchema).max(200).nullable(),
		features: loyaltyFeaturesSchema,
		impersonated: z.boolean(),
		iat: z.number().int().positive(),
		exp: z.number().int().positive(),
	})
	.strict()
	.superRefine((claims, ctx) => {
		const ttl = claims.exp - claims.iat
		if (ttl <= 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['exp'],
				message: 'Token expiration must be after issued-at time',
			})
			return
		}
		const maxTtl = loyaltyTokenTtlSeconds(claims.grants, claims.impersonated)
		if (ttl > maxTtl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['exp'],
				message: `Token TTL exceeds the maximum of ${maxTtl}s`,
			})
		}
		if (
			claims.impersonated &&
			claims.grants.some((grant) => grant.startsWith('update:'))
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['grants'],
				message: 'Impersonated tokens cannot hold write grants',
			})
		}
		const allowed = new Set<string>(LOYALTY_SCOPE_GRANTS[claims.scope])
		if (claims.grants.some((grant) => !allowed.has(grant))) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['grants'],
				message: 'A grant is not valid for the token scope',
			})
		}
		if (new Set(claims.grants).size !== claims.grants.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['grants'],
				message: 'Duplicate grant',
			})
		}
	})

export type LoyaltyTokenClaims = z.infer<typeof loyaltyTokenClaimsSchema>

/** `null` allows every location; `[]` allows none. */
export function loyaltyAllowsLocation(
	locationIds: readonly string[] | null,
	locationId: string,
): boolean {
	if (locationIds === null) return true
	return locationIds.includes(locationId)
}
