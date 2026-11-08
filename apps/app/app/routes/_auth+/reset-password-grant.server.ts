import { and, db, eq, gt, Verification } from '@repo/database'

/**
 * A verified reset-password code becomes a one-time server-side grant: a
 * `Verification` row (type `reset-password-grant`, target the username) whose
 * `secret` is the SHA-256 of a random token that only the verify cookie holds.
 * Setting the new password consumes the row with a conditional delete, so a
 * copied or replayed cookie cannot set the password a second time, and a newer
 * verification replaces (and so revokes) an older grant.
 */
export const resetPasswordGrantType = 'reset-password-grant'
export const resetPasswordGrantSessionKey = 'resetPasswordGrant'
export const RESET_PASSWORD_GRANT_TTL_MS = 10 * 60 * 1000

function toHex(bytes: Uint8Array) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

async function hashGrantToken(token: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	)
	return toHex(new Uint8Array(digest))
}

function grantTokenBytes() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

/** Store a fresh grant for `username` and return the token for the cookie. */
export async function createResetPasswordGrant(username: string) {
	const token = grantTokenBytes()
	const secret = await hashGrantToken(token)
	const expiresAt = new Date(Date.now() + RESET_PASSWORD_GRANT_TTL_MS)
	// The TOTP columns are required by the table but unused for a grant.
	const values = {
		type: resetPasswordGrantType,
		target: username,
		secret,
		algorithm: 'SHA-256',
		digits: 0,
		period: 0,
		charSet: '',
		expiresAt,
	}
	await db
		.insert(Verification)
		.values(values)
		.onConflictDoUpdate({
			target: [Verification.target, Verification.type],
			set: { secret, expiresAt, createdAt: new Date() },
		})
	return token
}

function grantWhere(username: string, secret: string) {
	return and(
		eq(Verification.target, username),
		eq(Verification.type, resetPasswordGrantType),
		eq(Verification.secret, secret),
		gt(Verification.expiresAt, new Date()),
	)
}

/** True when the grant exists and is unexpired. Does not consume it. */
export async function hasResetPasswordGrant(username: string, token: string) {
	const secret = await hashGrantToken(token)
	const [row] = await db
		.select({ id: Verification.id })
		.from(Verification)
		.where(grantWhere(username, secret))
		.limit(1)
	return Boolean(row)
}

/** Atomically consume the grant. Only one caller can ever get `true`. */
export async function consumeResetPasswordGrant(
	username: string,
	token: string,
) {
	const secret = await hashGrantToken(token)
	const deleted = await db
		.delete(Verification)
		.where(grantWhere(username, secret))
		.returning({ id: Verification.id })
	return deleted.length > 0
}
