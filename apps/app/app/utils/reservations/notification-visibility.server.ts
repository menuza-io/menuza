import {
	getUserReservationsGrants,
	isReservationsFeatureEnabled,
} from '#app/utils/reservations/access.server.ts'
import {
	RESERVATION_ALERT_GRANTS,
	RESERVATION_ALERT_MARKER_TYPE,
	RESERVATION_ALERT_TYPE_PREFIX,
} from '#app/utils/reservations/manager-alerts.ts'

/**
 * Reservations alerts already in a member's list stay hidden once they could
 * no longer be opened: the organization turned the module off, or the member's
 * role no longer reads reservations. The rows hold only a kind, a location id
 * and a count, but a module that is off must not show up anywhere.
 */

export function isReservationsNotificationType(type: string): boolean {
	return type.startsWith(RESERVATION_ALERT_TYPE_PREFIX)
}

/** Organization ids (from `organizationIds`) where the member may see the alerts. */
export async function reservationAlertVisibleOrgIds(
	userId: string,
	organizationIds: Iterable<string>,
): Promise<Set<string>> {
	const visible = new Set<string>()
	await Promise.all(
		[...new Set(organizationIds)].map(async (organizationId) => {
			try {
				if (!(await isReservationsFeatureEnabled(organizationId))) return
				const grants = new Set<string>(
					await getUserReservationsGrants(userId, organizationId),
				)
				if (RESERVATION_ALERT_GRANTS.some((grant) => grants.has(grant))) {
					visible.add(organizationId)
				}
			} catch {
				// Cannot tell: hide rather than show.
			}
		}),
	)
	return visible
}

export async function countVisibleReservationAlerts(
	userId: string,
	alerts: ReadonlyArray<{ organizationId: string }>,
): Promise<number> {
	if (alerts.length === 0) return 0
	const visible = await reservationAlertVisibleOrgIds(
		userId,
		alerts.map((alert) => alert.organizationId),
	)
	return alerts.filter((alert) => visible.has(alert.organizationId)).length
}

/** Drops reservations alerts the member can no longer open and the email-only markers. */
export async function filterVisibleReservationNotifications<
	T extends { type: string; organizationId: string },
>(userId: string, notifications: readonly T[]): Promise<T[]> {
	const alerts = notifications.filter((n) =>
		isReservationsNotificationType(n.type),
	)
	if (alerts.length === 0) return [...notifications]
	const visible = await reservationAlertVisibleOrgIds(
		userId,
		alerts.map((n) => n.organizationId),
	)
	return notifications.filter(
		(n) =>
			!isReservationsNotificationType(n.type) ||
			(n.type !== RESERVATION_ALERT_MARKER_TYPE &&
				visible.has(n.organizationId)),
	)
}
