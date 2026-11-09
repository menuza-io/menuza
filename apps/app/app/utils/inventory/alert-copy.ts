import { msg, plural } from '@lingui/macro'
import { type InventoryNotifyKind } from '@repo/inventory'

type Translate = (message: any) => string
type Message = { id: string; message: string }

/**
 * Wording for an inventory alert in the notification bell. The notification
 * carries a kind, a count and at most a location name, so that is all it can
 * say; the details are read in Inventory after opening it.
 */
export function inventoryAlertCopy(
	kind: InventoryNotifyKind,
	count: number,
	_: Translate,
	locationName?: string | null,
): { subject: string; body: string } {
	const n = Math.max(1, Math.floor(count) || 1)
	const { subject, step } = describe(kind, n, _)
	const body = locationName
		? `${step}\n\n${_(msg`Location: ${locationName}` as Message)}`
		: step
	return { subject, body }
}

function describe(kind: InventoryNotifyKind, n: number, _: Translate) {
	switch (kind) {
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
	}
}
