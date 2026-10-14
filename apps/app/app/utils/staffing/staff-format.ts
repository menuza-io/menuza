import { type StaffMemberRow } from './staff-types.ts'

type NameParts = Pick<
	StaffMemberRow,
	'firstName' | 'lastName' | 'firstNameAr' | 'lastNameAr'
>

/** Full name, preferring the Arabic spelling when the viewer reads Arabic. */
export function staffDisplayName(person: NameParts, locale = 'en'): string {
	if (locale.startsWith('ar')) {
		const arabic = [person.firstNameAr, person.lastNameAr]
			.filter(Boolean)
			.join(' ')
			.trim()
		if (arabic) return arabic
	}
	return `${person.firstName} ${person.lastName}`.trim()
}

/** Up to two letters for an avatar. Never throws on an empty name. */
export function staffInitials(name: string): string {
	const letters = Array.from(name.trim().split(/\s+/).filter(Boolean))
		.slice(0, 2)
		.map((word) => Array.from(word)[0] ?? '')
	return letters.join('').toLocaleUpperCase()
}

/**
 * Minor units to a currency string. SAR, USD and CAD all use two decimals, so
 * `minor / 100` is exact. Tabular numerals are applied by the caller's class.
 */
export function formatMoneyMinor(
	minor: number,
	currency: string,
	locale = 'en',
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minor / 100)
	} catch {
		return `${(minor / 100).toFixed(2)} ${currency}`
	}
}

/** Whole-unit input such as `15.50` to minor units, or null when invalid. */
export function parseMoneyToMinor(input: string): number | null {
	const cleaned = input.trim().replace(/,/g, '')
	if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null
	return Math.round(Number(cleaned) * 100)
}

/** Minor units to the plain decimal a text field shows, for example `15.50`. */
export function minorToInput(minor: number | null | undefined): string {
	return minor === null || minor === undefined ? '' : (minor / 100).toFixed(2)
}

/** Local `YYYY-MM-DD` for "today" in the browser, used as a form default. */
export function todayLocalDate(now = new Date()): string {
	const y = now.getFullYear()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${y}-${m}-${d}`
}

/** Default dialing code for bare local numbers, from the org's one currency. */
export function defaultDialCode(
	currencies: readonly string[],
): '1' | '966' | null {
	const unique = [...new Set(currencies)]
	if (unique.length !== 1) return null
	if (unique[0] === 'SAR') return '966'
	if (unique[0] === 'USD' || unique[0] === 'CAD') return '1'
	return null
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g

function asciiDigits(input: string): string {
	return input.replace(ARABIC_DIGITS, (digit) => {
		const code = digit.charCodeAt(0)
		return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660)
	})
}

/**
 * Best-effort E.164. Accepts `+`, `00` and (with a default dialing code) a
 * national number. Returns null when it cannot be made into a valid number, so
 * the caller can show an inline error instead of guessing.
 */
export function normalizePhone(
	input: string,
	defaultCode: '1' | '966' | null = null,
): string | null {
	const raw = asciiDigits(input).trim()
	if (!raw) return null
	let digits = raw.replace(/[^\d+]/g, '')
	let international = false
	if (digits.startsWith('+')) {
		international = true
		digits = digits.slice(1)
	} else if (digits.startsWith('00')) {
		international = true
		digits = digits.slice(2)
	}
	digits = digits.replace(/\D/g, '')
	if (!international) {
		if (defaultCode === '1' && /^[2-9]\d{9}$/.test(digits))
			digits = `1${digits}`
		else if (defaultCode === '1' && /^1[2-9]\d{9}$/.test(digits)) {
			// Already carries the country code.
		} else if (defaultCode === '966' && /^05\d{8}$/.test(digits)) {
			digits = `966${digits.slice(1)}`
		} else if (defaultCode === '966' && /^5\d{8}$/.test(digits)) {
			digits = `966${digits}`
		} else {
			return null
		}
	}
	return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null
}
