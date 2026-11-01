import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Regional kill switch for discounts (`DISCOUNTS_ENABLED`, unset means on).
 * Off means this node applies nothing: a request that includes a code is
 * refused, and every other order is priced as if discounts did not exist.
 * Redemptions already reserved still settle with the order.
 */
export function isDiscountsKillSwitchOn(): boolean {
	syncEnvFromProcess()
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.DISCOUNTS_ENABLED
			: (ENV as { DISCOUNTS_ENABLED?: unknown }).DISCOUNTS_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
