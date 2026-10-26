import { type PosOrder } from './db.ts'
import { MAX_ORDER_LINES } from './orders.ts'

/** A table label as people type it: "Table 12", "t12" and " 12 " are the same table. */
export function tableKey(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/^(?:table|tbl|t)\s*[#.:-]?\s*(?=\d)/u, '')
		.replace(/\s+/gu, ' ')
}

/**
 * The open dine-in tab already running for a table, so a second tab is not
 * started for the same guests. Only a tab this order could join counts: same
 * location, taken for the same restaurant (or in demo mode, for the demo), and
 * with no payment yet (a part-paid bill is frozen) and room left for more
 * lines. The tab being edited
 * (`except`) never counts.
 */
export function tabForTable(
	tabs: readonly PosOrder[],
	label: string,
	{
		except = null,
		locationId = null,
		origin = null,
		adding = 1,
	}: {
		except?: string | null
		locationId?: string | null
		origin?: string | null
		/** How many lines joining it would add: the tab must have room for them. */
		adding?: number
	} = {},
): PosOrder | null {
	const key = tableKey(label)
	if (!key) return null
	return (
		tabs.find(
			(tab) =>
				tab.id !== except &&
				tab.status === 'open' &&
				!tab.transferredTo &&
				tab.orderType === 'dine_in' &&
				tab.payments.length === 0 &&
				// A tab without room for what would join it is not offered.
				tab.lines.length + Math.max(1, adding) <= MAX_ORDER_LINES &&
				(locationId === null || tab.locationId === locationId) &&
				(origin === null || (tab.origin ?? origin) === origin) &&
				tableKey(tab.tableLabel) === key,
		) ?? null
	)
}
