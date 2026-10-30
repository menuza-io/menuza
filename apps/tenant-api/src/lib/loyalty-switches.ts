import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Regional kill switch for loyalty (`LOYALTY_ENABLED`, unset means on). Off
 * stops everything new on this node: new points accounts (the automatic link
 * at sign-in), member codes, till identification, quotes, holds and approvals, and earning on new orders.
 * What is already in flight keeps working, so turning it off never strands a
 * sale: reconciliation of claimed purchases and bound redemptions, operator
 * refunds and review decisions, the tick, and operators reading their
 * program, members and activity.
 */
export function isLoyaltyKillSwitchOn(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one: the varlock snapshot never
	// forgets a key that was later unset.
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.LOYALTY_ENABLED
			: (ENV as { LOYALTY_ENABLED?: unknown }).LOYALTY_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
