/**
 * Modifier attach-rate stats for reports (#369). Pure: no I/O.
 */

export type ModifierLine = {
	optionId: string
	parentItemId: string
	quantity: number
	salesMinor: number
}

export type ModifierAttachRow = {
	optionId: string
	parentItemId: string
	attachCount: number
	parentItemCount: number
	attachRate: number
	salesMinor: number
}

/**
 * attachRate = sales with this option on this item / sales with this item.
 * Options with zero parent sales are omitted.
 */
export function computeModifierAttach(
	sales: ReadonlyArray<{
		lines: ReadonlyArray<{
			itemId: string
			quantity: number
			options: ReadonlyArray<{
				optionId: string
				quantity: number
				salesMinor: number
			}>
		}>
	}>,
): ModifierAttachRow[] {
	const parentCounts = new Map<string, number>()
	const attach = new Map<string, ModifierAttachRow>()

	for (const sale of sales) {
		const itemsThisSale = new Set<string>()
		for (const line of sale.lines) {
			if (line.quantity <= 0 || !line.itemId) continue
			itemsThisSale.add(line.itemId)
		}
		for (const itemId of itemsThisSale) {
			parentCounts.set(itemId, (parentCounts.get(itemId) ?? 0) + 1)
		}
		for (const line of sale.lines) {
			if (line.quantity <= 0 || !line.itemId) continue
			for (const option of line.options) {
				if (option.quantity <= 0 || !option.optionId) continue
				const key = `${line.itemId}\0${option.optionId}`
				const row = attach.get(key) ?? {
					optionId: option.optionId,
					parentItemId: line.itemId,
					attachCount: 0,
					parentItemCount: 0,
					attachRate: 0,
					salesMinor: 0,
				}
				row.attachCount += 1
				row.salesMinor += option.salesMinor
				attach.set(key, row)
			}
		}
	}

	const rows: ModifierAttachRow[] = []
	for (const row of attach.values()) {
		const parents = parentCounts.get(row.parentItemId) ?? 0
		if (parents === 0) continue
		rows.push({
			...row,
			parentItemCount: parents,
			attachRate: row.attachCount / parents,
		})
	}
	return rows.sort(
		(a, b) =>
			b.attachRate - a.attachRate ||
			a.parentItemId.localeCompare(b.parentItemId) ||
			a.optionId.localeCompare(b.optionId),
	)
}
