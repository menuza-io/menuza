import { plural, t } from '@lingui/core/macro'

/**
 * Wording for an alert row in the phone's Alerts tab (#516). The rows are the
 * notifications the web bell shows (inventory and staffing): a kind, a count
 * and a location id, never a name or an amount. The wording is the phone's own,
 * in the viewer's language.
 */
export type AlertPayload = Record<string, unknown>

function countOf(payload: AlertPayload): number {
	const value = Number(payload.count)
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

export function alertCopy(
	type: string,
	payload: AlertPayload,
): { title: string; hint: string } {
	const n = countOf(payload)
	switch (type) {
		case 'inventory-low-stock':
			return {
				title: plural(n, {
					one: '# item is below the level you order at',
					other: '# items are below the level you order at',
				}),
				hint: t`Open Stock to see what is running low.`,
			}
		case 'inventory-count-review':
			return {
				title: plural(n, {
					one: '# count is waiting for review',
					other: '# counts are waiting for review',
				}),
				hint: t`A manager approves it in the web app.`,
			}
		case 'inventory-count-overdue':
			return {
				title: plural(n, {
					one: '# scheduled count was not started',
					other: '# scheduled counts were not started',
				}),
				hint: t`It was due an hour ago. Open Inventory to start it.`,
			}
		case 'inventory-delivery-due':
			return {
				title: plural(n, {
					one: '# order is due for delivery',
					other: '# orders are due for delivery',
				}),
				hint: t`Open Receive a delivery when it arrives.`,
			}
		case 'inventory-price-rise':
			return {
				title: plural(n, {
					one: '# item went up in price',
					other: '# items went up in price',
				}),
				hint: t`See the price changes in the web app.`,
			}
		case 'inventory-repeat-order-draft':
			return {
				title: plural(n, {
					one: '# draft order is ready for review',
					other: '# draft orders are ready for review',
				}),
				hint: t`Review and send it before the cut-off.`,
			}
		case 'inventory-order-approval':
			return {
				title: plural(n, {
					one: '# order needs approval',
					other: '# orders need approval',
				}),
				hint: t`Open Orders to approve and send it.`,
			}
		case 'inventory-sold-out':
			return {
				title: plural(n, {
					one: '# dish is off the menu',
					other: '# dishes are off the menu',
				}),
				hint: t`An ingredient ran out.`,
			}
		case 'inventory-sold-out-back':
			return {
				title: plural(n, {
					one: '# dish is back on the menu',
					other: '# dishes are back on the menu',
				}),
				hint: t`Stock is back.`,
			}
		default:
			if (type.startsWith('staffing-')) {
				return {
					title: t`Something needs your attention in Staff`,
					hint: t`Open the web app to see what changed.`,
				}
			}
			return { title: t`Something needs your attention`, hint: '' }
	}
}
