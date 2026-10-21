import { isEmailSwitchOn } from '@repo/staffing'
import { ENV } from 'varlock/env'
import { syncEnvFromProcess } from './secrets.ts'

function liveSwitch(
	name: 'RESERVATIONS_EMAIL_ENABLED' | 'RESERVATIONS_SMS_ENABLED',
) {
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
 * `RESERVATIONS_EMAIL_ENABLED=false` drops guest email on this node. Messages
 * that come due while it is off are marked dropped, never held, so turning it
 * back on sends no backlog.
 */
export function isReservationsEmailEnabled(): boolean {
	return liveSwitch('RESERVATIONS_EMAIL_ENABLED')
}

/** Same contract as the email switch, for the SMS channel (US node only). */
export function isReservationsSmsEnabled(): boolean {
	return liveSwitch('RESERVATIONS_SMS_ENABLED')
}
