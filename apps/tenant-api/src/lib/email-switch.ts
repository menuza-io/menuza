import { ENV } from 'varlock/env'
import { isEmailSwitchOn } from '@repo/staffing'
import { syncEnvFromProcess } from './secrets.ts'

/**
 * Environment kill switch for staff email. `STAFFING_EMAIL_ENABLED=false` (or
 * `0`/`off`/`no`) stops this node sending reminders and notices to staff. Unset
 * means enabled. Messages that come due while it is off are dropped, not held,
 * so flipping it back on does not send a backlog of stale reminders.
 *
 * It exists because an organization flag cannot recall an email: if a
 * deliverability or content problem turns up, this stops it without a deploy.
 * Manager alerts go through the App, which honors the same variable for its own
 * emails (in-app notifications are unaffected).
 */
export function isEmailEnabled(): boolean {
	syncEnvFromProcess()
	// Read the live environment when there is one (the switch exists to be
	// flipped without a deploy, and the varlock snapshot never forgets a key that
	// was later unset), as the kiosk switch does.
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.STAFFING_EMAIL_ENABLED
			: (ENV as { STAFFING_EMAIL_ENABLED?: unknown }).STAFFING_EMAIL_ENABLED
	return isEmailSwitchOn(live)
}
