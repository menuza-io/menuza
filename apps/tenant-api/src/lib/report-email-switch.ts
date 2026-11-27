import { isEmailSwitchOn } from '@repo/staffing'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Node kill switch for scheduled report emails (#121):
 * `REPORT_EMAIL_ENABLED=false` (also `0`, `off`, `no`, `disabled`) drops sends
 * on this node, they are not held, so switching it back on sends no backlog.
 * Unset or `true` is on. It exists because an organization flag cannot recall
 * an email.
 */
export function isReportEmailEnabled(): boolean {
	syncEnvFromProcess()
	return isEmailSwitchOn(
		typeof process !== 'undefined' ? process.env.REPORT_EMAIL_ENABLED : undefined,
	)
}
