import { createHmac, timingSafeEqual } from 'node:crypto'

// Read per call: on Workers the bindings reach `process.env` after the server
// build loads, so a module-level read can capture the build default.
function getMediaSigningSecret(): string {
	// Session secret first so a media-URL leak is not the internal command token.
	const secret =
		process.env.SESSION_SECRET || process.env.INTERNAL_COMMAND_TOKEN
	if (!secret) {
		throw new Error(
			'INTERNAL_COMMAND_TOKEN or SESSION_SECRET is required for media URL signing.',
		)
	}
	return secret
}

export function signMediaId(mediaId: string, expiresAt: number): string {
	return createHmac('sha256', getMediaSigningSecret())
		.update(`media:${mediaId}:${expiresAt}`)
		.digest('hex')
}

export function verifyMediaSignature(
	mediaId: string,
	signature: string | null,
	expiresAtValue: string | null,
): boolean {
	if (!signature || !expiresAtValue || !/^\d+$/u.test(expiresAtValue))
		return false
	const expiresAt = Number(expiresAtValue)
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= Math.floor(Date.now() / 1000)
	) {
		return false
	}
	const expected = signMediaId(mediaId, expiresAt)
	try {
		return (
			signature.length === expected.length &&
			timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
		)
	} catch {
		return false
	}
}
