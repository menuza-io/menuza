import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import {
	ORDER_ALERT_MARKER_TYPE,
	ORDER_ALERT_TYPE_PREFIX,
	STATION_ALERT_TYPE,
	orderAlertKindFromNotificationType,
} from '@repo/common/operator-alerts'
import { isOrderAlertsEnabled } from './switches.server.ts'

/**
 * Order and tablet alerts already in a member's list stay hidden once they could
 * no longer be opened: the organization turned the alerts off, or the member's
 * role lost the grant (the orders read grant, or the settings grant for a
 * tablet). The rows hold only a kind, a number, a place and a total, but an
 * alert for something a member may no longer see must not show up.
 */

export function isOrderAlertNotificationType(type: string): boolean {
	return type.startsWith(ORDER_ALERT_TYPE_PREFIX) || type === STATION_ALERT_TYPE
}

type Row = { type: string; organizationId: string }

async function visibleOrganizationIds(
	userId: string,
	type: string,
	organizationIds: Iterable<string>,
): Promise<Set<string>> {
	const permission =
		type === STATION_ALERT_TYPE
			? ORG_PERMISSIONS.UPDATE_SETTINGS_ANY
			: ORG_PERMISSIONS.READ_MENU_ANY
	const visible = new Set<string>()
	await Promise.all(
		[...new Set(organizationIds)].map(async (organizationId) => {
			try {
				if (!(await isOrderAlertsEnabled(organizationId))) return
				if (
					await userHasOrganizationPermission(
						userId,
						organizationId,
						permission,
					)
				) {
					visible.add(organizationId)
				}
			} catch {
				// Cannot tell: hide rather than show.
			}
		}),
	)
	return visible
}

async function visibleRows<T extends Row>(
	userId: string,
	alerts: readonly T[],
): Promise<Set<T>> {
	const shown = new Set<T>()
	for (const type of new Set(alerts.map((alert) => alert.type))) {
		if (!orderAlertKindFromNotificationType(type)) continue
		const ofType = alerts.filter((alert) => alert.type === type)
		const orgs = await visibleOrganizationIds(
			userId,
			type,
			ofType.map((alert) => alert.organizationId),
		)
		for (const row of ofType) if (orgs.has(row.organizationId)) shown.add(row)
	}
	return shown
}

export async function countVisibleOrderAlerts(
	userId: string,
	alerts: ReadonlyArray<Row>,
): Promise<number> {
	if (alerts.length === 0) return 0
	return (await visibleRows(userId, alerts)).size
}

/** Drops order and tablet alerts the member can no longer open, and the hidden markers. */
export async function filterVisibleOrderNotifications<T extends Row>(
	userId: string,
	notifications: readonly T[],
): Promise<T[]> {
	const alerts = notifications.filter((n) =>
		isOrderAlertNotificationType(n.type),
	)
	if (alerts.length === 0) return [...notifications]
	const shown = await visibleRows(userId, alerts)
	return notifications.filter(
		(n) =>
			!isOrderAlertNotificationType(n.type) ||
			(n.type !== ORDER_ALERT_MARKER_TYPE && shown.has(n)),
	)
}
