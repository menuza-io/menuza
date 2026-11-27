import { msg, plural } from '@lingui/macro'
import { type InventoryNotifyKind } from '@repo/inventory'

type Translate = (message: any) => string
type Message = { id: string; message: string }

/**
 * Wording for an inventory alert in the notification bell. The notification
 * carries a kind, a count and at most a location name, so that is all it can
 * say; the details are read in Inventory after opening it.
 */
export type SoldOutDetails = { dishes: string[]; ingredients: string[] }

export function inventoryAlertCopy(
	kind: InventoryNotifyKind,
	count: number,
	_: Translate,
	locationName?: string | null,
	details?: SoldOutDetails | null,
): { subject: string; body: string } {
	const n = Math.max(1, Math.floor(count) || 1)
	const { subject, step } = describe(kind, n, _, details ?? null)
	const body = locationName
		? `${step}\n\n${_(msg`Location: ${locationName}` as Message)}`
		: step
	return { subject, body }
}

function soldOutCopy(
	back: boolean,
	n: number,
	_: Translate,
	details: SoldOutDetails | null,
) {
	const dish = n === 1 ? details?.dishes[0] : undefined
	const ingredient = details?.ingredients[0]
	const subject = dish
		? back
			? _(msg`${dish} is back on the menu` as Message)
			: _(msg`${dish} is off the menu` as Message)
		: back
			? _(
					plural(n, {
						one: '# dish is back on the menu',
						other: '# dishes are back on the menu',
					}),
				)
			: _(
					plural(n, {
						one: '# dish is off the menu',
						other: '# dishes are off the menu',
					}),
				)
	const step = ingredient
		? back
			? _(msg`${ingredient} is back in stock.` as Message)
			: _(
					msg`${ingredient} ran out. Open Today to see what is off the menu and undo it.` as Message,
				)
		: back
			? _(msg`Stock is back.` as Message)
			: _(msg`An ingredient ran out. Open Today to undo it.` as Message)
	return { subject, step }
}

function describe(
	kind: InventoryNotifyKind,
	n: number,
	_: Translate,
	details: SoldOutDetails | null,
) {
	switch (kind) {
		case 'inventory_sold_out':
			return soldOutCopy(false, n, _, details)
		case 'inventory_sold_out_back':
			return soldOutCopy(true, n, _, details)
		case 'inventory_low_stock':
			return {
				subject: _(
					plural(n, {
						one: '# item is below the level you order at',
						other: '# items are below the level you order at',
					}),
				),
				step: _(msg`Open Stock to see what is running low.` as Message),
			}
		case 'inventory_count_review':
			return {
				subject: _(
					plural(n, {
						one: '# count is waiting for review',
						other: '# counts are waiting for review',
					}),
				),
				step: _(msg`Open Counts to review and approve.` as Message),
			}
		case 'inventory_count_overdue':
			return {
				subject: _(
					plural(n, {
						one: '# scheduled count was not started',
						other: '# scheduled counts were not started',
					}),
				),
				step: _(
					msg`It was due an hour ago. Open Today to see who is responsible.` as Message,
				),
			}
		case 'inventory_delivery_due':
			return {
				subject: _(
					plural(n, {
						one: '# order is due for delivery',
						other: '# orders are due for delivery',
					}),
				),
				step: _(msg`Open Purchasing to receive the delivery.` as Message),
			}
		case 'inventory_price_rise':
			return {
				subject: _(
					plural(n, {
						one: '# item went up in price',
						other: '# items went up in price',
					}),
				),
				step: _(msg`Open Purchasing to see the price changes.` as Message),
			}
		case 'inventory_repeat_order_draft':
			return {
				subject: _(
					plural(n, {
						one: '# draft order is ready for review',
						other: '# draft orders are ready for review',
					}),
				),
				step: _(
					msg`Open Purchasing to review and send before cut-off.` as Message,
				),
			}
		case 'inventory_routine':
			return {
				subject: _(msg`A routine has something for you` as Message),
				step: _(
					msg`Open Routines to read the summary and see what it drafted.` as Message,
				),
			}
		case 'inventory_order_approval':
			return {
				subject: _(
					plural(n, {
						one: '# order needs approval',
						other: '# orders need approval',
					}),
				),
				step: _(
					msg`Open Purchasing to approve or reject the order.` as Message,
				),
			}
	}
}
