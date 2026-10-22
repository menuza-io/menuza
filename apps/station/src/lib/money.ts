const DOLLAR_CURRENCIES = new Set(['USD', 'CAD'])

export const toCents = (amount: number): number => Math.round(amount * 100)

/** Mirrors apps/sites: USD/CAD always render as `$12.00`. */
export function formatMoney(cents: number, currency = 'USD'): string {
	const value = (Number.isFinite(cents) ? cents : 0) / 100
	const code = currency.toUpperCase()
	if (DOLLAR_CURRENCIES.has(code)) {
		const sign = value < 0 ? '-' : ''
		return `${sign}$${Math.abs(value).toLocaleString('en-US', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`
	}
	try {
		return new Intl.NumberFormat('en', {
			style: 'currency',
			currency: code,
		}).format(value)
	} catch {
		return `${value.toFixed(2)} ${code}`
	}
}

export type MoneyFormatter = (cents: number) => string
export const moneyFormatter =
	(currency: string): MoneyFormatter =>
	(cents) =>
		formatMoney(cents, currency)
