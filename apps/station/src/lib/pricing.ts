/**
 * Local, offline pricing. Follows the same cent arithmetic as the regional
 * engine in `@repo/common/restaurant-orders` (base price always taxable, an
 * option taxable unless `applySalesTax === false`, tax and tip rounded once on
 * the order). The server reprices every synced order and its figures win;
 * these exist so the cashier sees a total with no network.
 */
export type CartOption = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	quantity: number
	/** Cents for one unit of this option. */
	unitCents: number
	taxable: boolean
}

export type CartLine = {
	/** Local line id; never sent to the server. */
	id: string
	itemId: string
	name: string
	variantId: string | null
	variantLabel: string | null
	quantity: number
	baseCents: number
	instructions: string
	options: CartOption[]
}

/**
 * Reserved for discounts and loyalty. Today nothing creates one, but totals,
 * stored orders and receipts already carry the list so adding a discount later
 * is a new producer, not a schema change. `amountCents` is positive and is
 * subtracted before tax.
 */
export type Adjustment = {
	id: string
	kind: 'discount' | 'loyalty'
	label: string
	amountCents: number
}

export type Totals = {
	subtotalCents: number
	adjustmentCents: number
	taxCents: number
	tipCents: number
	totalCents: number
}

export const lineUnitCents = (line: CartLine): number =>
	line.baseCents +
	line.options.reduce((sum, o) => sum + o.unitCents * o.quantity, 0)

export const lineTotalCents = (line: CartLine): number =>
	lineUnitCents(line) * line.quantity

const lineTaxableCents = (line: CartLine): number =>
	(line.baseCents +
		line.options.reduce(
			(sum, o) => sum + (o.taxable ? o.unitCents * o.quantity : 0),
			0,
		)) *
	line.quantity

export function computeTotals(input: {
	lines: CartLine[]
	taxRatePercent: number
	/** Prices already include the tax: it is shown, not added. */
	taxInclusive?: boolean
	tipPercent?: number
	tipCents?: number
	adjustments?: Adjustment[]
}): Totals {
	const subtotalCents = input.lines.reduce((s, l) => s + lineTotalCents(l), 0)
	const taxableCents = input.lines.reduce((s, l) => s + lineTaxableCents(l), 0)
	const adjustmentCents = Math.min(
		subtotalCents,
		(input.adjustments ?? []).reduce((s, a) => s + a.amountCents, 0),
	)
	// Adjustments shrink the taxable base in proportion to the subtotal.
	const taxBase =
		subtotalCents > 0
			? Math.round(taxableCents * (1 - adjustmentCents / subtotalCents))
			: 0
	const rate = Math.max(0, Math.min(100, input.taxRatePercent || 0))
	const inclusive = input.taxInclusive === true
	// Inclusive: the part of the price that is tax, as the engine computes it.
	const taxCents = inclusive
		? Math.round((taxBase * rate) / (100 + rate))
		: Math.round((taxBase * rate) / 100)
	const tipCents =
		input.tipCents ??
		Math.round(
			((subtotalCents - adjustmentCents) * (input.tipPercent ?? 0)) / 100,
		)
	return {
		subtotalCents,
		adjustmentCents,
		taxCents,
		tipCents,
		totalCents:
			subtotalCents - adjustmentCents + (inclusive ? 0 : taxCents) + tipCents,
	}
}

/** Lines that are identical (same item, variant, options, note) merge. */
export const lineSignature = (
	line: Omit<CartLine, 'id' | 'quantity'>,
): string =>
	JSON.stringify([
		line.itemId,
		line.variantId,
		line.instructions.trim(),
		line.options
			.map((o) => [o.groupId, o.optionId, o.quantity])
			.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
	])
