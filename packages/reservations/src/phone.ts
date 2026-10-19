/**
 * Shared E.164 phone normalization (`architecture.md` §5.3, `VAL-FND-008`).
 * Used by `apps/tenant-api` (customers, guests, orders) and `@repo/reservations`.
 *
 * Input that already carries a country code (`+...` or `00...`) is never
 * reinterpreted. Only a number typed WITHOUT a country code depends on the
 * region the caller passes (the org's data region): without a region the
 * input is returned cleaned but unchanged, so it fails E.164 validation
 * instead of being guessed.
 */
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/

/** Regions with a national-number rule here (`TenantDataRegion`). */
export type PhoneRegion = 'us' | 'ksa'

export type NormalizePhoneOptions = {
	/** Region used to read a number typed without a country code. */
	region?: PhoneRegion | null
}

/**
 * National numbers by region. KSA mobiles are `05XXXXXXXX` (10 digits),
 * `5XXXXXXXX` (9 digits) or `9665XXXXXXXX` (country code without a plus).
 * US/NANP numbers are 10 digits, or 11 with a leading 1.
 */
function applyRegion(digits: string, region: PhoneRegion): string | null {
	if (!/^\d+$/.test(digits)) return null
	if (region === 'ksa') {
		if (/^05\d{8}$/.test(digits)) return `+966${digits.slice(1)}`
		if (/^5\d{8}$/.test(digits)) return `+966${digits}`
		if (/^9665\d{8}$/.test(digits)) return `+${digits}`
		return null
	}
	if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`
	if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`
	return null
}

export function normalizeGuestPhone(
	raw: string,
	options?: NormalizePhoneOptions,
): string {
	let cleaned = raw.trim().replace(/[\s\-().]/g, '')
	if (cleaned.startsWith('00')) {
		cleaned = `+${cleaned.slice(2)}`
	}
	if (cleaned.startsWith('+') || !options?.region) return cleaned
	return applyRegion(cleaned, options.region) ?? cleaned
}

export function isValidNormalizedPhone(phone: string): boolean {
	return PHONE_REGEX.test(phone)
}
