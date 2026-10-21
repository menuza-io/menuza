import { latinDigits } from './time.ts'

/**
 * Formats integer minor units in the given currency. The divisor comes from the
 * currency's own exponent (USD 2, JPY 0, KWD 3), never a hard-coded 100.
 */
export function formatMinor(
	amountMinor: number,
	currency: string,
	locale: string,
): string {
	const code = (currency || 'USD').toUpperCase()
	try {
		const formatter = new Intl.NumberFormat(latinDigits(locale), {
			style: 'currency',
			currency: code,
		})
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
		return formatter.format(amountMinor / 10 ** digits)
	} catch {
		return `${amountMinor} ${code}`
	}
}
