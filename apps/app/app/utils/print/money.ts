/** Formats cents in a currency for the Print shop pages. */
export function formatMoney(
	cents: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(cents / 100)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
	}
}
