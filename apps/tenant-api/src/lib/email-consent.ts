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

const LOCAL_HOST_SUFFIXES = ['.test', '.localhost']

/** True for hosts that only exist on a developer machine. */
export function isLocalDevelopmentHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return (
		host === 'localhost' ||
		host === '127.0.0.1' ||
		host === '::1' ||
		LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
	)
}

function configuredConsentOrigin(): string | null {
	syncEnvFromProcess()
	const configured = (ENV as Record<string, unknown>).TENANT_API_URL
	if (typeof configured !== 'string' || !configured.trim()) return null
	try {
		const url = new URL(configured.trim())
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
		return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
	} catch {
		return null
	}
}

function isProductionRuntime(): boolean {
	syncEnvFromProcess()
	return (ENV as Record<string, unknown>).NODE_ENV === 'production'
}

/**
 * Public origin of this tenant-api node, for links inside emails (the
 * confirmation link and every unsubscribe URL), or null when none can be
 * trusted. The link carries a signed token, so its host must never come from
 * the request: a missing variable or a forged Host header would otherwise
 * send the token to an attacker.
 *
 * - `TENANT_API_URL` always wins.
 * - In production it is required: without it the result is null and the
 *   caller must skip the send.
 * - Outside production, the request origin is used only when its host is a
 *   local development host (localhost, 127.0.0.1, ::1, *.test, *.localhost).
 *   Any other host is ignored and the default local port is used.
 */
export function consentBaseUrl(requestOrigin?: string): string | null {
	const configured = configuredConsentOrigin()
	if (configured) return configured
	if (isProductionRuntime()) return null
	if (requestOrigin) {
		try {
			const origin = new URL(requestOrigin)
			if (
				(origin.protocol === 'http:' || origin.protocol === 'https:') &&
				isLocalDevelopmentHost(origin.hostname)
			) {
				return origin.origin
			}
		} catch {
			// fall through to the default local origin
		}
	}
	return getNodeRegion() === 'ksa'
		? 'http://localhost:3009'
		: 'http://localhost:3007'
}

/**
 * Startup check: in production the links in consent emails need a configured
 * origin, so a missing or invalid `TENANT_API_URL` is a deployment error.
 */
export function assertConsentBaseUrl() {
	if (isProductionRuntime() && !configuredConsentOrigin()) {
		throw new Error(
			"TENANT_API_URL must be set to this node's public https origin in production",
		)
	}
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
