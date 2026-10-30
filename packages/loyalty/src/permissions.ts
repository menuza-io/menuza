/**
 * Organization RBAC permissions for Loyalty. Kept in sync with
 * `ORG_PERMISSIONS` in `@repo/auth`, `packages/database/setup-roles.ts` and the
 * control-plane migration that seeds them.
 */
export const LOYALTY_PERMISSIONS = {
	/** Members, balances and point activity. */
	READ_LOYALTY: 'read:loyalty:any',
	/** Program and reward definitions. */
	UPDATE_LOYALTY_PROGRAM: 'update:loyalty_program:any',
	/** Manual point adjustments, always with a reason. */
	UPDATE_LOYALTY_POINTS: 'update:loyalty_points:any',
	/** Resolving redemptions that wait for review. */
	UPDATE_LOYALTY_REDEMPTION: 'update:loyalty_redemption:any',
	/** Program figures and reports. */
	READ_LOYALTY_REPORT: 'read:loyalty_report:any',
} as const

export type LoyaltyPermissionKey = keyof typeof LOYALTY_PERMISSIONS
export type LoyaltyPermission =
	(typeof LOYALTY_PERMISSIONS)[LoyaltyPermissionKey]

export const LOYALTY_PERMISSION_LIST: readonly LoyaltyPermission[] =
	Object.values(LOYALTY_PERMISSIONS)

/**
 * Grants that move points. They shorten the operator token to 5 minutes and
 * are never issued during support impersonation.
 */
export const LOYALTY_SENSITIVE_GRANTS = [
	LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS,
	LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION,
] as const satisfies readonly LoyaltyPermission[]

const sensitive = new Set<string>(LOYALTY_SENSITIVE_GRANTS)

export function isSensitiveLoyaltyGrant(grant: string): boolean {
	return sensitive.has(grant)
}

export function hasSensitiveLoyaltyGrant(grants: readonly string[]): boolean {
	return grants.some((grant) => sensitive.has(grant))
}

/** Every `update:*` loyalty permission implies reading members. */
export const LOYALTY_IMPLIED_READ: Readonly<
	Partial<Record<LoyaltyPermission, LoyaltyPermission>>
> = {
	[LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM]:
		LOYALTY_PERMISSIONS.READ_LOYALTY,
	[LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS]: LOYALTY_PERMISSIONS.READ_LOYALTY,
	[LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION]:
		LOYALTY_PERMISSIONS.READ_LOYALTY,
}

export function isLoyaltyPermission(value: string): value is LoyaltyPermission {
	return (LOYALTY_PERMISSION_LIST as readonly string[]).includes(value)
}

/** Keep loyalty permissions only, adding the reads each update implies. */
export function expandLoyaltyGrants(
	held: readonly string[],
): LoyaltyPermission[] {
	const set = new Set<LoyaltyPermission>()
	for (const grant of held) {
		if (!isLoyaltyPermission(grant)) continue
		set.add(grant)
		const implied = LOYALTY_IMPLIED_READ[grant]
		if (implied) set.add(implied)
	}
	return LOYALTY_PERMISSION_LIST.filter((perm) => set.has(perm))
}

/** Support impersonation may look but never change anything. */
export function restrictLoyaltyGrantsForImpersonation(
	grants: readonly LoyaltyPermission[],
	impersonated: boolean,
): LoyaltyPermission[] {
	if (!impersonated) return [...grants]
	return grants.filter(
		(grant) => !grant.startsWith('update:') && !isSensitiveLoyaltyGrant(grant),
	)
}

export function hasLoyaltyGrant(
	held: readonly string[],
	required: LoyaltyPermission,
): boolean {
	return expandLoyaltyGrants(held).includes(required)
}
