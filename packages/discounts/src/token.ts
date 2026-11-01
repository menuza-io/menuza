import { z } from 'zod'

/**
 * Short-lived operator token the US App mints for the browser, which then
 * calls the regional `GET /operator/discounts/usage` directly (counts only).
 * Holds ids and a grant, never customer data. Modelled on the loyalty token
 * (`@repo/loyalty`): signed with `TENANT_OPERATOR_TOKEN`, `typ` `dsc+jwt`.
 */
export const DISCOUNT_TOKEN_AUDIENCE = 'tenant-api-discounts-operator' as const
export const DISCOUNT_TOKEN_TYP = 'dsc+jwt' as const

export const DISCOUNT_TOKEN_MAX_TTL_SECONDS = 15 * 60
/** Support impersonation shortens the token. */
export const DISCOUNT_TOKEN_IMPERSONATED_TTL_SECONDS = 5 * 60

/** The permission a member needs to view discount usage (control-plane RBAC). */
export const DISCOUNT_READ_PERMISSION = 'read:discount:any' as const
export type DiscountPermission = typeof DISCOUNT_READ_PERMISSION

/** Only reading usage goes through the region; writes happen in App on D1. */
export const DISCOUNT_SCOPES = ['read'] as const
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number]
export const discountScopeSchema = z.enum(DISCOUNT_SCOPES)

export const DISCOUNT_SCOPE_GRANTS: Readonly<
	Record<DiscountScope, readonly DiscountPermission[]>
> = { read: [DISCOUNT_READ_PERMISSION] }

export function discountTokenTtlSeconds(impersonated: boolean): number {
	return impersonated
		? DISCOUNT_TOKEN_IMPERSONATED_TTL_SECONDS
		: DISCOUNT_TOKEN_MAX_TTL_SECONDS
}

/**
 * The grants a token for `scope` gets from what the member holds: an empty
 * result means the member may not have this token. `update:discount:any`
 * implies read.
 */
export function discountScopeGrantsFor(
	scope: DiscountScope,
	held: readonly string[],
): DiscountPermission[] {
	const canRead =
		held.includes(DISCOUNT_READ_PERMISSION) ||
		held.includes('update:discount:any')
	const allowed = new Set<DiscountPermission>(DISCOUNT_SCOPE_GRANTS[scope])
	return canRead
		? [DISCOUNT_READ_PERMISSION].filter((grant) => allowed.has(grant))
		: []
}

export const discountDataRegionSchema = z.enum(['us', 'ksa'])

export const discountTokenClaimsSchema = z
	.object({
		aud: z.literal(DISCOUNT_TOKEN_AUDIENCE),
		iss: z.string().min(1).max(120).optional(),
		role: z.literal('operator'),
		region: discountDataRegionSchema,
		orgId: z.string().min(1).max(64),
		sub: z.string().min(1).max(64),
		scope: discountScopeSchema,
		grants: z.array(z.literal(DISCOUNT_READ_PERMISSION)).min(1).max(1),
		/** `null` = every location; a list keeps usage to sales at those locations. */
		locationIds: z.array(z.string().min(1).max(64)).max(500).nullable(),
		impersonated: z.boolean(),
		iat: z.number().int().positive(),
		exp: z.number().int().positive(),
	})
	.strict()
	.superRefine((claims, ctx) => {
		const ttl = claims.exp - claims.iat
		if (ttl <= 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['exp'],
				message: 'Token expiration must be after issued-at time',
			})
			return
		}
		const maxTtl = discountTokenTtlSeconds(claims.impersonated)
		if (ttl > maxTtl) {
			ctx.addIssue({
				code: 'custom',
				path: ['exp'],
				message: `Token TTL exceeds the maximum of ${maxTtl}s`,
			})
		}
		const allowed = new Set<string>(DISCOUNT_SCOPE_GRANTS[claims.scope])
		if (claims.grants.some((grant) => !allowed.has(grant))) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'A grant is not valid for the token scope',
			})
		}
	})
export type DiscountTokenClaims = z.infer<typeof discountTokenClaimsSchema>

/** Query of `GET /operator/discounts/usage?ids=a,b,c`. */
export const DISCOUNT_USAGE_MAX_IDS = 200
export const discountUsageIdSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9_-]+$/)

/** One discount's counts in `GET /operator/discounts/usage`. No customer data. */
export const discountUsageEntrySchema = z
	.object({
		discountId: z.string(),
		/** Reserved and consumed uses: what counts against limits. */
		uses: z.number().int().min(0),
		reserved: z.number().int().min(0),
		consumed: z.number().int().min(0),
		refunded: z.number().int().min(0),
		/** Item plus delivery discount of uses that count (reserved and consumed). */
		discountMinor: z.number().int().min(0),
	})
	.strict()
export const discountUsageResponseSchema = z
	.object({ usage: z.array(discountUsageEntrySchema) })
	.strict()
export type DiscountUsageEntry = z.infer<typeof discountUsageEntrySchema>

export const DISCOUNT_REDEMPTION_STATES = [
	'reserved',
	'consumed',
	'released',
	'refunded',
] as const
export type DiscountRedemptionState =
	(typeof DISCOUNT_REDEMPTION_STATES)[number]
