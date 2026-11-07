/**
 * Digits as tenant-api reads them. An Arabic keyboard types Arabic-Indic
 * (U+0660-U+0669) or Persian (U+06F0-U+06F9) digits, but phone numbers and
 * one-time codes are checked against ASCII `0-9` only.
 */
const ARABIC_DIGITS = /[٠-٩۰-۹]/g

/** Arabic-Indic and Persian digits become ASCII; every other character is kept. */
export function toAsciiDigits(value: string): string {
	return value.replace(ARABIC_DIGITS, (digit) => {
		const code = digit.charCodeAt(0)
		return String(code - (code >= 0x6f0 ? 0x6f0 : 0x660))
	})
}

export const OTP_CODE_LENGTH = 6

/**
 * What a one-time code field keeps from typed or pasted text: ASCII digits
 * only, at most six, so `١٢٣٤٥٦` and a pasted `123 456` both become `123456`.
 */
export function otpCodeDigits(value: string): string {
	return toAsciiDigits(value)
		.replace(/[^0-9]/g, '')
		.slice(0, OTP_CODE_LENGTH)
}

export function isCompleteOtpCode(value: string): boolean {
	return /^[0-9]{6}$/.test(value)
}
