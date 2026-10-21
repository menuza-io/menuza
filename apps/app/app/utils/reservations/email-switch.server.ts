import { isEmailSwitchOn } from '@repo/staffing'
import { ENV } from 'varlock/env'

/**
 * `RESERVATIONS_EMAIL_ENABLED=false` (also `0`, `off`, `no`, `disabled`) stops
 * the App sending manager alert emails; unset means on. In-app notifications
 * are not affected. tenant-api honors the same name for guest email.
 */
export function isReservationsEmailEnabled(): boolean {
	const live =
		typeof process !== 'undefined' && process.env?.RESERVATIONS_EMAIL_ENABLED
			? process.env.RESERVATIONS_EMAIL_ENABLED
			: (ENV as { RESERVATIONS_EMAIL_ENABLED?: unknown })
					.RESERVATIONS_EMAIL_ENABLED
	return isEmailSwitchOn(live)
}
