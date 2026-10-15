/**
 * Shared E.164 phone normalization (`architecture.md` §5.3, `VAL-FND-008`).
 * Used by both `apps/tenant-api/src/routes/auth.ts` and `@repo/reservations`.
 */
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/

export function normalizeGuestPhone(raw: string): string {
	let cleaned = raw.trim().replace(/[\s\-().]/g, '')
	if (cleaned.startsWith('00')) {
		cleaned = `+${cleaned.slice(2)}`
	}
	return cleaned
}

export function isValidNormalizedPhone(phone: string): boolean {
	return PHONE_REGEX.test(phone)
}
