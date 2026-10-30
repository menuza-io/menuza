/** Mirrors `phone.replace(/[\s\-()]/g, '')` in tenant-api, so both clients hash the same number. */
export function normalizePhone(phone: string): string {
	return phone.replace(/[\s\-()]/g, '')
}

/** ASCII digits only: Arabic-Indic digits are numbers, but the OTP path cannot process them. */
function asciiDigits(normalized: string): string {
	const body = normalized.startsWith('+') ? normalized.slice(1) : normalized
	return body.replace(/[^0-9]/g, '')
}

/**
 * tenant-api only requires five characters, but the SMS provider rejects
 * letters and punctuation, so sending a code waits for a plausible number.
 */
export function isValidPhone(phone: string): boolean {
	const normalized = normalizePhone(phone)
	const digits = asciiDigits(normalized)
	if (digits.length < 5 || digits.length > 15) return false
	const characters =
		Array.from(normalized).length - (normalized.startsWith('+') ? 1 : 0)
	return digits.length === characters
}

/** Longest prefix wins, so `966` beats `9`. An unknown prefix stays ungrouped: a wrong split is worse than none. */
const COUNTRY_CODES = [
	'1',
	'20',
	'27',
	'33',
	'34',
	'39',
	'44',
	'49',
	'52',
	'55',
	'60',
	'61',
	'62',
	'65',
	'66',
	'81',
	'82',
	'84',
	'86',
	'90',
	'91',
	'92',
	'94',
	'95',
	'98',
	'212',
	'234',
	'254',
	'351',
	'352',
	'353',
	'358',
	'380',
	'420',
	'421',
	'852',
	'880',
	'962',
	'964',
	'965',
	'966',
	'968',
	'971',
	'972',
].sort((a, b) => b.length - a.length)

/** Groups a normalized number for display without changing its digits. */
export function displayPhone(phone: string): string {
	const normalized = normalizePhone(phone)
	if (!normalized.startsWith('+')) return normalized

	const national = normalized.slice(1)
	const countryCode = COUNTRY_CODES.find((code) => national.startsWith(code))
	if (!countryCode) return normalized

	let remaining = Array.from(national.slice(countryCode.length))
	if (remaining.length <= 3) return normalized

	const groups: string[] = []
	while (remaining.length > 4) {
		groups.push(remaining.slice(0, 3).join(''))
		remaining = remaining.slice(3)
	}
	if (remaining.length > 0) groups.push(remaining.join(''))
	return `+${countryCode} ${groups.join(' ')}`
}
