import {
	CATERING_BALANCE_TOKEN_PURPOSE,
	CATERING_QUOTE_TOKEN_PURPOSE,
} from '@repo/common/catering'
import {
	parseQrToken,
	serializeQrToken,
	type ParsedQrToken,
} from '@repo/common/qr-ordering'

import { hmacHash, timingSafeEqualString } from './secrets.ts'

/**
 * Catering capabilities (#124, #361). Every link is an HMAC of
 * `AUTH_HMAC_SECRET` over the organization, the row id and its version, so
 * nothing is stored: bumping the version on the row burns every link minted
 * before it (editing a sent quote, voiding or reopening a balance). The token
 * carries `{id}.{version}.{mac}` in the URL fragment and an `X-Quote-Token` /
 * `X-Balance-Token` header, never a query string. The two kinds use different
 * purposes, so one can never stand in for the other.
 */

function quoteMessage(orgId: string, quoteId: string, version: number) {
	return `${CATERING_QUOTE_TOKEN_PURPOSE}:${orgId}:${quoteId}:${version}`
}

function balanceMessage(orgId: string, orderId: string, version: number) {
	return `${CATERING_BALANCE_TOKEN_PURPOSE}:${orgId}:${orderId}:${version}`
}

export function deriveQuoteToken(
	orgId: string,
	quoteId: string,
	version: number,
): string {
	return serializeQrToken(
		quoteId,
		version,
		hmacHash(quoteMessage(orgId, quoteId, version)),
	)
}

export function deriveBalanceToken(
	orgId: string,
	orderId: string,
	version: number,
): string {
	return serializeQrToken(
		orderId,
		version,
		hmacHash(balanceMessage(orgId, orderId, version)),
	)
}

/**
 * Parses and MAC-checks a presented quote token for this organization. The
 * caller still compares `version` with the row: a valid MAC for an old version
 * is a burned token.
 */
export function readQuoteToken(
	orgId: string,
	raw: unknown,
): ParsedQrToken | null {
	const parsed = parseQrToken(raw)
	if (!parsed) return null
	const expected = hmacHash(quoteMessage(orgId, parsed.id, parsed.version))
	return timingSafeEqualString(parsed.mac, expected) ? parsed : null
}

export function readBalanceToken(
	orgId: string,
	raw: unknown,
): ParsedQrToken | null {
	const parsed = parseQrToken(raw)
	if (!parsed) return null
	const expected = hmacHash(balanceMessage(orgId, parsed.id, parsed.version))
	return timingSafeEqualString(parsed.mac, expected) ? parsed : null
}
