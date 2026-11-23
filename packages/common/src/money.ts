/**
 * Currency exponent and minor/major conversion helpers shared across UI and API.
 */

const exponentCache = new Map<string, number>()

/**
 * Decimal places of a currency's minor unit as `Intl` knows it: 2 for USD
 * and SAR, 3 for KWD/BHD/OMR, 0 for JPY. Unknown or missing codes count as 2.
 */
export function currencyExponent(currency?: string | null): number {
	const code = currency?.trim().toUpperCase() ?? ''
	if (!code) return 2
	const cached = exponentCache.get(code)
	if (cached !== undefined) return cached
	let exponent = 2
	try {
		exponent =
			new Intl.NumberFormat('en', {
				style: 'currency',
				currency: code,
			}).resolvedOptions().maximumFractionDigits ?? 2
	} catch {
		exponent = 2
	}
	exponentCache.set(code, exponent)
	return exponent
}

/** Integer minor units as major units: `1550, 'USD'` → 15.5, `1550, 'KWD'` → 1.55. */
export function minorToMajor(minor: number, currency?: string | null): number {
	return minor / 10 ** currencyExponent(currency)
}

/** Minor units as the plain decimal string: `1550, 'USD'` → "15.50", `1550, 'KWD'` → "1.550". */
export function minorToMajorText(
	minor: number,
	currency?: string | null,
): string {
	return minorToMajor(minor, currency).toFixed(currencyExponent(currency))
}
