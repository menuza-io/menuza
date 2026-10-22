/**
 * Display-only tax estimate for the cart and checkout. The regional tenant-api
 * re-prices every order (`priceRestaurantOrder` in `@repo/common`), and the
 * receipt is authoritative.
 *
 * `ratePercent` is a percent (e.g. `8.25`), never a fraction. When the
 * location's prices include tax (`taxInclusive`, VAT in Saudi Arabia, the EU
 * and the UK) the tax is the portion already contained in `amount` and is not
 * added to the total.
 */
export function estimateTax(
	amount: number,
	ratePercent: number,
	inclusive: boolean,
): { tax: number; added: number } {
	const rate = Math.max(0, Math.min(100, ratePercent || 0))
	if (!(amount > 0) || !(rate > 0)) return { tax: 0, added: 0 }
	if (inclusive) return { tax: (amount * rate) / (100 + rate), added: 0 }
	const tax = (amount * rate) / 100
	return { tax, added: tax }
}
