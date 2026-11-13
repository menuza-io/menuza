import { i18n } from '@lingui/core'

const DOLLAR_CURRENCIES = new Set(['USD', 'CAD'])

/** First-strong isolate and pop: the text equivalent of `<bdi>`. */
const FSI = '⁨'
const PDI = '⁩'

export const toCents = (amount: number): number => Math.round(amount * 100)

/**
 * Accepts 10.5, 10,5, Arabic-Indic digits and the Arabic decimal separator
 * (U+066B, `٫`; its thousands separator U+066C is ignored). Null when it is not
 * a number.
 */
export function parseDecimal(raw: string): number | null {
	const normalized = raw
		.trim()
		.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
		.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
		.replace(/\u066C/g, '')
		.replace(/[\u066B,]/, '.')
	if (!/^\d+(\.\d+)?$/.test(normalized)) return null
	const value = Number(normalized)
	return Number.isFinite(value) ? value : null
}

const isRtl = (locale: string) => /^(ar|fa|he|ur)\b/i.test(locale)

/**
 * An amount in the till's language. English mirrors apps/sites (USD/CAD always
 * render as `$12.00`); Arabic uses its own digits and currency sign. In a
 * right-to-left interface the amount is isolated (as `<bdi>` would), so its
 * sign, digits and currency keep their order inside a sentence.
 */
export function formatMoney(
	cents: number,
	currency = 'USD',
	locale: string = i18n.locale || 'en',
): string {
	const value = (Number.isFinite(cents) ? cents : 0) / 100
	const code = currency.toUpperCase()
	const rtl = isRtl(locale)
	let text: string
	if (DOLLAR_CURRENCIES.has(code) && !rtl) {
		const sign = value < 0 ? '-' : ''
		text = `${sign}$${Math.abs(value).toLocaleString('en-US', {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`
	} else {
		try {
			text = new Intl.NumberFormat(locale, {
				style: 'currency',
				currency: code,
			}).format(value)
		} catch {
			text = `${value.toFixed(2)} ${code}`
		}
	}
	return rtl ? `${FSI}${text}${PDI}` : text
}

export type MoneyFormatter = (cents: number) => string
/** `locale` defaults to the language active when called, so a switch needs no new formatter. */
export const moneyFormatter =
	(currency: string, locale?: string): MoneyFormatter =>
	(cents) =>
		formatMoney(cents, currency, locale ?? (i18n.locale || 'en'))
