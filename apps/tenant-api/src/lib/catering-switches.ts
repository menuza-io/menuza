import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Regional kill switch for guest-facing catering (`CATERING_PUBLIC_ENABLED`,
 * unset means on). Off answers 503 `catering_unavailable` on every guest
 * catering route (`/catering/*`) and on a catering order placement of this
 * node. Operator routes, payment events for money already taken, refunds and
 * the reminder tick keep working, so nothing already paid is stranded.
 */
export function isCateringPublicDisabled(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one: the varlock snapshot never
	// forgets a key that was later unset.
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env.CATERING_PUBLIC_ENABLED
			: (ENV as { CATERING_PUBLIC_ENABLED?: unknown }).CATERING_PUBLIC_ENABLED
	if (raw === false) return true
	if (!raw) return false
	return DISABLED_VALUES.has(String(raw).trim().toLowerCase())
}
