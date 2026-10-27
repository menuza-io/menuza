/**
 * Print shop money rules (integer cents). Retail is the live vendor
 * wholesale price times the markup, rounded up to a whole cent; shipping is
 * passed through at cost. A paid order is re-quoted before it goes to the
 * vendor: a rise above the drift limit holds it for Admin.
 */

export function retailCents(wholesaleCents: number, markupBp: number): number {
	if (!Number.isInteger(wholesaleCents) || wholesaleCents < 0) {
		throw new Error('Invalid wholesale amount')
	}
	return Math.ceil((wholesaleCents * (10_000 + Math.max(0, markupBp))) / 10_000)
}

/** True when the new wholesale total is more than `driftBp` above the locked one. */
export function exceedsDrift(
	lockedWholesaleCents: number,
	currentWholesaleCents: number,
	driftBp: number,
): boolean {
	return (
		currentWholesaleCents * 10_000 >
		lockedWholesaleCents * (10_000 + Math.max(0, driftBp))
	)
}

/** Spreads an order's retail item total over its lines (for display only). */
export function lineRetailCents(
	lineWholesale: number[],
	markupBp: number,
): number[] {
	return lineWholesale.map((cents) => retailCents(cents, markupBp))
}
