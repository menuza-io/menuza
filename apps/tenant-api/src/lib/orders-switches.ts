import { isEmailSwitchOn } from '@repo/staffing'
import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

function liveSwitch(name: 'ORDERS_EMAIL_ENABLED' | 'ORDERS_SMS_ENABLED') {
	syncEnvFromProcess()
	// The switches exist to be flipped without a deploy, and the varlock
	// snapshot never forgets a key that was later unset, so read the live
	// environment when there is one.
	const live =
		typeof process !== 'undefined' && process.env
			? process.env[name]
			: (ENV as Record<string, unknown>)[name]
	return isEmailSwitchOn(live)
}

/**
 * `ORDERS_EMAIL_ENABLED=false` (also `0`, `off`, `no`, `disabled`) drops guest
 * order email (receipts and status messages) on this node. A message that is
 * queued or comes due while it is off ends `dropped`, never held, so turning
 * it back on sends no backlog. Unset means on.
 */
export function isOrdersEmailEnabled(): boolean {
	return liveSwitch('ORDERS_EMAIL_ENABLED')
}

/** Same contract as the email switch, for order texts (US node only). */
export function isOrdersSmsEnabled(): boolean {
	return liveSwitch('ORDERS_SMS_ENABLED')
}
