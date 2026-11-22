import { alertCopy, parseAlertSubject } from '@repo/common/operator-alert-copy'
import {
	decideDelivery,
	isOrderAlertKind,
	orderAlertKindFromNotificationType,
	pushCategoryForNotificationType,
} from '@repo/common/operator-alerts'
import {
	AlertLog,
	and,
	db,
	eq,
	isNull,
	lte,
	Notification,
	User,
	UserOrganization,
} from '@repo/database'
import { alertAppUrl, sendAlertEmail } from './order-alerts.server.ts'
import {
	loadAlertPolicySettings,
	markAlertsDropped,
	recordDeliveredChannels,
	type AlertChannel,
} from './policy.server.ts'
import {
	legacyPushCopy,
	legacyPushPath,
	sendPushToUser,
} from './push.server.ts'
import {
	isOperatorPushEnabled,
	isOrderAlertEmailAllowed,
	isOrderAlertsEnabled,
} from './switches.server.ts'

/**
 * The end of quiet hours (#366): non-critical alerts were kept as in-app
 * notifications and logged `held` with the channels still owed. When their time
 * comes (the Workflow wake-up or the hourly sweep) they are sent, unless the
 * member already saw them, left the organization, changed their hours again, or
 * a kill switch is off (then they are dropped, never queued).
 */

const BATCH = 200

function parse(value: string | null): AlertChannel[] {
	try {
		const parsed: unknown = JSON.parse(value ?? '[]')
		return Array.isArray(parsed)
			? parsed.filter((c): c is AlertChannel => typeof c === 'string')
			: []
	} catch {
		return []
	}
}

export async function releaseHeldAlerts(now = Date.now()): Promise<{
	released: number
	dropped: number
	deferred: number
	skipped: number
}> {
	const due = await db
		.select()
		.from(AlertLog)
		.where(
			and(
				eq(AlertLog.outcome, 'held'),
				isNull(AlertLog.releasedAt),
				lte(AlertLog.heldUntil, new Date(now)),
			),
		)
		.limit(BATCH)
	const result = { released: 0, dropped: 0, deferred: 0, skipped: 0 }
	for (const row of due) {
		try {
			const done = async (channels: AlertChannel[] = []) => {
				await db
					.update(AlertLog)
					.set({
						releasedAt: new Date(now),
						channels: JSON.stringify([
							...new Set([...parse(row.channels), ...channels]),
						]),
					})
					.where(eq(AlertLog.id, row.id))
			}
			if (!row.userId || !row.notificationId) {
				await done()
				result.skipped++
				continue
			}
			const [notification] = await db
				.select()
				.from(Notification)
				.where(eq(Notification.id, row.notificationId))
				.limit(1)
			// Seen already: the phone has nothing to add.
			if (!notification || notification.isRead || notification.isSeen) {
				await done()
				result.skipped++
				continue
			}
			const [member] = await db
				.select({ active: UserOrganization.active, email: User.email })
				.from(UserOrganization)
				.innerJoin(User, eq(User.id, UserOrganization.userId))
				.where(
					and(
						eq(UserOrganization.userId, row.userId),
						eq(UserOrganization.organizationId, row.organizationId),
					),
				)
				.limit(1)
			if (!member?.active) {
				await done()
				result.skipped++
				continue
			}
			// Quiet hours or a snooze may have been set again since.
			const settings = await loadAlertPolicySettings(
				row.userId,
				row.organizationId,
			)
			const again = decideDelivery({ settings, critical: false, nowMs: now })
			if (again.outcome === 'held' || again.outcome === 'snoozed') {
				await db
					.update(AlertLog)
					.set({ heldUntil: new Date(again.until) })
					.where(eq(AlertLog.id, row.id))
				result.deferred++
				continue
			}

			const owed = parse(row.heldChannels)
			const orderKind = orderAlertKindFromNotificationType(notification.type)
			const alertsOn = orderKind
				? await isOrderAlertsEnabled(row.organizationId)
				: true
			const pushOn = await isOperatorPushEnabled(row.organizationId)
			const delivered: AlertChannel[] = []
			let dropped = false
			let payload: Record<string, unknown> = {}
			try {
				payload = JSON.parse(notification.payload) as Record<string, unknown>
			} catch {
				payload = {}
			}
			const orgSlug = typeof payload.orgSlug === 'string' ? payload.orgSlug : ''
			const locationName =
				typeof payload.locationName === 'string' ? payload.locationName : null
			const timeZone =
				typeof payload.timeZone === 'string' ? payload.timeZone : null
			const subject = orderKind ? parseAlertSubject(payload.subject) : null

			if (owed.includes('push')) {
				if (!pushOn || !alertsOn) {
					dropped = true
				} else {
					const base = String(process.env.BASE_URL ?? '').replace(/\/$/, '')
					const category = pushCategoryForNotificationType(notification.type)
					const url =
						subject && orderKind && isOrderAlertKind(orderKind)
							? alertAppUrl(orgSlug, orderKind)
							: base && orgSlug
								? `${base}/${orgSlug}${legacyPushPath(notification.type, payload)}`
								: null
					const sent = await sendPushToUser({
						userId: row.userId,
						notificationId: notification.id,
						kind: notification.type,
						url,
						copyFor: (locale) => {
							if (subject) {
								const copy = alertCopy(subject, {
									locale,
									locationName,
									timeZone,
								})
								return { title: copy.title, body: copy.body }
							}
							return legacyPushCopy(category ?? 'staff', locale, locationName)
						},
					})
					if (sent > 0) delivered.push('push')
				}
			}
			if (owed.includes('email') && subject && orderKind) {
				if (!isOrderAlertEmailAllowed() || !alertsOn) {
					dropped = dropped || delivered.length === 0
				} else {
					const copy = alertCopy(subject, {
						locale: 'en',
						locationName,
						timeZone,
					})
					if (
						await sendAlertEmail(
							member.email,
							copy,
							alertAppUrl(orgSlug, orderKind),
						)
					) {
						delivered.push('email')
					}
				}
			}
			if (dropped && delivered.length === 0) {
				await markAlertsDropped([row.id])
				result.dropped++
				continue
			}
			await done(delivered)
			await recordDeliveredChannels(row.id, [
				...new Set([...parse(row.channels), ...delivered]),
			])
			result.released++
		} catch (error) {
			console.error('Held alert release failed', {
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
	return result
}
