/**
 * Member codes and till bindings.
 *
 * A member code is what a signed-in customer shows at the till: short-lived,
 * single use, and only identifies them. It never authorizes spending points:
 * that needs the customer's approval in their wallet or a one-time code sent
 * to their verified phone.
 *
 * A binding is what the till keeps after an online identification, so a sale
 * it makes offline later can still be credited. It is opaque, tied to one
 * terminal, expires, and is deleted when the person is erased. A typed phone
 * number is never a binding.
 */

/** Crockford base32 without I, L, O and U. */
export const LOYALTY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const LOYALTY_MEMBER_CODE_LENGTH = 8
export const LOYALTY_MEMBER_CODE_TTL_MS = 5 * 60_000

export const LOYALTY_BINDING_PREFIX = 'lmb1'
export const LOYALTY_BINDING_TTL_MS = 12 * 60 * 60_000

export const LOYALTY_APPROVAL_TTL_MS = 3 * 60_000

/**
 * A till's request to spend a member's points on one sale. The member grants
 * it in their signed-in wallet, or reads back a one-time code sent to their
 * verified phone; only then are the points reserved and bound to the sale.
 */
export const LOYALTY_APPROVAL_STATUSES = [
	'pending',
	'approved',
	'declined',
	'expired',
	'cancelled',
] as const
export type LoyaltyApprovalStatus = (typeof LOYALTY_APPROVAL_STATUSES)[number]

export const LOYALTY_APPROVAL_METHODS = ['wallet', 'otp'] as const
export type LoyaltyApprovalMethod = (typeof LOYALTY_APPROVAL_METHODS)[number]
export const LOYALTY_OTP_LENGTH = 6
export const LOYALTY_OTP_TTL_MS = 5 * 60_000
export const LOYALTY_OTP_MAX_ATTEMPTS = 5

function randomIndexes(count: number, modulo: number): number[] {
	const out: number[] = []
	// Rejection sampling keeps every symbol equally likely.
	const limit = 256 - (256 % modulo)
	while (out.length < count) {
		const bytes = new Uint8Array(count * 2)
		crypto.getRandomValues(bytes)
		for (const byte of bytes) {
			if (byte < limit) out.push(byte % modulo)
			if (out.length === count) break
		}
	}
	return out
}

export function generateMemberCode(): string {
	return randomIndexes(LOYALTY_MEMBER_CODE_LENGTH, LOYALTY_CODE_ALPHABET.length)
		.map((index) => LOYALTY_CODE_ALPHABET[index])
		.join('')
}

/** `ABCD-EFGH` for display; the dash is optional when typed. */
export function formatMemberCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * Read a typed or scanned code: case, spaces and dashes do not matter, and the
 * letters people confuse with digits (O, I, L) read as those digits.
 */
export function normalizeMemberCode(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 32) return null
	const cleaned = value
		.toUpperCase()
		.replace(/[\s-]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1')
	if (cleaned.length !== LOYALTY_MEMBER_CODE_LENGTH) return null
	for (const char of cleaned) {
		if (!LOYALTY_CODE_ALPHABET.includes(char)) return null
	}
	return cleaned
}

export function generateOtp(): string {
	return randomIndexes(LOYALTY_OTP_LENGTH, 10).join('')
}

export function normalizeOtp(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const digits = value.replace(/\s/g, '')
	return /^\d{6}$/.test(digits) ? digits : null
}

function randomToken(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const BINDING_PATTERN = new RegExp(
	`^${LOYALTY_BINDING_PREFIX}\\.[A-Za-z0-9_-]{43}$`,
)

export function generateBindingToken(): string {
	return `${LOYALTY_BINDING_PREFIX}.${randomToken()}`
}

export function isBindingToken(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 64 &&
		BINDING_PATTERN.test(value)
	)
}

/** HMAC messages for stored hashes (never the raw code). */
export const loyaltyHashMessages = {
	memberCode: (orgId: string, code: string) => `loyalty-code:${orgId}:${code}`,
	binding: (orgId: string, token: string) =>
		`loyalty-binding:${orgId}:${token}`,
	otp: (approvalId: string, otp: string) => `loyalty-otp:${approvalId}:${otp}`,
} as const
