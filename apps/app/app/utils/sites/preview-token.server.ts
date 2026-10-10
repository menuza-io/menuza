import { createHmac, timingSafeEqual } from 'node:crypto'
import { ENV } from 'varlock/env'

// Expiry snaps to a bucket boundary so repeated loader calls (revalidation after
// every save) yield the *same* token and don't remount the preview iframe. A
// token therefore lives between TTL and TTL + BUCKET seconds.
const PREVIEW_TOKEN_TTL_SECONDS = 60 * 60
const PREVIEW_TOKEN_BUCKET_SECONDS = 30 * 60

function previewSecret() {
	const secret = ENV.SESSION_SECRET
	if (!secret || secret.length < 16) {
		throw new Error('SESSION_SECRET must be at least 16 characters.')
	}
	return secret
}

function sign(orgId: string, expiresAt: number) {
	return createHmac('sha256', previewSecret())
		.update(`site-preview:${orgId}:${expiresAt}`)
		.digest('hex')
}

/**
 * Short-lived token proving the caller may read unpublished pages of `orgId`.
 * Issued only to authenticated editors; the public `sites/page` endpoint
 * ignores `?preview=true` without a valid one.
 */
export function signSitePreviewToken(orgId: string) {
	const now = Math.floor(Date.now() / 1000)
	const expiresAt =
		(Math.floor(
			(now + PREVIEW_TOKEN_TTL_SECONDS) / PREVIEW_TOKEN_BUCKET_SECONDS,
		) +
			1) *
		PREVIEW_TOKEN_BUCKET_SECONDS
	return `${expiresAt}.${sign(orgId, expiresAt)}`
}

export function verifySitePreviewToken(
	orgId: string,
	token: string | null | undefined,
) {
	if (!token) return false
	const [expiresRaw, signature] = token.split('.')
	if (!expiresRaw || !signature || !/^\d+$/u.test(expiresRaw)) return false
	const expiresAt = Number(expiresRaw)
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= Math.floor(Date.now() / 1000)
	) {
		return false
	}
	const expected = sign(orgId, expiresAt)
	return (
		signature.length === expected.length &&
		timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	)
}
