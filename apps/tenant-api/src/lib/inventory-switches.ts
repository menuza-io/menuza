import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Regional kill switch for inventory (`INVENTORY_ENABLED`, unset means on).
 * Off answers 503 `inventory_unavailable` on every operator (and, later,
 * Station) inventory route of this node. The sale-side queue keeps queuing
 * (phase 3), so switching it off never loses a sale's stock use.
 */
export function isInventoryKillSwitchOn(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one: the varlock snapshot never
	// forgets a key that was later unset.
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.INVENTORY_ENABLED
			: (ENV as { INVENTORY_ENABLED?: unknown }).INVENTORY_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
