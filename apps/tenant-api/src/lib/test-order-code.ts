import crypto from 'node:crypto'

import {
	TEST_ORDER_CODE_TTL_MS,
	parseTestOrderCode,
	serializeTestOrderCode,
	testOrderCodeMessage,
} from '@repo/common/test-orders'

import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * One-time test order codes (#119). A code is never stored: it is an HMAC of
 * `AUTH_HMAC_SECRET` over the organization, the location, a random nonce and an
 * expiry, so a forged, altered, expired, other-location or other-organization
 * code simply does not verify. The region records the nonce when it mints a
 * code (for the daily limit) and when it spends one (one order per code).
 */

export function newTestOrderNonce(): string {
	return crypto.randomBytes(18).toString('base64url')
}

export function mintTestOrderCode(input: {
	orgId: string
	locationId: string
	nonce: string
	now: number
}): { code: string; expiresAt: number } {
	const exp = input.now + TEST_ORDER_CODE_TTL_MS
	const mac = hmacHash(
		testOrderCodeMessage({
			orgId: input.orgId,
			locationId: input.locationId,
			nonce: input.nonce,
			exp,
		}),
	)
	return {
		code: serializeTestOrderCode({
			locationId: input.locationId,
			nonce: input.nonce,
			exp,
			mac,
		}),
		expiresAt: exp,
	}
}

export type TestOrderCodeCheck =
	| { ok: true; nonce: string }
	| { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'location' }

/** MAC, expiry and location. The nonce is spent separately, in the order's transaction. */
export function verifyTestOrderCode(
	raw: unknown,
	expected: { orgId: string; locationId: string; now: number },
): TestOrderCodeCheck {
	const parsed = parseTestOrderCode(raw)
	if (!parsed) return { ok: false, reason: 'malformed' }
	const mac = hmacHash(
		testOrderCodeMessage({
			orgId: expected.orgId,
			locationId: parsed.locationId,
			nonce: parsed.nonce,
			exp: parsed.exp,
		}),
	)
	if (!timingSafeEqualString(parsed.mac, mac)) {
		return { ok: false, reason: 'signature' }
	}
	if (parsed.exp <= expected.now) return { ok: false, reason: 'expired' }
	if (parsed.locationId !== expected.locationId) {
		return { ok: false, reason: 'location' }
	}
	return { ok: true, nonce: parsed.nonce }
}
