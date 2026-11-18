/**
 * Item-pair counting for combination reports (#369). Pure: no I/O.
 * Each sale contributes one count per distinct unordered item pair on the bill.
 */

export type SaleLineForPairs = {
	itemId: string
	quantity: number
}

/** Distinct positive item ids on a sale (variant ignored; one line per dish). */
export function distinctItemIds(lines: readonly SaleLineForPairs[]): string[] {
	const seen = new Set<string>()
	for (const line of lines) {
		if (line.quantity > 0 && line.itemId) seen.add(line.itemId)
	}
	return [...seen].sort()
}

/** Canonical key for an unordered pair (ids sorted, joined). */
export function itemPairKey(itemAId: string, itemBId: string): string {
	return itemAId < itemBId ? `${itemAId}\0${itemBId}` : `${itemBId}\0${itemAId}`
}

export type ItemPairCount = {
	itemAId: string
	itemBId: string
	pairKey: string
	orderCount: number
}

/**
 * Counts how many sales contained each unordered item pair. A sale with one
 * dish contributes no pair; two dishes one pair; n dishes n*(n-1)/2 pairs.
 */
export function countItemPairs(
	sales: ReadonlyArray<{ lines: readonly SaleLineForPairs[] }>,
): ItemPairCount[] {
	const totals = new Map<string, ItemPairCount>()
	for (const sale of sales) {
		const ids = distinctItemIds(sale.lines)
		if (ids.length < 2) continue
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				const itemAId = ids[i]!
				const itemBId = ids[j]!
				const key = itemPairKey(itemAId, itemBId)
				const row = totals.get(key) ?? {
					itemAId,
					itemBId,
					pairKey: key,
					orderCount: 0,
				}
				row.orderCount += 1
				totals.set(key, row)
			}
		}
	}
	return [...totals.values()].sort(
		(a, b) => b.orderCount - a.orderCount || a.pairKey.localeCompare(b.pairKey),
	)
}

/** Share of sales that included this pair (0–1). */
export function pairShareOfOrders(
	pairOrderCount: number,
	totalOrdersWithPairs: number,
): number {
	if (totalOrdersWithPairs <= 0) return 0
	return pairOrderCount / totalOrdersWithPairs
}
