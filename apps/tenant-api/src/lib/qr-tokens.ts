import { ENV } from 'varlock/env'

import {
	parseQrToken,
	qrTabPaymentTokenMessage,
	qrTableTokenMessage,
	qrTabTokenMessage,
	serializeQrToken,
	type ParsedQrToken,
} from '@repo/common/qr-ordering'

import {
	hmacHash,
	syncEnvFromProcess,
	timingSafeEqualString,
} from './secrets.ts'

/**
 * QR ordering capabilities. Every token is an HMAC of `AUTH_HMAC_SECRET` over
 * the org, the row id and its version, so nothing is stored: bumping the
 * version on the row burns every token minted before it. Tokens travel in URL
 * fragments and `X-Table-Token` / `X-Tab-Token` headers, never query strings.
 */

export function deriveTableToken(
	orgId: string,
	tableId: string,
	version: number,
): string {
	return serializeQrToken(
		tableId,
		version,
		hmacHash(qrTableTokenMessage(orgId, tableId, version)),
	)
}

export function deriveTabToken(
	orgId: string,
	tabId: string,
	version: number,
): string {
	return serializeQrToken(
		tabId,
		version,
		hmacHash(qrTabTokenMessage(orgId, tabId, version)),
	)
}

/** Tab payment capability handed to the App bridge; only its hash is stored. */
export function deriveTabPaymentToken(orgId: string, tabId: string): string {
	return hmacHash(qrTabPaymentTokenMessage(orgId, tabId))
}

/**
 * Parses and MAC-checks a presented token for this org. The caller still has
 * to compare `version` with the row: a valid MAC for an old version is a
 * burned token.
 */
export function readTableToken(
	orgId: string,
	raw: unknown,
): ParsedQrToken | null {
	const parsed = parseQrToken(raw)
	if (!parsed) return null
	const expected = hmacHash(
		qrTableTokenMessage(orgId, parsed.id, parsed.version),
	)
	return timingSafeEqualString(parsed.mac, expected) ? parsed : null
}

export function readTabToken(
	orgId: string,
	raw: unknown,
): ParsedQrToken | null {
	const parsed = parseQrToken(raw)
	if (!parsed) return null
	const expected = hmacHash(qrTabTokenMessage(orgId, parsed.id, parsed.version))
	return timingSafeEqualString(parsed.mac, expected) ? parsed : null
}

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Kill switch for dine-in on this node (`QR_DINE_IN_ENABLED`). Pickup,
 * delivery, posters and operator routes never read it.
 */
export function isQrDineInDisabled(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one: the varlock snapshot never
	// forgets a key that was later unset.
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.QR_DINE_IN_ENABLED
			: (ENV as { QR_DINE_IN_ENABLED?: unknown }).QR_DINE_IN_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
