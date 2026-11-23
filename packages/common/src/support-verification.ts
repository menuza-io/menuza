/**
 * Caller verification rules (#291), shared by the App (which shows the code to
 * the signed-in operator) and Admin (which asks for it and checks it). The
 * numbers are product decisions, kept in one place so a test can pin them.
 */

export const VERIFICATION_CODE_LENGTH = 6
/** A request, and the code made for it, stop working after this long. */
export const VERIFICATION_EXPIRY_MS = 10 * 60 * 1000
/** A sensitive action needs a verification no older than this. */
export const VERIFICATION_FRESH_MS = 15 * 60 * 1000
/** Wrong entries before verification locks for that user. */
export const VERIFICATION_MAX_ATTEMPTS = 5
export const VERIFICATION_LOCK_MS = 60 * 60 * 1000

/**
 * Admin actions that change who can get into an account. Each one refuses
 * without a fresh verification of the user it affects, checked on the server.
 */
export const SENSITIVE_SUPPORT_ACTIONS = [
	'change_email',
	'reset_two_factor',
	'start_ownership_transfer',
] as const
export type SensitiveSupportAction = (typeof SENSITIVE_SUPPORT_ACTIONS)[number]

export const SENSITIVE_ACTION_LABELS: Record<SensitiveSupportAction, string> = {
	change_email: 'Change email',
	reset_two_factor: 'Reset two-factor sign-in',
	start_ownership_transfer: 'Start an ownership transfer',
}

/** A uniformly random 6-digit code (rejection sampling: no modulo bias). */
export function generateVerificationCode(
	random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
		crypto.getRandomValues(bytes),
): string {
	const limit = 4_294_967_296 - (4_294_967_296 % 10 ** VERIFICATION_CODE_LENGTH)
	for (;;) {
		const bytes = random(new Uint8Array(4))
		const value =
			((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>>
			0
		if (value < limit) {
			return String(value % 10 ** VERIFICATION_CODE_LENGTH).padStart(
				VERIFICATION_CODE_LENGTH,
				'0',
			)
		}
	}
}

/** Reads what an agent typed: spaces and a dash are ignored, six digits required. */
export function normalizeVerificationCode(input: unknown): string | null {
	if (typeof input !== 'string') return null
	const digits = input.replace(/[\s-]/g, '')
	return /^\d{6}$/.test(digits) ? digits : null
}

/** The warning the operator sees above the code. */
export const VERIFICATION_WARNING =
	'Share this code only on a call or support request you started or expected. Menuza will never ask you for it in an email or a message.'
