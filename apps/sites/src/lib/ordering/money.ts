const DOLLAR_CURRENCIES = new Set(['USD', 'CAD'])

/**
 * USD and CAD always render as `$12.00` with en-US digits so prices read the
 * same in every locale (and never pick up CLDR prefixes like `US$`/`CA$`).
 */
export function formatMoney(
	amount: number,
	currency: string = 'USD',
	locale: string = 'en',
): string {
	const value = Number.isFinite(amount) ? amount : 0
	const code = (currency || 'USD').toUpperCase()

	if (DOLLAR_CURRENCIES.has(code)) {
		const sign = value < 0 ? '-' : ''
		const digits = Math.abs(value).toLocaleString('en-US', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})
		return `${sign}$${digits}`
	}

	try {
		return new Intl.NumberFormat(locale || 'en', {
			style: 'currency',
			currency: code,
		}).format(value)
	} catch {
		return `${value.toFixed(2)} ${code}`
	}
}

export type MoneyFormatter = (amount: number) => string

export function createMoneyFormatter(
	currency: string,
	locale: string,
): MoneyFormatter {
	return (amount) => formatMoney(amount, currency, locale)
}

/** Fills `{name}` placeholders in a translated template. */
export function fillTemplate(
	template: string,
	values: Record<string, string | number>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? String(values[key]) : match,
	)
}
