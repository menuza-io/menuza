import { isEmailSwitchOn } from '@repo/staffing'
import { ENV } from 'varlock/env'

/**
 * `STAFFING_EMAIL_ENABLED=false` (also `0`, `off`, `no`, `disabled`) stops the
 * App sending manager alert emails. Unset means on. In-app notifications are not
 * affected. tenant-api honors the same variable for staff email, so one name
 * stops all staffing email on whichever service it is set.
 */
export function isStaffingEmailEnabled(): boolean {
	const live =
		typeof process !== 'undefined' && process.env?.STAFFING_EMAIL_ENABLED
			? process.env.STAFFING_EMAIL_ENABLED
			: (ENV as { STAFFING_EMAIL_ENABLED?: unknown }).STAFFING_EMAIL_ENABLED
	return isEmailSwitchOn(live)
}
