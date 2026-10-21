import {
	managerAlertKindFromNotificationType,
	STAFFING_NOTIFICATION_TYPE_PREFIX,
	STAFFING_PERMISSIONS,
} from '@repo/staffing'
import { filterVisibleReservationNotifications } from '#app/utils/reservations/notification-visibility.server.ts'
import {
	isStaffingFeatureEnabled,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'

/**
 * Staffing alerts that already sit in a member's notification list stay hidden
 * once they could no longer be opened: the organization turned the module off,
 * or the member's role no longer reads what the alert points at. The rows hold only
 * a kind, a scope id and a count, but a module that is off must not show up
 * anywhere, and the item would only lead to a 404.
 */

export function isStaffingNotificationType(type: string): boolean {
	return type.startsWith(STAFFING_NOTIFICATION_TYPE_PREFIX)
}

/**
 * What an alert opens decides who may see it: time clock alerts need the time
 * clock and timesheets, a published schedule needs scheduling and the schedule.
 */
export type StaffingAlertGroup = 'timeclock' | 'schedule' | 'hiring'

export function staffingAlertGroup(type: string): StaffingAlertGroup {
	const kind = managerAlertKindFromNotificationType(type)
	if (kind === 'schedule_published') return 'schedule'
	if (
		kind === 'new_applicant' ||
		kind === 'onboarding_due' ||
		kind === 'certificate_expiring'
	) {
		return 'hiring'
	}
	return 'timeclock'
}

const GROUP_REQUIREMENTS = {
	timeclock: {
		feature: 'timeclock',
		permission: STAFFING_PERMISSIONS.READ_TIMESHEET,
	},
	schedule: {
		feature: 'scheduling',
		permission: STAFFING_PERMISSIONS.READ_SCHEDULE,
	},
	hiring: {
		feature: 'hiring',
		permission: STAFFING_PERMISSIONS.READ_HIRING,
	},
} as const

/** Organization ids (from `organizationIds`) where the member may see the alerts. */
export async function staffingAlertVisibleOrgIds(
	userId: string,
	organizationIds: Iterable<string>,
	group: StaffingAlertGroup = 'timeclock',
): Promise<Set<string>> {
	const { feature, permission } = GROUP_REQUIREMENTS[group]
	const visible = new Set<string>()
	await Promise.all(
		[...new Set(organizationIds)].map(async (organizationId) => {
			try {
				if (
					(await isStaffingFeatureEnabled(organizationId, feature)) &&
					(await userHasStaffingPermission(userId, organizationId, permission))
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

/** Counts the alerts (of any group) the member can still open, by organization and type. */
export async function countVisibleStaffingAlerts(
	userId: string,
	alerts: ReadonlyArray<{ type: string; organizationId: string }>,
): Promise<number> {
	let total = 0
	for (const group of ['timeclock', 'schedule', 'hiring'] as const) {
		const inGroup = alerts.filter(
			(alert) => staffingAlertGroup(alert.type) === group,
		)
		if (inGroup.length === 0) continue
		const visible = await staffingAlertVisibleOrgIds(
			userId,
			inGroup.map((alert) => alert.organizationId),
			group,
		)
		total += inGroup.filter((alert) => visible.has(alert.organizationId)).length
	}
	return total
}

/**
 * Drops staffing and reservations alerts the member can no longer open;
 * everything else passes.
 */
export async function filterVisibleNotifications<
	T extends { type: string; organizationId: string },
>(userId: string, allNotifications: readonly T[]): Promise<T[]> {
	const notifications = await filterVisibleReservationNotifications(
		userId,
		allNotifications,
	)
	const staffing = notifications.filter((n) =>
		isStaffingNotificationType(n.type),
	)
	if (staffing.length === 0) return [...notifications]
	const visibleByGroup = new Map<StaffingAlertGroup, Set<string>>()
	for (const group of ['timeclock', 'schedule', 'hiring'] as const) {
		const inGroup = staffing.filter((n) => staffingAlertGroup(n.type) === group)
		if (inGroup.length === 0) continue
		visibleByGroup.set(
			group,
			await staffingAlertVisibleOrgIds(
				userId,
				inGroup.map((n) => n.organizationId),
				group,
			),
		)
	}
	return notifications.filter(
		(n) =>
			!isStaffingNotificationType(n.type) ||
			visibleByGroup.get(staffingAlertGroup(n.type))?.has(n.organizationId) ===
				true,
	)
}
