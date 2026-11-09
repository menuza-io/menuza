import { type SaleLine, type SaleOption } from './types.ts'

function positiveInt(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: 0
}

function idOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

function toArray(raw: unknown): unknown[] {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	return Array.isArray(value) ? value : []
}

/**
 * Reads the stored lines of a web or QR order (`PricedOrderLine[]`, where an
 * option can carry a pizza `half`) or a Station sale (`PosOrderLine[]`)
 * defensively into engine lines: an entry without an item id or a positive
 * quantity is skipped. Option quantities stay PER DISH here (a line of three
 * with option quantity two takes two per dish), unlike `parseSoldLines` in
 * tenant-api's item-sales reader, which multiplies them for sales counts. Feed
 * the raw stored JSON, not that reader's output.
 */
export function parseSaleLines(
	raw: unknown,
	kind: 'restaurant' | 'pos',
): SaleLine[] {
	const lines: SaleLine[] = []
	for (const entry of toArray(raw)) {
		if (!entry || typeof entry !== 'object') continue
		const line = entry as Record<string, unknown>
		const itemId = idOrNull(line.itemId)
		const quantity = positiveInt(line.quantity)
		if (!itemId || quantity === 0) continue
		const options: SaleOption[] = []
		for (const optionEntry of Array.isArray(line.options) ? line.options : []) {
			if (!optionEntry || typeof optionEntry !== 'object') continue
			const option = optionEntry as Record<string, unknown>
			const optionId = idOrNull(option.optionId)
			const optionQuantity = positiveInt(option.quantity)
			if (!optionId || optionQuantity === 0) continue
			const half =
				kind === 'restaurant' &&
				(option.half === 'left' || option.half === 'right')
					? option.half
					: null
			options.push({ optionId, quantity: optionQuantity, half })
		}
		lines.push({
			itemId,
			variantId: idOrNull(line.variantId),
			quantity,
			options,
		})
	}
	return lines
}
