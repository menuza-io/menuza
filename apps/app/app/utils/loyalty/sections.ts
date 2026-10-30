import {
	hasLoyaltyGrant,
	LOYALTY_PERMISSION_LIST,
	LOYALTY_PERMISSIONS as P,
	type LoyaltyFeatures,
	type LoyaltyPermission,
	type LoyaltyScope,
} from '@repo/loyalty'

export type LoyaltySectionKey = 'overview' | 'program' | 'rewards' | 'activity'

export type LoyaltySectionDefinition = {
	id: LoyaltySectionKey
	key: LoyaltySectionKey
	path: LoyaltySectionKey
	/** Permissions that allow viewing this section. */
	permissions: readonly LoyaltyPermission[]
	/** Alias for `requireLoyaltyAccess` options. */
	anyOf: readonly LoyaltyPermission[]
	/** Token scope the section's regional client mints. */
	scope: LoyaltyScope
}

export const LOYALTY_SECTION_PERMISSIONS: readonly LoyaltyPermission[] =
	LOYALTY_PERMISSION_LIST

export const LOYALTY_SECTIONS: readonly LoyaltySectionDefinition[] = [
	{
		id: 'overview',
		key: 'overview',
		path: 'overview',
		permissions: [P.READ_LOYALTY, P.READ_LOYALTY_REPORT],
		anyOf: [P.READ_LOYALTY, P.READ_LOYALTY_REPORT],
		scope: 'read',
	},
	{
		id: 'program',
		key: 'program',
		path: 'program',
		permissions: [P.READ_LOYALTY, P.UPDATE_LOYALTY_PROGRAM],
		anyOf: [P.READ_LOYALTY, P.UPDATE_LOYALTY_PROGRAM],
		scope: 'setup',
	},
	{
		id: 'rewards',
		key: 'rewards',
		path: 'rewards',
		permissions: [P.READ_LOYALTY, P.UPDATE_LOYALTY_PROGRAM],
		anyOf: [P.READ_LOYALTY, P.UPDATE_LOYALTY_PROGRAM],
		scope: 'setup',
	},
	{
		id: 'activity',
		key: 'activity',
		path: 'activity',
		permissions: [P.READ_LOYALTY, P.UPDATE_LOYALTY_REDEMPTION],
		anyOf: [P.READ_LOYALTY, P.UPDATE_LOYALTY_REDEMPTION],
		scope: 'read',
	},
] as const

export const LOYALTY_SECTION_REQUIREMENTS: Readonly<
	Record<LoyaltySectionKey, LoyaltySectionDefinition>
> = Object.fromEntries(
	LOYALTY_SECTIONS.map((section) => [section.key, section]),
) as Record<LoyaltySectionKey, LoyaltySectionDefinition>

export function getLoyaltySection(
	key: LoyaltySectionKey,
): LoyaltySectionDefinition {
	const found = LOYALTY_SECTIONS.find((section) => section.key === key)
	if (!found) {
		throw new Error(`Unknown loyalty section: ${key}`)
	}
	return found
}

export function canSeeLoyaltySection(
	section: LoyaltySectionDefinition | LoyaltySectionKey,
	features: LoyaltyFeatures,
	grants: Iterable<string>,
): boolean {
	if (!features.enabled) return false
	const resolved =
		typeof section === 'string' ? getLoyaltySection(section) : section
	const grantList = Array.from(grants)
	return resolved.permissions.some((required) =>
		hasLoyaltyGrant(grantList, required),
	)
}
