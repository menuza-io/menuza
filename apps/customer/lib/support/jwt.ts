/**
 * Claims of a tenant-api access token, read for display only (name, org id).
 * The server verified the token; the app never trusts these for authorization.
 */
export type JwtClaims = {
	customerId: string | null
	orgId: string | null
	orgSlug: string | null
	name: string | null
	/** Milliseconds since the epoch. */
	expiresAt: number | null
}

const ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64UrlDecode(value: string): Uint8Array | null {
	const base64 = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.replace(/[^A-Za-z0-9+/]/g, '')
	if (base64.length % 4 === 1) return null
	const bytes: number[] = []
	let buffer = 0
	let bits = 0
	for (const character of base64) {
		buffer = (buffer << 6) | ALPHABET.indexOf(character)
		bits += 6
		if (bits >= 8) {
			bits -= 8
			bytes.push((buffer >> bits) & 0xff)
			buffer &= (1 << bits) - 1
		}
	}
	return Uint8Array.from(bytes)
}

function utf8Decode(bytes: Uint8Array): string | null {
	let encoded = ''
	for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, '0')}`
	try {
		return decodeURIComponent(encoded)
	} catch {
		return null
	}
}

export function decodeJwt(token: string): JwtClaims | null {
	const segments = token.split('.')
	if (segments.length < 2) return null
	const bytes = base64UrlDecode(segments[1] ?? '')
	const json = bytes ? utf8Decode(bytes) : null
	if (json === null) return null

	let payload: unknown
	try {
		payload = JSON.parse(json)
	} catch {
		return null
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null
	}
	const claims = payload as Record<string, unknown>
	const text = (key: string): string | null => {
		const value = claims[key]
		return typeof value === 'string' && value.length > 0 ? value : null
	}
	const exp = claims.exp
	return {
		customerId: text('customerId') ?? text('sub'),
		orgId: text('orgId'),
		orgSlug: text('orgSlug'),
		name: text('name'),
		expiresAt:
			typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null,
	}
}

export function isJwtExpired(
	claims: JwtClaims,
	now: number = Date.now(),
): boolean {
	return claims.expiresAt !== null && claims.expiresAt <= now
}
