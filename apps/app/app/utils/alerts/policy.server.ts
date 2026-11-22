import {
	ALERT_SETTINGS_WORKFLOW,
	decideDelivery,
	EMPTY_ALERT_POLICY,
	isThresholdKind,
	THRESHOLD_WINDOW_MS,
	type AlertPolicySettings,
	type DeliveryDecision,
} from '@repo/common/operator-alerts'
import {
	and,
	AlertLog,
	count,
	db,
	eq,
	gte,
	inArray,
	lt,
	NotificationPreference,
} from '@repo/database'

/**
 * The one quiet-hours, snooze, threshold and alert-log system (#366). Operator
 * push and the order and tablet alerts both decide here; nothing else holds a
 * second set of these fields. Person-level settings live on the member's
 * `alerts.settings` row of `NotificationPreference`; a kind's threshold lives
 * on its own preference row.
 */

export type AlertOutcome =
	'delivered' | 'critical' | 'snoozed' | 'held' | 'below_threshold' | 'dropped'

export type AlertChannel = 'in_app' | 'push' | 'email' | 'sms'

/** The person's quiet hours and snooze; empty when they set none. */
export async function loadAlertPolicySettings(
	userId: string,
	organizationId: string,
): Promise<AlertPolicySettings> {
	const [row] = await db
		.select({
			quietStart: NotificationPreference.quietStart,
			quietEnd: NotificationPreference.quietEnd,
			timeZone: NotificationPreference.timeZone,
			snoozedUntil: NotificationPreference.snoozedUntil,
		})
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, userId),
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, ALERT_SETTINGS_WORKFLOW),
			),
		)
		.limit(1)
	if (!row) return EMPTY_ALERT_POLICY
	return {
		quietStart: row.quietStart,
		quietEnd: row.quietEnd,
		timeZone: row.timeZone,
		snoozedUntil: row.snoozedUntil ? row.snoozedUntil.getTime() : null,
	}
}

/** The member's threshold for a kind (null or 1: every time). */
export async function loadAlertThreshold(
	userId: string,
	organizationId: string,
	kind: string,
): Promise<number | null> {
	if (!isThresholdKind(kind)) return null
	const [row] = await db
		.select({ threshold: NotificationPreference.threshold })
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, userId),
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, kind),
			),
		)
		.limit(1)
	return row?.threshold ?? null
}

/** How many alerts of a kind the member has had in the last hour (the log's rows). */
async function occurrencesInLastHour(input: {
	userId: string
	organizationId: string
	kind: string
	now: number
}): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(AlertLog)
		.where(
			and(
				eq(AlertLog.organizationId, input.organizationId),
				eq(AlertLog.userId, input.userId),
				eq(AlertLog.kind, input.kind),
				gte(AlertLog.createdAt, new Date(input.now - THRESHOLD_WINDOW_MS)),
			),
		)
	return row?.value ?? 0
}

export type AppliedPolicy = {
	decision: DeliveryDecision
	/** True when this occurrence was already logged for the member: send nothing again. */
	replay: boolean
	logId: string | null
}

const OUTCOME_OF: Record<DeliveryDecision['outcome'], AlertOutcome> = {
	deliver: 'delivered',
	critical: 'critical',
	snoozed: 'snoozed',
	held: 'held',
	below_threshold: 'below_threshold',
}

/**
 * Decides whether an alert reaches a member now and writes the log row, once
 * per member and occurrence (the unique key is the claim, so a retried event
 * decides nothing twice). `channelsOwed` are the channels a held alert still
 * has to send when quiet hours end.
 */
export async function applyAlertPolicy(input: {
	userId: string
	organizationId: string
	locationId: string | null
	/** The log's `kind`: an order alert kind or a `Notification.type`. */
	kind: string
	entityId: string
	critical: boolean
	notificationId?: string | null
	channelsOwed?: readonly AlertChannel[]
	now?: number
}): Promise<AppliedPolicy> {
	const now = input.now ?? Date.now()
	const [settings, threshold, earlier] = await Promise.all([
		loadAlertPolicySettings(input.userId, input.organizationId),
		loadAlertThreshold(input.userId, input.organizationId, input.kind),
		occurrencesInLastHour({
			userId: input.userId,
			organizationId: input.organizationId,
			kind: input.kind,
			now,
		}),
	])
	const decision = decideDelivery({
		settings,
		critical: input.critical,
		nowMs: now,
		threshold,
		occurrencesInHour: earlier + 1,
	})
	const held = decision.outcome === 'held'
	const inserted = await db
		.insert(AlertLog)
		.values({
			organizationId: input.organizationId,
			userId: input.userId,
			locationId: input.locationId,
			kind: input.kind,
			entityId: input.entityId,
			notificationId: input.notificationId ?? null,
			outcome: OUTCOME_OF[decision.outcome],
			critical: input.critical,
			channels: '[]',
			heldChannels: held
				? JSON.stringify([...(input.channelsOwed ?? [])])
				: null,
			heldUntil: held ? new Date(decision.until) : null,
			createdAt: new Date(now),
		})
		.onConflictDoNothing()
		.returning({ id: AlertLog.id })
	if (inserted.length === 0) {
		return { decision, replay: true, logId: null }
	}
	return { decision, replay: false, logId: inserted[0]!.id }
}

/** Records the channels that actually went out (a failed email is not listed). */
export async function recordDeliveredChannels(
	logId: string | null,
	channels: readonly AlertChannel[],
	options: { notificationId?: string | null } = {},
): Promise<void> {
	if (!logId) return
	await db
		.update(AlertLog)
		.set({
			channels: JSON.stringify([...channels]),
			...(options.notificationId
				? { notificationId: options.notificationId }
				: {}),
		})
		.where(eq(AlertLog.id, logId))
}

/** Marks a log row `dropped` (a kill switch was off when it was due). */
export async function markAlertsDropped(
	logIds: readonly string[],
): Promise<void> {
	if (logIds.length === 0) return
	await db
		.update(AlertLog)
		.set({ outcome: 'dropped', releasedAt: new Date() })
		.where(inArray(AlertLog.id, [...logIds]))
}

/** Keeps the log for this long. */
export const ALERT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export async function pruneAlertLog(now = Date.now()): Promise<void> {
	await db
		.delete(AlertLog)
		.where(lt(AlertLog.createdAt, new Date(now - ALERT_LOG_RETENTION_MS)))
}
