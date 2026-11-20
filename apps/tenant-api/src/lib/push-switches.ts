import { ENV } from 'varlock/env'
import { getNodeRegion } from './region.ts'
import { syncEnvFromProcess } from './secrets.ts'

const DISABLED = new Set(['false', '0', 'off', 'no', 'disabled'])
const ENABLED = new Set(['true', '1', 'on', 'yes', 'enabled'])

function live(name: string): string {
	syncEnvFromProcess()
	const raw: unknown =
		typeof process !== 'undefined' && process.env
			? process.env[name]
			: (ENV as Record<string, unknown>)[name]
	return raw === undefined || raw === null
		? ''
		: String(raw).trim().toLowerCase()
}

/**
 * Kill switch for guest push on this node (`PUSH_ENABLED`, unset means on):
 * `false` (also `0`, `off`, `no`, `disabled`) answers `push_not_enabled` on the
 * device routes and sends nothing, service or marketing. Devices and logs are
 * kept, so switching back on resumes with no backlog (a push never waits).
 */
export function isPushKillSwitchOn(): boolean {
	return DISABLED.has(live('PUSH_ENABLED'))
}

/**
 * The KSA node sends nothing until legal approves that a device token plus a
 * non-personal payload may transit Apple, Google and Expo (#105, PDPL). Set
 * `PUSH_KSA_APPROVED=true` on the KSA node only after that decision; the flag
 * `customer_app.push` alone is not enough there.
 */
export function pushAllowedInRegion(region: string = getNodeRegion()): boolean {
	return region !== 'ksa' || ENABLED.has(live('PUSH_KSA_APPROVED'))
}
