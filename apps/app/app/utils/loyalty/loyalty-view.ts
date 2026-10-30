import {
	asciiNumberText,
	minorToMajor,
	minorToMajorText,
} from '#app/utils/money-input.ts'

/**
 * Display math for the loyalty pages: minor-unit money, basis points and
 * dates. Money is always integer minor units with an explicit ISO currency.
 * Typed money is read by `parseMoneyToMinor` in `#app/utils/money-input.ts`.
 */

/**
 * Minor units to a currency string in the currency's own exponent, for
 * example `1550, 'USD'` → "$15.50", `1550, 'KWD'` → "KWD 1.550".
 */
export function formatLoyaltyMoney(
	minor: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minorToMajor(minor, currency))
	} catch {
		return `${minorToMajorText(minor, currency)} ${currency.toUpperCase()}`
	}
}

/** Minor units to the plain decimal a text field shows, for example `15.50`. */
export function minorToMoneyInput(
	minor: number | null | undefined,
	currency?: string | null,
): string {
	return minor === null || minor === undefined
		? ''
		: minorToMajorText(minor, currency)
}

/** Basis points to the plain percent a text field shows: 1000 → "10". */
export function bpToPercentInput(bp: number | null | undefined): string {
	if (bp === null || bp === undefined) return ''
	const percent = bp / 100
	return Number.isInteger(percent) ? String(percent) : percent.toFixed(2)
}

/**
 * A percent input such as `10`, `12.5` or `١٢٫٥` to basis points, or null.
 * A comma is never a decimal mark here: "1,5" is refused, not read as 15%.
 */
export function parsePercentToBp(input: string): number | null {
	const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(asciiNumberText(input))
	if (!match) return null
	const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
	return bp >= 1 && bp <= 10_000 ? bp : null
}

/** A ratio in basis points (10000 = 100%) as a display percent. */
export function formatBpPercent(bp: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			minimumFractionDigits: 0,
			maximumFractionDigits: 1,
		}).format(bp / 10_000)
	} catch {
		return `${(bp / 100).toFixed(1)}%`
	}
}

/** Local `YYYY-MM-DD` for an instant in a time zone (falls back to UTC). */
export function dateInTimeZone(at: Date | number, timeZone?: string): string {
	try {
		return new Intl.DateTimeFormat('en-CA', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			timeZone: timeZone && isUsableTimeZone(timeZone) ? timeZone : 'UTC',
		}).format(at)
	} catch {
		return new Date(at).toISOString().slice(0, 10)
	}
}

/** True when `Intl` accepts the time zone (mirrors the API's validation). */
export function isUsableTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value })
		return true
	} catch {
		return false
	}
}

/** A millisecond timestamp as a short localized date-time. */
export function formatLoyaltyInstant(
	at: number | null | undefined,
	locale: string,
	timeZone?: string,
): string | null {
	if (at === null || at === undefined) return null
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: timeZone && isUsableTimeZone(timeZone) ? timeZone : undefined,
		}).format(new Date(at))
	} catch {
		return new Date(at).toLocaleString(locale)
	}
}

/** A signed point delta with an explicit sign, for ledger rows. */
export function formatSignedPoints(delta: number, locale: string): string {
	const absolute = Math.abs(delta)
	let formatted: string
	try {
		formatted = new Intl.NumberFormat(locale).format(absolute)
	} catch {
		formatted = String(absolute)
	}
	return `${delta > 0 ? '+' : delta < 0 ? '\u2212' : ''}${formatted}`
}

/**
 * QR tabs paid from the phone whose money can still come back. Online orders
 * record refunds on the order, till sales send theirs with the sale, and a
 * tab rung up on a till earns there.
 */
export function canRefundPurchase(purchase: {
	sourceType: string
	state: string
	excludedReason: string | null
	refundedMinor: number
	totalPaidMinor: number
}): boolean {
	if (purchase.sourceType !== 'qr_tab') return false
	if (purchase.state === 'completed') {
		return purchase.refundedMinor < purchase.totalPaidMinor
	}
	if (purchase.state === 'excluded') {
		return purchase.excludedReason === 'cancelled'
	}
	return purchase.state === 'review'
}
