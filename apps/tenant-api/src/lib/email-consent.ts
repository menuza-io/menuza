import { ENV } from 'varlock/env'
import { getNodeRegion } from './region.ts'
import {
	hmacHash,
	syncEnvFromProcess,
	timingSafeEqualString,
} from './secrets.ts'

/**
 * Signed, stateless links for email consent: the double opt-in confirmation
 * and the unsubscribe link every broadcast carries. A token is
 * `base64url(json).hmac` (HMAC-SHA256 with AUTH_HMAC_SECRET), so nothing is
 * stored and the link works for anyone who holds the email, with no login.
 */
export type ConsentTokenKind = 'confirm' | 'unsubscribe'

export type ConsentTokenPayload = {
	k: ConsentTokenKind
	/** organization id */
	o: string
	/** customer id */
	c: string
	/** subscription topic */
	t: string
	/** confirm only: HMAC of the address being confirmed */
	e?: string
	/** confirm only: expiry, epoch ms */
	x?: number
}

const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000

function sign(body: string) {
	return hmacHash(`email-consent-token:${body}`)
}

export function signConsentToken(payload: ConsentTokenPayload): string {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${body}.${sign(body)}`
}

export function confirmTokenExpiry(now = Date.now()) {
	return now + CONFIRM_TTL_MS
}

export function verifyConsentToken(
	token: string,
	kind: ConsentTokenKind,
	now = Date.now(),
): ConsentTokenPayload | null {
	if (typeof token !== 'string' || token.length > 1024) return null
	const [body, signature, extra] = token.split('.')
	if (!body || !signature || extra !== undefined) return null
	let expected: string
	try {
		expected = sign(body)
	} catch {
		return null
	}
	if (!timingSafeEqualString(signature, expected)) return null
	try {
		const payload = JSON.parse(
			Buffer.from(body, 'base64url').toString('utf8'),
		) as ConsentTokenPayload
		if (
			payload.k !== kind ||
			typeof payload.o !== 'string' ||
			typeof payload.c !== 'string' ||
			typeof payload.t !== 'string'
		) {
			return null
		}
		if (
			kind === 'confirm' &&
			(typeof payload.x !== 'number' || payload.x < now)
		) {
			return null
		}
		return payload
	} catch {
		return null
	}
}

/** Public origin of this tenant-api node, for links inside emails. */
export function consentBaseUrl(requestOrigin?: string): string {
	syncEnvFromProcess()
	const configured = (ENV as Record<string, unknown>).TENANT_API_URL
	if (typeof configured === 'string' && configured) {
		return configured.replace(/\/$/, '')
	}
	if (requestOrigin) return requestOrigin.replace(/\/$/, '')
	return getNodeRegion() === 'ksa'
		? 'http://localhost:3009'
		: 'http://localhost:3007'
}

export function unsubscribeUrl(
	baseUrl: string,
	params: { orgId: string; customerId: string; topic: string },
) {
	const token = signConsentToken({
		k: 'unsubscribe',
		o: params.orgId,
		c: params.customerId,
		t: params.topic,
	})
	return `${baseUrl}/subscriptions/unsubscribe?token=${encodeURIComponent(token)}`
}

/** RFC 2369 / RFC 8058 headers for one-click unsubscribe in a mail client. */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
	return {
		'List-Unsubscribe': `<${url}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
	}
}
