/**
 * Organization RBAC permissions for Inventory. Kept in sync with
 * `ORG_PERMISSIONS` in `@repo/auth`, `packages/database/setup-roles.ts` and the
 * control-plane migration that seeds them.
 */
export const INVENTORY_PERMISSIONS = {
	/** Stock, counts, waste and deliveries, quantities only. */
	READ_INVENTORY: 'read:inventory:any',
	/** Items, storage areas, counting, waste, recording deliveries, prep. */
	UPDATE_INVENTORY: 'update:inventory:any',
	/** Every money figure: costs, values, food cost, waste cost. */
	READ_INVENTORY_COST: 'read:inventory_cost:any',
	/** Suppliers, prices, orders, marking deliveries paid. */
	UPDATE_INVENTORY_PURCHASING: 'update:inventory_purchasing:any',
	/** Recipes, typed dish costs, auto sold out settings. */
	UPDATE_INVENTORY_RECIPE: 'update:inventory_recipe:any',
} as const

export type InventoryPermissionKey = keyof typeof INVENTORY_PERMISSIONS
export type InventoryPermission =
	(typeof INVENTORY_PERMISSIONS)[InventoryPermissionKey]

export const INVENTORY_PERMISSION_LIST: readonly InventoryPermission[] =
	Object.values(INVENTORY_PERMISSIONS)

/** Every `update:*` inventory permission implies reading stock. */
export const INVENTORY_IMPLIED_READ: Readonly<
	Partial<Record<InventoryPermission, InventoryPermission>>
> = {
	[INVENTORY_PERMISSIONS.UPDATE_INVENTORY]:
		INVENTORY_PERMISSIONS.READ_INVENTORY,
	[INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING]:
		INVENTORY_PERMISSIONS.READ_INVENTORY,
	[INVENTORY_PERMISSIONS.UPDATE_INVENTORY_RECIPE]:
		INVENTORY_PERMISSIONS.READ_INVENTORY,
	[INVENTORY_PERMISSIONS.READ_INVENTORY_COST]:
		INVENTORY_PERMISSIONS.READ_INVENTORY,
}

export function isInventoryPermission(
	value: string,
): value is InventoryPermission {
	return (INVENTORY_PERMISSION_LIST as readonly string[]).includes(value)
}

/** Keep inventory permissions only, adding the reads each grant implies. */
export function expandInventoryGrants(
	held: readonly string[],
): InventoryPermission[] {
	const set = new Set<InventoryPermission>()
	for (const grant of held) {
		if (!isInventoryPermission(grant)) continue
		set.add(grant)
		const implied = INVENTORY_IMPLIED_READ[grant]
		if (implied) set.add(implied)
	}
	return INVENTORY_PERMISSION_LIST.filter((perm) => set.has(perm))
}

/** Support impersonation may look but never change anything. */
export function restrictInventoryGrantsForImpersonation(
	grants: readonly InventoryPermission[],
	impersonated: boolean,
): InventoryPermission[] {
	if (!impersonated) return [...grants]
	return grants.filter((grant) => !grant.startsWith('update:'))
}

export function hasInventoryGrant(
	held: readonly string[],
	required: InventoryPermission,
): boolean {
	return expandInventoryGrants(held).includes(required)
}

/** Approving a count posts adjustments in money, so it needs both. */
export function canApproveInventoryCount(held: readonly string[]): boolean {
	const grants = expandInventoryGrants(held)
	return (
		grants.includes(INVENTORY_PERMISSIONS.UPDATE_INVENTORY) &&
		grants.includes(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
	)
}
