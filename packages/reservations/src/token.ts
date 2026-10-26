import { z } from 'zod'
import { reservationsFeaturesSchema } from './flags.ts'
import {
	expandImpliedGrants,
	hasSensitiveGrant,
	RESERVATIONS_PERMISSION_LIST,
	RESERVATIONS_PERMISSIONS,
	type ReservationsPermission,
	restrictGrantsForImpersonation,
} from './permissions.ts'

export const RESERVATIONS_TOKEN_AUDIENCE =
	'tenant-api-reservations-operator' as const
export const RESERVATIONS_TOKEN_TYP = 'rsv+jwt' as const

/** 15 minutes for standard scopes (`book`, `setup`, `reports`). */
export const RESERVATIONS_TOKEN_MAX_TTL_SECONDS = 15 * 60
/** 5 minutes when any sensitive grant is included or when impersonated. */
export const RESERVATIONS_TOKEN_SENSITIVE_TTL_SECONDS = 5 * 60

export const RESERVATIONS_SCOPES = [
	'book',
	'guests',
	'setup',
	'reports',
	'payments',
] as const

export type ReservationsScope = (typeof RESERVATIONS_SCOPES)[number]

export const reservationsScopeSchema = z.enum(RESERVATIONS_SCOPES)

export const SCOPE_GRANTS: Readonly<
	Record<ReservationsScope, readonly ReservationsPermission[]>
> = {
	book: [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	],
	guests: [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST,
	],
	setup: [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS,
	],
	reports: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_REPORT],
	payments: [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
	],
}

export function maxTokenTtlSeconds(
	grants: readonly string[],
	impersonated: boolean,
): number {
	if (impersonated || hasSensitiveGrant(grants)) {
		return RESERVATIONS_TOKEN_SENSITIVE_TTL_SECONDS
	}
	return RESERVATIONS_TOKEN_MAX_TTL_SECONDS
}

/**
 * Filter a member's held permissions (expanding implied reads and stripping
 * impersonation-disallowed grants) down to the grants allowed for `scope`.
 */
export function scopeGrantsFor(
	scope: ReservationsScope,
	heldPermissions: readonly ReservationsPermission[],
	impersonated = false,
): ReservationsPermission[] {
	const expanded = expandImpliedGrants(heldPermissions)
	const safe = restrictGrantsForImpersonation(expanded, impersonated)
	const allowed = new Set<ReservationsPermission>(SCOPE_GRANTS[scope])
	const filtered = safe.filter((grant) => allowed.has(grant))
	// For guests and payments scopes, read:reservation:any alone is not enough
	// if they hold no guest or payment grant under impersonation.
	if (
		scope === 'guests' &&
		!filtered.includes(RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST) &&
		!filtered.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_GUEST)
	) {
		return []
	}
	if (
		scope === 'payments' &&
		!filtered.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT)
	) {
		return []
	}
	return filtered
}

export const reservationsGrantSchema = z.enum(
	RESERVATIONS_PERMISSION_LIST as [
		ReservationsPermission,
		...ReservationsPermission[],
	],
)

export const reservationsDataRegionSchema = z.enum(['us', 'ksa'])
export type ReservationsDataRegion = z.infer<
	typeof reservationsDataRegionSchema
>

export const reservationsLocationIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid location ID')

export const reservationsTokenClaimsSchema = z
	.object({
		aud: z.literal(RESERVATIONS_TOKEN_AUDIENCE),
		iss: z.string().min(1).max(120).optional(),
		role: z.literal('operator'),
		region: reservationsDataRegionSchema,
		orgId: z.string().min(1).max(64),
		sub: z.string().min(1).max(64),
		scope: reservationsScopeSchema,
		grants: z.array(reservationsGrantSchema).min(1).max(8),
		locationIds: z.array(reservationsLocationIdSchema).max(200).nullable(),
		features: reservationsFeaturesSchema,
		impersonated: z.boolean(),
		/**
		 * `station`: minted by tenant-api for a person signed in at a paired
		 * Station till (`POST /pos/reservations/token`). Limited to the day-of-service
		 * routes; guest contact details are masked without the guest grant.
		 */
		channel: z.literal('station').optional(),
		/** The Station terminal the token was minted for. */
		deviceId: z.string().min(1).max(64).optional(),
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
		const maxTtl = maxTokenTtlSeconds(claims.grants, claims.impersonated)
		if (ttl > maxTtl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['exp'],
				message: `Token TTL (${ttl}s) exceeds maximum allowed (${maxTtl}s)`,
			})
		}
		if (claims.impersonated) {
			for (const grant of claims.grants) {
				if (grant.startsWith('update:') || hasSensitiveGrant([grant])) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ['grants'],
						message:
							'Impersonated tokens cannot hold write or sensitive grants',
					})
					break
				}
			}
		}
		const allowedForScope = new Set<string>(SCOPE_GRANTS[claims.scope])
		for (const grant of claims.grants) {
			if (!allowedForScope.has(grant)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['grants'],
					message: `Grant ${grant} is not valid for scope ${claims.scope}`,
				})
			}
		}
	})

export type ReservationsTokenClaims = z.infer<
	typeof reservationsTokenClaimsSchema
>
export type ReservationsOperatorTokenClaims = ReservationsTokenClaims

/**
 * Check whether an operator token's `locationIds` claim allows acting on `locationId`.
 * `null` allows all locations; `[]` allows none.
 */
export function allowsLocation(
	locationIds: readonly string[] | null,
	locationId: string,
): boolean {
	if (locationIds === null) return true
	return locationIds.includes(locationId)
}
