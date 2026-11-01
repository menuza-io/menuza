/**
 * The one place that works out how much of a bill is still taxable after its
 * discounts. The till (`computeTotals` in Station), the online engine
 * (`applyOrderDiscounts` in `./restaurant-orders.ts`) and the ZATCA invoice
 * (`fromSale` in `@repo/zatca`) all call it, so the VAT on the bill, the VAT on
 * the receipt and the VAT on the signed invoice cannot drift apart. No imports,
 * no I/O.
 */

export type DiscountBaseLine = {
	/** What the line costs, taxed and untaxed parts together (price times quantity). */
	totalCents: number
	/** The part of `totalCents` that carries tax. */
	taxableCents: number
	/**
	 * What discounts that name this line took off it (the sum over all of them).
	 * Capped at the line's total; absent or not a number counts as nothing.
	 */
	offCents?: number
}

export type DiscountBase = {
	/** What the line-level discounts took off, each capped at its line. */
	lineOffCents: number
	/** The part of `adjustmentCents` that no line claimed. */
	restOffCents: number
	/** The taxable amount that is left, rounded once for the whole bill. */
	taxableAfterCents: number
}

/**
 * Adds up the per-line amounts of several discounts: a map from line id to
 * what all of them took from that line. Amounts that are not positive finite
 * numbers are ignored and fractions are cut off.
 */
export function sumLineAmounts(
	rows: Iterable<{ lineAmounts?: Readonly<Record<string, number>> }>,
): Map<string, number> {
	const perLine = new Map<string, number>()
	for (const row of rows) {
		for (const [lineId, amount] of Object.entries(row.lineAmounts ?? {})) {
			if (Number.isFinite(amount) && amount > 0)
				perLine.set(lineId, (perLine.get(lineId) ?? 0) + Math.trunc(amount))
		}
	}
	return perLine
}

/**
 * Taxable amount left after discounts. A discount that says which line took
 * what shrinks that line's taxable amount: the taxed and untaxed parts of the
 * line lose it in proportion, and a discount on a line with nothing taxable
 * never lowers the tax (a 10% discount on a 1000 line with 100 taxable leaves
 * 90 taxable). Whatever part of `adjustmentCents` no line claimed (a loyalty
 * reward, a sale loaded from another terminal) shrinks what is left in
 * proportion to the rest of the bill. Without `adjustmentCents` the discount is
 * exactly what the lines took.
 */
export function discountedTaxableCents(input: {
	lines: readonly DiscountBaseLine[]
	/** The bill's whole discount (already capped at its subtotal). */
	adjustmentCents?: number
}): DiscountBase {
	let subtotalCents = 0
	const offs = input.lines.map((line) => {
		const total = wholeCents(line.totalCents)
		subtotalCents += total
		return Math.min(wholeCents(line.offCents ?? 0), total)
	})
	const claimedCents = offs.reduce((sum, off) => sum + off, 0)
	const adjustmentCents =
		input.adjustmentCents === undefined
			? claimedCents
			: wholeCents(input.adjustmentCents)
	// When the lines claim more than the bill's discount, they keep only that
	// much, split over them in proportion, and the taxable amount shrinks by
	// what they keep, not by what they claimed.
	const kept =
		claimedCents > adjustmentCents
			? splitInProportion(adjustmentCents, offs)
			: offs
	const lineOffCents = Math.min(claimedCents, adjustmentCents)
	let taxableCents = 0
	input.lines.forEach((line, index) => {
		const total = wholeCents(line.totalCents)
		const taxable = Math.min(wholeCents(line.taxableCents), total)
		const off = kept[index]!
		taxableCents +=
			total > 0 ? taxable - mulDivHalfUp(off, taxable, total) : taxable
	})
	const restCents = subtotalCents - lineOffCents
	const restOffCents = Math.max(0, adjustmentCents - lineOffCents)
	const taxableAfterCents =
		restCents > 0
			? mulDivHalfUp(
					taxableCents,
					Math.max(0, restCents - restOffCents),
					restCents,
				)
			: 0
	return { lineOffCents, restOffCents, taxableAfterCents }
}

/** A whole, non-negative number of cents; anything else counts as nothing. */
function wholeCents(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/** `a * b / c` rounded half up, exactly (no float error at the half). */
function mulDivHalfUp(a: number, b: number, c: number): number {
	const numerator = BigInt(a) * BigInt(b)
	const divisor = BigInt(c)
	let quotient = numerator / divisor
	if ((numerator % divisor) * 2n >= divisor) quotient += 1n
	return Number(quotient)
}

/**
 * `total` split over `weights` in proportion by largest remainder, ties to
 * the earlier entry. Assumes `total` is no more than the sum of the weights.
 */
function splitInProportion(
	total: number,
	weights: readonly number[],
): number[] {
	const sum = weights.reduce((acc, weight) => acc + weight, 0)
	if (sum === 0) return weights.map(() => 0)
	const parts = weights.map((weight) => {
		const numerator = BigInt(total) * BigInt(weight)
		return {
			floor: Number(numerator / BigInt(sum)),
			remainder: numerator % BigInt(sum),
		}
	})
	const result = parts.map((part) => part.floor)
	let left = total - result.reduce((acc, value) => acc + value, 0)
	const order = parts
		.map((part, index) => ({ index, remainder: part.remainder }))
		.sort((a, b) =>
			a.remainder === b.remainder
				? a.index - b.index
				: a.remainder > b.remainder
					? -1
					: 1,
		)
	for (const { index } of order) {
		if (left <= 0) break
		result[index]! += 1
		left -= 1
	}
	return result
}
