/**
 * Amounts typed into money and number fields. Arabic-Indic and Persian digits
 * and the Arabic decimal and thousands marks (٫ ٬) read like their ASCII
 * forms. A comma only groups thousands: threes after a first group of one to
 * three digits ("1,250.50"). Any other comma ("4,50", "1,5") is refused, so a
 * slip is never read as a different amount.
 */

/** Most whole digits a typed amount may have: 999,999,999.99. */
const MAX_WHOLE_DIGITS = 9

type Bounds = { min?: number; max?: number }

/** Bounds plus the ISO currency whose minor unit the amount is counted in. */
type MoneyOptions = Bounds & { currency?: string | null }

const exponentCache = new Map<string, number>()

/**
 * Decimal places of a currency's minor unit as `Intl` knows it: 2 for USD
 * and SAR, 3 for KWD, 0 for JPY. Unknown or missing codes count as 2.
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

/** Minor units as the plain decimal a text field shows: `1550, 'USD'` → "15.50". */
export function minorToMajorText(
	minor: number,
	currency?: string | null,
): string {
	return minorToMajor(minor, currency).toFixed(currencyExponent(currency))
}

/**
 * The text with ASCII digits and marks, trimmed. The invisible direction marks
 * (U+200E, U+200F, U+061C) a number copied from Arabic text carries are
 * dropped.
 */
export function asciiNumberText(input: string): string {
	return input
		.replace(/[\u200e\u200f\u061c]/g, '')
		.trim()
		.replace(/[\u0660-\u0669]/g, (digit) =>
			String(digit.charCodeAt(0) - 0x0660),
		)
		.replace(/[\u06f0-\u06f9]/g, (digit) =>
			String(digit.charCodeAt(0) - 0x06f0),
		)
		.replace(/\u066b/g, '.')
		.replace(/\u066c/g, ',')
}

/** Whole digits, optionally grouped in thousands, without the commas. */
function wholeDigits(text: string): string | null {
	if (/^\d+$/.test(text)) return text
	if (/^[1-9]\d{0,2}(?:,\d{3})+$/.test(text)) return text.replace(/,/g, '')
	return null
}

function within(
	value: number,
	{ min = 0, max = Number.MAX_SAFE_INTEGER }: Bounds,
): number | null {
	return value >= min && value <= max ? value : null
}

/**
 * Typed money in major units (`4.50`, `1,250`, `٤٫٥٠`) as integer minor
 * units. `currency` sets how many decimals the amount may have (two when it
 * is missing; three for KWD, none for JPY). Null when the text is not such an
 * amount or falls outside `min`..`max` minor units; `min: 1` refuses zero.
 */
export function parseMoneyToMinor(
	input: string,
	{ currency, ...bounds }: MoneyOptions = {},
): number | null {
	const exponent = currencyExponent(currency)
	const pattern =
		exponent === 0
			? /^([\d,]+)$/
			: new RegExp(`^([\\d,]+)(?:\\.(\\d{1,${exponent}}))?$`)
	const match = pattern.exec(asciiNumberText(input))
	if (!match) return null
	const digits = wholeDigits(match[1] ?? '')
	if (digits === null || digits.length > MAX_WHOLE_DIGITS) return null
	const minor =
		Number(digits) * 10 ** exponent +
		Number((match[2] ?? '').padEnd(exponent, '0') || '0')
	return within(minor, bounds)
}

/** A typed whole number (`12`, `1,000`, `١٢`), or null, with the same rules. */
export function parseWholeNumber(
	input: string,
	bounds: Bounds = {},
): number | null {
	const digits = wholeDigits(asciiNumberText(input))
	if (digits === null || digits.length > 15) return null
	return within(Number(digits), bounds)
}
