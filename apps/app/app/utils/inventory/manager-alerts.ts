import {
	INVENTORY_ALL_NOTIFY_KINDS,
	INVENTORY_PERMISSION_LIST,
	INVENTORY_PERMISSIONS,
	type InventoryNotifyKind,
	type InventoryPermission,
} from '@repo/inventory'

/**
 * Manager alerts raised by the regional inventory tick. The wire contract
 * (`inventoryNotifyEventSchema`, `inventoryNotifyResultSchema`) lives in
 * `@repo/inventory`; this file holds what the App does with an event: the
 * notification vocabulary, who may be told, where an alert leads and the
 * plain-English email copy. An alert is a kind, a location id and a count:
 * no item name, supplier or amount ever crosses.
 */

export {
	INVENTORY_ALL_NOTIFY_KINDS as INVENTORY_ALERT_KINDS,
	type InventoryNotifyKind as InventoryAlertKind,
}

/** Dishes taken off the menu by stock, and given back (#478). */
export function isSoldOutAlertKind(
	kind: InventoryNotifyKind,
): kind is 'inventory_sold_out' | 'inventory_sold_out_back' {
	return kind === 'inventory_sold_out' || kind === 'inventory_sold_out_back'
}

const KIND_PREFIX = 'inventory_'

export function inventoryAlertWorkflow(kind: InventoryNotifyKind) {
	// Going off the menu and coming back are one setting.
	if (kind === 'inventory_sold_out_back') return 'inventory.sold_out' as const
	return `inventory.${kind.slice(KIND_PREFIX.length)}` as const
}

export const INVENTORY_ALERT_WORKFLOWS = [
	'inventory.low_stock',
	'inventory.count_review',
	'inventory.delivery_due',
	'inventory.price_rise',
	'inventory.sold_out',
] as const satisfies readonly ReturnType<typeof inventoryAlertWorkflow>[]

export function isInventoryAlertWorkflow(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		(INVENTORY_ALERT_WORKFLOWS as readonly string[]).includes(value)
	)
}

export const INVENTORY_ALERT_TYPE_PREFIX = 'inventory-'

/**
 * Written for members who chose email only, so a retried delivery does not
 * email them twice. Already read and seen, and never listed.
 */
export const INVENTORY_ALERT_MARKER_TYPE = 'inventory-email-sent'

export function inventoryAlertNotificationType(kind: InventoryNotifyKind) {
	return `${INVENTORY_ALERT_TYPE_PREFIX}${kind
		.slice(KIND_PREFIX.length)
		.replaceAll('_', '-')}` as const
}

export function inventoryAlertKindFromNotificationType(
	type: unknown,
): InventoryNotifyKind | null {
	if (typeof type !== 'string') return null
	return (
		INVENTORY_ALL_NOTIFY_KINDS.find(
			(kind) => inventoryAlertNotificationType(kind) === type,
		) ?? null
	)
}

/**
 * Kinds that carry money, so only members with `read:inventory_cost:any` are
 * told. The wire contract's comment says the cost grant is not needed ("counts
 * only"); a price rise is about prices, so it is gated here. One place to
 * change.
 */
export const INVENTORY_COST_BEARING_KINDS: readonly InventoryNotifyKind[] = [
	'inventory_price_rise',
]

export function isCostBearingInventoryAlert(kind: InventoryNotifyKind) {
	return INVENTORY_COST_BEARING_KINDS.includes(kind)
}

/** Every inventory grant reads stock (the update and cost grants imply it). */
export const INVENTORY_ALERT_GRANTS: readonly InventoryPermission[] =
	INVENTORY_PERMISSION_LIST

/** Whether a member holding `held` (already expanded or not) may hear `kind`. */
export function inventoryAlertAllowedFor(
	kind: InventoryNotifyKind,
	held: ReadonlySet<string>,
): boolean {
	if (!INVENTORY_ALERT_GRANTS.some((grant) => held.has(grant))) return false
	return (
		!isCostBearingInventoryAlert(kind) ||
		held.has(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
	)
}

export function inventoryAlertPath(kind: InventoryNotifyKind): string {
	switch (kind) {
		case 'inventory_low_stock':
			return '/inventory/stock?low=1'
		case 'inventory_count_review':
			return '/inventory/counts'
		case 'inventory_delivery_due':
		case 'inventory_price_rise':
			return '/inventory/purchasing'
		case 'inventory_sold_out':
		case 'inventory_sold_out_back':
			// The "Off the menu" panel on Today, where a manager can undo it.
			return '/inventory/today#sold-out'
	}
}

export type InventoryAlertCopy = {
	eyebrow: string
	subject: string
	headline: string
	detail: string
	actionLabel: string
}

function items(count: number): string {
	return count === 1 ? '1 item' : `${count} items`
}

/** Dish names as a sentence: "Burger", "Burger and Wrap", "Burger, Wrap and 2 more". */
function nameList(names: readonly string[], total: number): string {
	const shown = names.slice(0, 3)
	const extra = Math.max(0, total - shown.length)
	if (extra > 0) return `${shown.join(', ')} and ${extra} more`
	if (shown.length <= 1) return shown[0] ?? ''
	return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** Plain English for the email. The in-app copy is translated in the bell. */
export function describeInventoryAlert(input: {
	kind: InventoryNotifyKind
	count: number
	locationName: string | null
	/** Sold-out kinds: the dishes and the ingredients that ran out. */
	dishes?: readonly string[]
	ingredients?: readonly string[]
}): InventoryAlertCopy {
	const { kind, count } = input
	const place = input.locationName ? ` at ${input.locationName}` : ''
	switch (kind) {
		case 'inventory_sold_out':
		case 'inventory_sold_out_back': {
			const dishes = nameList(input.dishes ?? [], count) || 'A dish'
			const ingredient = nameList(
				[...new Set(input.ingredients ?? [])],
				new Set(input.ingredients ?? []).size,
			)
			const off = kind === 'inventory_sold_out'
			const verb = count === 1 ? 'is' : 'are'
			const headline = off
				? `${dishes} ${verb} off the menu${place}`
				: `${dishes} ${verb} back on the menu${place}`
			return {
				eyebrow: 'Inventory',
				subject: headline,
				headline,
				detail: off
					? `${ingredient || 'An ingredient'} ran out${place}, so ${count === 1 ? 'this dish was' : 'these dishes were'} taken off the menu. If stock is not really out, undo it from Today.`
					: `${ingredient || 'The ingredient'} is back in stock${place}, so ${count === 1 ? 'this dish was' : 'these dishes were'} put back on the menu.`,
				actionLabel: off ? 'See and undo' : 'Open Today',
			}
		}
		case 'inventory_low_stock': {
			const headline = `${items(count)} ${count === 1 ? 'is' : 'are'} below the level you order at`
			return {
				eyebrow: 'Inventory',
				subject: `${headline}${place}`,
				headline,
				detail: `${items(count)}${place} ${count === 1 ? 'has' : 'have'} dropped below the amount you set to order more at. Open Stock to see which.`,
				actionLabel: 'See low items',
			}
		}
		case 'inventory_count_review': {
			const headline =
				count === 1
					? 'A count is waiting for review'
					: `${count} counts are waiting for review`
			return {
				eyebrow: 'Counts',
				subject: `${headline}${place}`,
				headline,
				detail: `${count === 1 ? 'A count needs' : `${count} counts need`} your approval${place} before stock is adjusted.`,
				actionLabel: 'Review counts',
			}
		}
		case 'inventory_delivery_due': {
			const headline =
				count === 1
					? 'An order is due for delivery'
					: `${count} orders are due for delivery`
			return {
				eyebrow: 'Purchasing',
				subject: `${headline}${place}`,
				headline,
				detail: `${count === 1 ? 'An order is' : `${count} orders are`} due today or overdue${place}. Receive ${count === 1 ? 'it' : 'them'} when ${count === 1 ? 'it arrives' : 'they arrive'}.`,
				actionLabel: 'Open purchasing',
			}
		}
		case 'inventory_price_rise': {
			const headline =
				count === 1
					? 'An item went up in price'
					: `${count} items went up in price`
			return {
				eyebrow: 'Purchasing',
				subject: `${headline}${place}`,
				headline,
				detail: `${items(count)} cost more than ${count === 1 ? 'it' : 'they'} did on the delivery before${place}. Open purchasing to see which.`,
				actionLabel: 'See price changes',
			}
		}
	}
}
