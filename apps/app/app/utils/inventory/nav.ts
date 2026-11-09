import {
	type InventoryFeatures,
	INVENTORY_PERMISSIONS,
	type InventoryPermission,
} from '@repo/inventory'

/** The five Inventory tabs, in tab bar and sidebar order. */
export const INVENTORY_TABS = [
	'today',
	'stock',
	'counts',
	'purchasing',
	'waste',
] as const
export type InventoryTab = (typeof INVENTORY_TABS)[number]

/** Which links of the sidebar "Inventory" group the current member should see. */
export type InventoryNavAccess = {
	visible: boolean
} & Record<InventoryTab, boolean>

export const HIDDEN_INVENTORY_NAV: InventoryNavAccess = {
	visible: false,
	today: false,
	stock: false,
	counts: false,
	purchasing: false,
	waste: false,
}

/**
 * Every tab needs the `inventory.enabled` flag and `read:inventory:any`
 * (every other inventory grant implies it once expanded). Purchasing opens
 * with the master flag too: deliveries and suppliers come with it, and
 * `inventory.purchasing` only adds suggested orders inside the tab.
 */
export function computeInventoryNavAccess(
	features: InventoryFeatures,
	grants: ReadonlySet<string> | readonly InventoryPermission[],
): InventoryNavAccess {
	if (!features.enabled) return HIDDEN_INVENTORY_NAV
	const held: ReadonlySet<string> =
		grants instanceof Set ? grants : new Set<string>(grants)
	if (!held.has(INVENTORY_PERMISSIONS.READ_INVENTORY)) {
		return HIDDEN_INVENTORY_NAV
	}
	return {
		visible: true,
		today: true,
		stock: true,
		counts: true,
		purchasing: true,
		waste: true,
	}
}

export function inventoryTabPath(orgSlug: string, tab: InventoryTab): string {
	return `/${orgSlug}/inventory/${tab}`
}

/** The tab a path is on, or `null` outside the five tabs. */
export function inventoryTabFromPath(
	pathname: string,
	orgSlug: string,
): InventoryTab | null {
	const base = `/${orgSlug}/inventory/`
	if (!pathname.startsWith(base)) return null
	const segment = pathname.slice(base.length).split('/')[0]
	return (INVENTORY_TABS as readonly string[]).includes(segment ?? '')
		? (segment as InventoryTab)
		: null
}

/**
 * Pages that take the whole screen instead of the Inventory header and tab
 * bar: counting a count (`/counts/<id>`), its review (`/counts/<id>/review`)
 * recording a delivery (`/purchasing/deliveries/new`) and reviewing an order
 * (`/purchasing/orders/<id>`). They carry their own sticky header, like the
 * menu editors.
 */
export function isInventoryFullPage(
	pathname: string,
	orgSlug: string,
): boolean {
	const base = `/${orgSlug}/inventory/`
	if (!pathname.startsWith(base)) return false
	const parts = pathname
		.slice(base.length)
		.split('/')
		.filter((part) => part !== '')
	if (parts[0] === 'counts' && parts.length >= 2 && parts.length <= 3) {
		return parts.length === 2 || parts[2] === 'review'
	}
	return (
		parts[0] === 'purchasing' &&
		parts.length === 3 &&
		((parts[1] === 'deliveries' && parts[2] === 'new') || parts[1] === 'orders')
	)
}

export function inventoryCountPath(orgSlug: string, countId: string): string {
	return `/${orgSlug}/inventory/counts/${encodeURIComponent(countId)}`
}

export function inventoryCountReviewPath(
	orgSlug: string,
	countId: string,
): string {
	return `${inventoryCountPath(orgSlug, countId)}/review`
}

export function inventoryOrderPath(orgSlug: string, orderId: string): string {
	return `/${orgSlug}/inventory/purchasing/orders/${encodeURIComponent(orderId)}`
}

/** Receive a delivery against an open order. */
export function inventoryReceivePath(orgSlug: string, orderId: string): string {
	return `/${orgSlug}/inventory/purchasing/deliveries/new?orderId=${encodeURIComponent(orderId)}`
}
