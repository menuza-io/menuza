/**
 * Phone numbers as the stand compares and searches them. The server keeps
 * every number as E.164 (`+966551234567`); a host types what the guest says:
 * with a trunk zero (`0551234567` in Saudi Arabia or the UAE, `07911 123456`
 * in the UK), with `00` for the plus, with spaces, or on an Arabic keyboard.
 * Pure, so each of those is tested apart from the screens.
 */

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits as 0-9, so a number typed on an
 * Arabic keyboard finds a phone number or a code stored with Western digits
 * (and the other way round). NFKD folds the full-width digits already.
 */
export function foldDigits(text: string) {
	return text.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0xf))
}

/** Only the digits, from any keyboard: `+٩٦٦ 55` is `96655`. */
export const phoneDigits = (value: string | null | undefined) =>
	foldDigits((value ?? '').normalize('NFKD')).replace(/\D/g, '')

/**
 * The number without how it was dialled at home: the `00` that stands for a
 * plus, or the one trunk zero a national number starts with. What is left is
 * how the end of an E.164 number reads (`0551234567` is `551234567`).
 */
export function nationalDigits(value: string | null | undefined) {
	const text = (value ?? '').trim()
	const digits = phoneDigits(text)
	// A plus is already international: nothing in front of the country code.
	if (text.startsWith('+')) return digits
	if (digits.startsWith('00')) return digits.slice(2)
	return digits.startsWith('0') ? digits.slice(1) : digits
}

/** The shortest number worth comparing: fewer digits could be anyone. */
export const MIN_PHONE_DIGITS = 7

/**
 * The same number: the shorter one is the end of the longer (a country code
 * may be missing from one, a trunk zero extra on the other). Too few digits
 * on either side means nothing, and a number the server only showed the end of
 * (without the guest grant) is never enough.
 */
export function samePhone(
	a: string | null | undefined,
	b: string | null | undefined,
) {
	const x = nationalDigits(a)
	const y = nationalDigits(b)
	if (x.length < MIN_PHONE_DIGITS || y.length < MIN_PHONE_DIGITS) return false
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	return long.endsWith(short)
}
