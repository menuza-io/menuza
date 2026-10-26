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

/** Country calling codes: one digit, then the two digit ones; any other is three digits. */
const ONE_DIGIT = new Set(['1', '7'])
const TWO_DIGIT = new Set([
	'20',
	'27',
	'30',
	'31',
	'32',
	'33',
	'34',
	'36',
	'39',
	'40',
	'41',
	'43',
	'44',
	'45',
	'46',
	'47',
	'48',
	'49',
	'51',
	'52',
	'53',
	'54',
	'55',
	'56',
	'57',
	'58',
	'60',
	'61',
	'62',
	'63',
	'64',
	'65',
	'66',
	'81',
	'82',
	'84',
	'86',
	'90',
	'91',
	'92',
	'93',
	'94',
	'95',
	'98',
])

export const callingCodeOf = (digits: string) => {
	if (ONE_DIGIT.has(digits.slice(0, 1))) return digits.slice(0, 1)
	if (TWO_DIGIT.has(digits.slice(0, 2))) return digits.slice(0, 2)
	return digits.slice(0, 3)
}

/** The shortest number worth comparing: fewer digits could be anyone. */
export const MIN_PHONE_DIGITS = 7

/**
 * The country calling codes of the places a restaurant is likely to be, by its
 * time zone: what a number typed without one (`0551234567`) is taken to be in.
 * A zone not listed says nothing: the numbers in the book are asked instead.
 */
const ZONE_CODES: Record<string, string> = {
	'Asia/Riyadh': '966',
	'Asia/Dubai': '971',
	'Asia/Muscat': '968',
	'Asia/Qatar': '974',
	'Asia/Kuwait': '965',
	'Asia/Bahrain': '973',
	'Asia/Amman': '962',
	'Asia/Beirut': '961',
	'Africa/Cairo': '20',
	'Asia/Karachi': '92',
	'Asia/Kolkata': '91',
	'Asia/Calcutta': '91',
	'Asia/Singapore': '65',
	'Europe/London': '44',
	'Europe/Paris': '33',
	'Europe/Berlin': '49',
	'Europe/Madrid': '34',
	'Europe/Rome': '39',
	'Europe/Istanbul': '90',
	'Australia/Sydney': '61',
	'Australia/Melbourne': '61',
	'Pacific/Auckland': '64',
	'America/New_York': '1',
	'America/Chicago': '1',
	'America/Denver': '1',
	'America/Phoenix': '1',
	'America/Los_Angeles': '1',
	'America/Anchorage': '1',
	'America/Toronto': '1',
	'America/Vancouver': '1',
	'Pacific/Honolulu': '1',
}

/**
 * The country calling code a number typed at this location is in: from its
 * time zone when that says (Riyadh is 966), else the most common code among
 * the international numbers already in the book. Null when neither says, and
 * then a number typed without a code is compared as it always was.
 */
export function locationCountryCode(input: {
	timeZone?: string | null
	phones: ReadonlyArray<string | null | undefined>
}): string | null {
	const byZone = input.timeZone ? ZONE_CODES[input.timeZone] : undefined
	if (byZone) return byZone
	const counts = new Map<string, number>()
	for (const phone of input.phones) {
		const text = (phone ?? '').trim()
		if (!text.startsWith('+')) continue
		const digits = phoneDigits(text)
		if (digits.length < MIN_PHONE_DIGITS) continue
		const code = callingCodeOf(digits)
		counts.set(code, (counts.get(code) ?? 0) + 1)
	}
	let best: string | null = null
	let most = 0
	for (const [code, count] of counts)
		if (count > most) {
			best = code
			most = count
		}
	return best
}

/** The number says its country: a plus, or 00 for it. */
const hasCountryCode = (value: string | null | undefined) => {
	const text = (value ?? '').trim()
	return text.startsWith('+') || phoneDigits(text).startsWith('00')
}

/**
 * The same number: the shorter one is the end of the longer (a country code
 * may be missing from one, a trunk zero extra on the other). Too few digits
 * on either side means nothing, and a number the server only showed the end of
 * (without the guest grant) is never enough.
 *
 * A number typed with no country code could be in any country: Saudi `05x`
 * and Emirati `05x` numbers share nine national digits. When the other number
 * has a code and the location's own (`countryCode`) is known, the typed one is
 * taken to be in it, and is the same only if that is the other's code too.
 */
export function samePhone(
	a: string | null | undefined,
	b: string | null | undefined,
	options: { countryCode?: string | null } = {},
) {
	const x = nationalDigits(a)
	const y = nationalDigits(b)
	if (x.length < MIN_PHONE_DIGITS || y.length < MIN_PHONE_DIGITS) return false
	const code = options.countryCode ?? null
	if (code) {
		const aHas = hasCountryCode(a)
		const bHas = hasCountryCode(b)
		// One side without a code, the other with: its code must be the location's.
		if (aHas !== bHas) {
			const [bare, whole] = aHas ? [y, x] : [x, y]
			if (!whole.startsWith(code)) return false
			// A bare number that already begins with the code (`1 415 555 0142`) is compared whole.
			const national = whole.slice(code.length)
			return endsWith(national, bare) || endsWith(whole, bare)
		}
	}
	return endsWith(x, y)
}

/** The shorter is the end of the longer. */
function endsWith(x: string, y: string) {
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	return long.endsWith(short)
}
