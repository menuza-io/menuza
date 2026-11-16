import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Regional kill switch for gift cards (`GIFT_CARDS_ENABLED`, unset means on).
 * Off answers 503 `gift_cards_unavailable` on new sales, top-ups, activations
 * and redemptions on this node. Balance reads, refunds back to a card, paid
 * events and the tick keep working, so money already taken is never stranded.
 */
export function isGiftCardsKillSwitchOn(): boolean {
	syncEnvFromProcess()
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.GIFT_CARDS_ENABLED
			: (ENV as { GIFT_CARDS_ENABLED?: unknown }).GIFT_CARDS_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
