import { z } from 'zod'
import { inventoryFeaturesSchema } from './flags.ts'
import {
	expandInventoryGrants,
	INVENTORY_PERMISSION_LIST,
	INVENTORY_PERMISSIONS,
	type InventoryPermission,
	restrictInventoryGrantsForImpersonation,
} from './permissions.ts'

/**
 * Short-lived operator token the US App mints for the browser, which then
 * calls the regional `/operator/inventory/*` routes directly. Holds ids,
 * grants and flags only, never stock or staff data.
 */
export const INVENTORY_TOKEN_AUDIENCE = 'tenant-api-inventory-operator' as const
export const INVENTORY_TOKEN_TYP = 'inv+jwt' as const

export const INVENTORY_TOKEN_MAX_TTL_SECONDS = 15 * 60
/** Support impersonation shortens the token. */
export const INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS = 5 * 60

export const INVENTORY_SCOPES = ['read', 'write'] as const
export type InventoryScope = (typeof INVENTORY_SCOPES)[number]
export const inventoryScopeSchema = z.enum(INVENTORY_SCOPES)

/** Grants a token of each scope may carry (a subset of what the member holds). */
export const INVENTORY_SCOPE_GRANTS: Readonly<
	Record<InventoryScope, readonly InventoryPermission[]>
> = {
	read: [
		INVENTORY_PERMISSIONS.READ_INVENTORY,
		INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
	],
	write: INVENTORY_PERMISSION_LIST,
}

export function inventoryTokenTtlSeconds(impersonated: boolean): number {
	return impersonated
		? INVENTORY_TOKEN_IMPERSONATED_TTL_SECONDS
		: INVENTORY_TOKEN_MAX_TTL_SECONDS
}

/**
 * The grants a token for `scope` gets from what the member holds: implied
 * reads added, impersonation-disallowed grants removed, then limited to the
 * scope. An empty result means the member may not have this token.
 */
export function inventoryScopeGrantsFor(
	scope: InventoryScope,
	held: readonly string[],
	impersonated = false,
): InventoryPermission[] {
	const expanded = expandInventoryGrants(held)
	const safe = restrictInventoryGrantsForImpersonation(expanded, impersonated)
	const allowed = new Set<InventoryPermission>(INVENTORY_SCOPE_GRANTS[scope])
	return safe.filter((grant) => allowed.has(grant))
}

export const inventoryGrantSchema = z.enum(
	INVENTORY_PERMISSION_LIST as [InventoryPermission, ...InventoryPermission[]],
)

export const inventoryDataRegionSchema = z.enum(['us', 'ksa'])

export const inventoryLocationIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid location ID')

export const inventoryTokenClaimsSchema = z
	.object({
		aud: z.literal(INVENTORY_TOKEN_AUDIENCE),
		iss: z.string().min(1).max(120).optional(),
		role: z.literal('operator'),
		region: inventoryDataRegionSchema,
		orgId: z.string().min(1).max(64),
		sub: z.string().min(1).max(64),
		scope: inventoryScopeSchema,
		grants: z.array(inventoryGrantSchema).min(1).max(5),
		/** `null` allows every location; `[]` none. */
		locationIds: z.array(inventoryLocationIdSchema).max(200).nullable(),
		features: inventoryFeaturesSchema,
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
		const maxTtl = inventoryTokenTtlSeconds(claims.impersonated)
		if (ttl > maxTtl) {
			ctx.addIssue({
				code: 'custom',
				path: ['exp'],
				message: `Token TTL exceeds the maximum of ${maxTtl}s`,
			})
		}
		if (
			claims.impersonated &&
			claims.grants.some((grant) => grant.startsWith('update:'))
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'Impersonated tokens cannot hold write grants',
			})
		}
		const allowed = new Set<string>(INVENTORY_SCOPE_GRANTS[claims.scope])
		if (claims.grants.some((grant) => !allowed.has(grant))) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'A grant is not valid for the token scope',
			})
		}
		if (new Set(claims.grants).size !== claims.grants.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['grants'],
				message: 'Duplicate grant',
			})
		}
	})

export type InventoryTokenClaims = z.infer<typeof inventoryTokenClaimsSchema>

/** `null` allows every location; `[]` allows none. */
export function inventoryAllowsLocation(
	locationIds: readonly string[] | null,
	locationId: string,
): boolean {
	if (locationIds === null) return true
	return locationIds.includes(locationId)
}
