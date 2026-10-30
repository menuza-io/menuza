export const OTP_LENGTH = 6

/**
 * What the code field keeps from typed or pasted text: ASCII digits only, at
 * most six. Arabic-Indic and Persian digits become their ASCII value, because
 * an Arabic keyboard types them and tenant-api only compares ASCII.
 */
export function otpDigits(value: string): string {
	let digits = ''
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0
		if (code >= 0x30 && code <= 0x39) digits += character
		else if (code >= 0x660 && code <= 0x669) digits += String(code - 0x660)
		else if (code >= 0x6f0 && code <= 0x6f9) digits += String(code - 0x6f0)
		if (digits.length === OTP_LENGTH) break
	}
	return digits
}

export function isCompleteOtp(value: string): boolean {
	return /^[0-9]{6}$/.test(value)
}
