import { ENV } from 'varlock/env'
import { z } from 'zod'

import { syncEnvFromProcess } from './secrets.ts'

/**
 * Signed delivery quote tokens.
 *
 * `/delivery/quote` geocodes the customer's address on this regional node and
 * signs the result; `POST /orders` verifies the signature and re-resolves the
 * delivery zone from the signed coordinates. The browser holds the token but
 * cannot alter the coordinates or address it carries.
 *
 * Format: `dq1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>`. The key
 * is derived from AUTH_HMAC_SECRET with a distinct purpose label, so these
 * signatures can never be confused with OTP/refresh/receipt hashes. Web
 * Crypto only — works on Workers and Node.
 */

const TOKEN_PREFIX = 'dq1'
const PURPOSE_LABEL = 'delivery-quote:v1'
export const DELIVERY_QUOTE_TTL_MS = 2 * 60 * 60 * 1000

const payloadSchema = z.strictObject({
	orgId: z.string().min(1).max(100),
	locationId: z.string().min(1).max(100),
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	formatted: z.string().max(300),
	line1: z.string().max(200),
	city: z.string().max(100),
	state: z.string().max(100).nullable(),
	postalCode: z.string().max(20).nullable(),
	country: z.string().max(2).nullable(),
	unit: z.string().max(50).nullable(),
	/** Expiry, epoch milliseconds. */
	exp: z.number().int().positive(),
})

export type DeliveryQuotePayload = z.infer<typeof payloadSchema>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/')
		const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
		const bytes = new Uint8Array(new ArrayBuffer(binary.length))
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		return bytes
	} catch {
		return null
	}
}

const keyCache = new Map<string, Promise<CryptoKey>>()

function signingKey(): Promise<CryptoKey> {
	syncEnvFromProcess()
	const secret = ENV.AUTH_HMAC_SECRET || ''
	if (secret.length < 16) {
		return Promise.reject(new Error('AUTH_HMAC_SECRET is not configured'))
	}
	let cached = keyCache.get(secret)
	if (!cached) {
		cached = (async () => {
			// Derive a purpose-bound subkey: HMAC(secret, label).
			const root = await crypto.subtle.importKey(
				'raw',
				encoder.encode(secret),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign'],
			)
			const derived = await crypto.subtle.sign(
				'HMAC',
				root,
				encoder.encode(PURPOSE_LABEL),
			)
			return crypto.subtle.importKey(
				'raw',
				derived,
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign', 'verify'],
			)
		})()
		keyCache.clear()
		keyCache.set(secret, cached)
	}
	return cached
}

export async function signDeliveryQuote(
	payload: DeliveryQuotePayload,
): Promise<string> {
	const body = toBase64Url(
		encoder.encode(JSON.stringify(payloadSchema.parse(payload))),
	)
	const signed = `${TOKEN_PREFIX}.${body}`
	const signature = await crypto.subtle.sign(
		'HMAC',
		await signingKey(),
		encoder.encode(signed),
	)
	return `${signed}.${toBase64Url(new Uint8Array(signature))}`
}

export type DeliveryQuoteVerification =
	| { ok: true; payload: DeliveryQuotePayload }
	| { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' }

/**
 * Verifies signature (constant time via `crypto.subtle.verify`), expiry, and
 * that the quote was issued for this org + location.
 */
export async function verifyDeliveryQuote(
	token: string,
	expected: { orgId: string; locationId: string; now?: Date },
): Promise<DeliveryQuoteVerification> {
	const parts = token.split('.')
	if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
		return { ok: false, reason: 'malformed' }
	}
	const signature = fromBase64Url(parts[2]!)
	const body = fromBase64Url(parts[1]!)
	if (!signature || !body || signature.length !== 32) {
		return { ok: false, reason: 'malformed' }
	}
	const valid = await crypto.subtle.verify(
		'HMAC',
		await signingKey(),
		signature,
		encoder.encode(`${parts[0]}.${parts[1]}`),
	)
	if (!valid) return { ok: false, reason: 'signature' }
	let json: unknown
	try {
		json = JSON.parse(decoder.decode(body))
	} catch {
		return { ok: false, reason: 'malformed' }
	}
	const parsed = payloadSchema.safeParse(json)
	if (!parsed.success) return { ok: false, reason: 'malformed' }
	const now = (expected.now ?? new Date()).getTime()
	if (parsed.data.exp <= now) return { ok: false, reason: 'expired' }
	if (
		parsed.data.orgId !== expected.orgId ||
		parsed.data.locationId !== expected.locationId
	) {
		return { ok: false, reason: 'mismatch' }
	}
	return { ok: true, payload: parsed.data }
}
