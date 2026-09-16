import { createHmac, timingSafeEqual } from 'node:crypto'

const MEDIA_SIGNING_SECRET =
	process.env.INTERNAL_COMMAND_TOKEN || process.env.SESSION_SECRET

if (!MEDIA_SIGNING_SECRET) {
	throw new Error(
		'INTERNAL_COMMAND_TOKEN or SESSION_SECRET is required for media URL signing.',
	)
}

export function signMediaId(mediaId: string, expiresAt: number): string {
	return createHmac('sha256', MEDIA_SIGNING_SECRET)
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
