import crypto from 'node:crypto'

export const LINE_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000
export const LINE_VERIFICATION_MAX_ATTEMPTS = 5

export const LINE_VERIFICATION_CODE_PATTERN = /^\d{6}$/

export function generateLineVerificationCode() {
	return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/**
 * Keyed so a leaked database row cannot be brute-forced offline across the
 * small 6-digit space, and bound to the number row so a hash cannot be
 * replayed onto another row.
 */
export function hashLineVerificationCode(
	secret: string,
	numberId: string,
	code: string,
) {
	return crypto
		.createHmac('sha256', secret)
		.update(`phone-line-verification:${numberId}:${code}`)
		.digest('hex')
}

export function safeEqualHex(left: string, right: string) {
	const a = Buffer.from(left, 'hex')
	const b = Buffer.from(right, 'hex')
	if (a.length === 0 || a.length !== b.length) return false
	return crypto.timingSafeEqual(a, b)
}

export type LineVerificationState = {
	verificationCodeHash: string | null
	verificationExpiresAt: Date | null
	verificationAttempts: number
}

export type LineVerificationCheck =
	| { ok: true }
	| {
			ok: false
			reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch'
			attemptsLeft: number
	  }

/**
 * Decides whether `code` verifies the line. Callers must count the attempt
 * (increment `verificationAttempts`) on every `mismatch`.
 */
export function checkLineVerificationCode(
	state: LineVerificationState,
	input: { secret: string; numberId: string; code: string; now: Date },
): LineVerificationCheck {
	const attemptsLeft = Math.max(
		0,
		LINE_VERIFICATION_MAX_ATTEMPTS - state.verificationAttempts,
	)
	if (!state.verificationCodeHash || !state.verificationExpiresAt) {
		return { ok: false, reason: 'no_code', attemptsLeft }
	}
	if (attemptsLeft === 0) {
		return { ok: false, reason: 'too_many_attempts', attemptsLeft }
	}
	if (state.verificationExpiresAt.getTime() <= input.now.getTime()) {
		return { ok: false, reason: 'expired', attemptsLeft }
	}
	const presented = hashLineVerificationCode(
		input.secret,
		input.numberId,
		input.code,
	)
	if (!safeEqualHex(presented, state.verificationCodeHash)) {
		return { ok: false, reason: 'mismatch', attemptsLeft: attemptsLeft - 1 }
	}
	return { ok: true }
}
