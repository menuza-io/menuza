import { isEmailSwitchOn } from '@repo/staffing'
import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

function live(name: string) {
	// Read the live environment when there is one: the switch exists to be
	// flipped without a deploy, and the varlock snapshot never forgets a key
	// that was later unset. `syncEnvFromProcess` is deliberately not called
	// first: it can write that stale snapshot back into `process.env`.
	if (typeof process !== 'undefined' && process.env) return process.env[name]
	syncEnvFromProcess()
	return (ENV as Record<string, unknown>)[name]
}

/**
 * `MARKETING_SMS_ENABLED=false` (also `0`, `off`, `no`, `disabled`) stops every
 * marketing text on this node: a broadcast text fails when it starts and an
 * automation text step is skipped, so switching it back on sends no backlog.
 * Inbound STOP, START and HELP are compliance and are never switched off.
 * Unset means on.
 */
export function isMarketingSmsEnabled(): boolean {
	return isEmailSwitchOn(live('MARKETING_SMS_ENABLED'))
}

/**
 * Tests only: `MARKETING_SMS_QUIET_HOURS=off` under Vitest (which sets
 * `VITEST`) lets suites that are not about quiet hours send at any clock.
 * Never honoured anywhere else: production has no `VITEST`.
 */
export function quietHoursDisabledForTests(): boolean {
	return Boolean(live('VITEST')) && live('MARKETING_SMS_QUIET_HOURS') === 'off'
}
