import { getFeatureFlag } from '@repo/common/feature-flags'
import { isEmailSwitchOn } from '@repo/staffing'

/**
 * The flags and kill switches of operator push and the order alerts (#106,
 * #131, #241, #300, #190).
 *
 * Flags (default off, only a literal `true`):
 * - `notifications.operator_push`: push to the operator phone app.
 * - `orders.manager_alerts`: the order and tablet alerts (waiting, due soon,
 *   payment review, long pause, new order, large order, offline tablet).
 *
 * Kill switches, read live so they can be flipped without a deploy. Each
 * DROPS what it stops: nothing is queued, so turning one back on sends no
 * backlog. Unset means on; `false`, `0`, `off`, `no`, `disabled` mean off.
 * - `OPERATOR_PUSH_ENABLED`: every operator push.
 * - `ORDERS_ALERTS_ENABLED`: every order and tablet alert (tenant-api honors
 *   the same name and then stops posting them).
 * - `ORDERS_EMAIL_ENABLED`: the email of those alerts (in-app is unaffected).
 * - `ORDER_ALERT_SMS_ENABLED`: the texts to chosen recipients.
 */
export const OPERATOR_PUSH_FLAG = 'notifications.operator_push'
export const ORDER_ALERTS_FLAG = 'orders.manager_alerts'

function switchOn(name: string): boolean {
	const live =
		typeof process !== 'undefined' && process.env
			? process.env[name]
			: undefined
	return isEmailSwitchOn(live)
}

export const isOperatorPushSwitchOn = () => switchOn('OPERATOR_PUSH_ENABLED')
export const isOrderAlertsSwitchOn = () => switchOn('ORDERS_ALERTS_ENABLED')
export const isOrderAlertsEmailSwitchOn = () => switchOn('ORDERS_EMAIL_ENABLED')
export const isOrderAlertEmailAllowed = isOrderAlertsEmailSwitchOn
export const isOrderAlertSmsSwitchOn = () => switchOn('ORDER_ALERT_SMS_ENABLED')

/** The organization has operator push on and the node switch is not off. */
export async function isOperatorPushEnabled(
	organizationId: string,
): Promise<boolean> {
	if (!isOperatorPushSwitchOn()) return false
	return (await getFeatureFlag(OPERATOR_PUSH_FLAG, { organizationId })) === true
}

/** The organization has the order and tablet alerts on and the node switch is not off. */
export async function isOrderAlertsEnabled(
	organizationId: string,
): Promise<boolean> {
	if (!isOrderAlertsSwitchOn()) return false
	return (await getFeatureFlag(ORDER_ALERTS_FLAG, { organizationId })) === true
}
