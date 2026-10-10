import { createHmac, timingSafeEqual } from 'node:crypto'
import { ENV } from 'varlock/env'

const PREVIEW_TOKEN_TTL_SECONDS = 60 * 60

function previewSecret() {
	const secret = ENV.SESSION_SECRET
	if (!secret) throw new Error('SESSION_SECRET is required for preview tokens.')
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
	const expiresAt = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS
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
