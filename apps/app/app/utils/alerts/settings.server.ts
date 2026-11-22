import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import {
	ALERT_SETTINGS_WORKFLOW,
	alertSettingsInputSchema,
	isThresholdKind,
	MAX_ALERT_THRESHOLD,
	PUSH_CATEGORIES,
	PUSH_CATEGORY_WORKFLOW,
	defaultPushEnabled,
	snoozeEnd,
	SNOOZE_OPTIONS,
	THRESHOLD_KINDS,
	type PushCategory,
	type ThresholdKind,
} from '@repo/common/operator-alerts'
import {
	and,
	AlertLog,
	db,
	desc,
	eq,
	gte,
	inArray,
	NotificationPreference,
	OperatorPushDevice,
	User,
} from '@repo/database'
import { STAFFING_PERMISSIONS } from '@repo/staffing'
import { z } from 'zod'
import { inventoryAlertSettingsVisible } from '#app/utils/inventory/notification-visibility.server.ts'
import { reservationAlertVisibleOrgIds } from '#app/utils/reservations/notification-visibility.server.ts'
import {
	isStaffingFeatureEnabled,
	userHasStaffingPermission,
} from '#app/utils/staffing/access.server.ts'
import { loadAlertPolicySettings } from './policy.server.ts'
import {
	isOperatorPushEnabled,
	isOrderAlertsEnabled,
} from './switches.server.ts'

/**
 * What a member sees and changes in Settings, Notifications, on the web and in
 * the phone app: which alerts arrive as a push (#106), quiet hours, snooze and
 * thresholds (#366), and the alert log. One module serves both: the web route
 * (session) and `/api/push/preferences` (the operator token). Everything is
 * per member and per organization; an organization can never read another's.
 */

export type CategoryAvailability = Record<PushCategory, boolean>

/** The categories this member can be told about in this organization. */
export async function availablePushCategories(
	userId: string,
	organizationId: string,
): Promise<CategoryAvailability> {
	const [alertsOn, orders, settings] = await Promise.all([
		isOrderAlertsEnabled(organizationId),
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.READ_MENU_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		),
	])
	const [timeclock, scheduling, hiring] = await Promise.all([
		isStaffingFeatureEnabled(organizationId, 'timeclock'),
		isStaffingFeatureEnabled(organizationId, 'scheduling'),
		isStaffingFeatureEnabled(organizationId, 'hiring'),
	])
	const staffing =
		(timeclock &&
			(await userHasStaffingPermission(
				userId,
				organizationId,
				STAFFING_PERMISSIONS.READ_TIMESHEET,
			))) ||
		(scheduling &&
			(await userHasStaffingPermission(
				userId,
				organizationId,
				STAFFING_PERMISSIONS.READ_SCHEDULE,
			))) ||
		(hiring &&
			(await userHasStaffingPermission(
				userId,
				organizationId,
				STAFFING_PERMISSIONS.READ_HIRING,
			)))
	const [reservations, inventory] = await Promise.all([
		reservationAlertVisibleOrgIds(userId, [organizationId]),
		inventoryAlertSettingsVisible(userId, organizationId),
	])
	const ordersAlerts = alertsOn && orders
	return {
		new_orders: ordersAlerts,
		orders_waiting: ordersAlerts,
		ordering_paused: ordersAlerts,
		payment_review: ordersAlerts,
		large_orders: ordersAlerts,
		station_offline: alertsOn && settings,
		staff: Boolean(staffing),
		inventory: inventory.any,
		reservations: reservations.has(organizationId),
		chat_mentions: true,
	}
}

export type AlertSettingsView = {
	/** The organization has operator push on (the flag, and the node switch). */
	pushEnabled: boolean
	categories: Array<{
		category: PushCategory
		/** The member's push choice (or the default for their role). */
		push: boolean
		/** Always on: cannot be switched off. */
		locked: boolean
	}>
	quiet: {
		quietStart: string | null
		quietEnd: string | null
		timeZone: string | null
	}
	snoozedUntil: number | null
	thresholds: Record<ThresholdKind, number>
	/** Alerts of the last seven days per thresholdable kind (epoch ms), for the preview. */
	occurrences: Record<ThresholdKind, number[]>
	devices: Array<{
		id: string
		platform: string
		deviceName: string | null
		appVersion: string | null
		lastSeenAt: number
	}>
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export async function loadAlertSettings(
	userId: string,
	organizationId: string,
	now = Date.now(),
): Promise<AlertSettingsView> {
	const [
		available,
		pushEnabled,
		isManager,
		policy,
		prefRows,
		occurrenceRows,
		devices,
	] = await Promise.all([
		availablePushCategories(userId, organizationId),
		isOperatorPushEnabled(organizationId),
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		),
		loadAlertPolicySettings(userId, organizationId),
		db
			.select({
				workflow: NotificationPreference.workflow,
				push: NotificationPreference.push,
				threshold: NotificationPreference.threshold,
			})
			.from(NotificationPreference)
			.where(
				and(
					eq(NotificationPreference.userId, userId),
					eq(NotificationPreference.organizationId, organizationId),
					inArray(NotificationPreference.workflow, [
						...PUSH_CATEGORIES.map((c) => PUSH_CATEGORY_WORKFLOW[c]),
						...THRESHOLD_KINDS,
					]),
				),
			),
		db
			.select({ kind: AlertLog.kind, createdAt: AlertLog.createdAt })
			.from(AlertLog)
			.where(
				and(
					eq(AlertLog.organizationId, organizationId),
					eq(AlertLog.userId, userId),
					inArray(AlertLog.kind, [...THRESHOLD_KINDS]),
					gte(AlertLog.createdAt, new Date(now - WEEK_MS)),
				),
			)
			.limit(5000),
		db
			.select({
				id: OperatorPushDevice.id,
				platform: OperatorPushDevice.platform,
				deviceName: OperatorPushDevice.deviceName,
				appVersion: OperatorPushDevice.appVersion,
				lastSeenAt: OperatorPushDevice.lastSeenAt,
			})
			.from(OperatorPushDevice)
			.where(eq(OperatorPushDevice.userId, userId))
			.orderBy(desc(OperatorPushDevice.lastSeenAt)),
	])
	const categories = PUSH_CATEGORIES.filter(
		(category) => available[category],
	).map((category) => {
		const row = prefRows.find(
			(r) => r.workflow === PUSH_CATEGORY_WORKFLOW[category],
		)
		const locked = category === 'payment_review'
		return {
			category,
			locked,
			push: locked
				? true
				: (row?.push ?? defaultPushEnabled(category, isManager)),
		}
	})
	const thresholds = Object.fromEntries(
		THRESHOLD_KINDS.map((kind) => [
			kind,
			prefRows.find((r) => r.workflow === kind)?.threshold ?? 1,
		]),
	) as Record<ThresholdKind, number>
	const occurrences = Object.fromEntries(
		THRESHOLD_KINDS.map((kind) => [
			kind,
			occurrenceRows
				.filter((r) => r.kind === kind)
				.map((r) => r.createdAt.getTime()),
		]),
	) as Record<ThresholdKind, number[]>
	return {
		pushEnabled,
		categories,
		quiet: {
			quietStart: policy.quietStart,
			quietEnd: policy.quietEnd,
			timeZone: policy.timeZone,
		},
		snoozedUntil:
			policy.snoozedUntil !== null && policy.snoozedUntil > now
				? policy.snoozedUntil
				: null,
		thresholds,
		occurrences,
		devices: devices.map((d) => ({ ...d, lastSeenAt: d.lastSeenAt.getTime() })),
	}
}

export const saveAlertSettingSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('push'),
		category: z.enum(PUSH_CATEGORIES),
		enabled: z.boolean(),
	}),
	z.object({
		intent: z.literal('quiet_hours'),
		quiet: alertSettingsInputSchema,
	}),
	z.object({
		intent: z.literal('snooze'),
		option: z.enum([...SNOOZE_OPTIONS, 'clear']),
		/** Epoch ms; only for `custom`. */
		until: z.number().int().positive().optional(),
		timeZone: z.string().max(80).nullable().optional(),
	}),
	z.object({
		intent: z.literal('threshold'),
		kind: z.enum(THRESHOLD_KINDS),
		threshold: z.number().int().min(1).max(MAX_ALERT_THRESHOLD),
	}),
])
export type SaveAlertSetting = z.infer<typeof saveAlertSettingSchema>

export type SaveAlertSettingResult =
	{ ok: true } | { ok: false; status: 400 | 403; error: string }

async function upsertPreference(
	userId: string,
	organizationId: string,
	workflow: string,
	set: Partial<typeof NotificationPreference.$inferInsert>,
) {
	await db
		.insert(NotificationPreference)
		.values({ userId, organizationId, workflow, ...set })
		.onConflictDoUpdate({
			target: [
				NotificationPreference.userId,
				NotificationPreference.organizationId,
				NotificationPreference.workflow,
			],
			set,
		})
}

/** Saves one change. The caller has already checked the member belongs to the organization. */
export async function saveAlertSetting(
	userId: string,
	organizationId: string,
	input: SaveAlertSetting,
	now = Date.now(),
): Promise<SaveAlertSettingResult> {
	switch (input.intent) {
		case 'push': {
			const available = await availablePushCategories(userId, organizationId)
			if (!available[input.category]) {
				return { ok: false, status: 403, error: 'category_unavailable' }
			}
			// Payment review is always on: a switch that cannot be turned off is not stored.
			if (input.category === 'payment_review') return { ok: true }
			await upsertPreference(
				userId,
				organizationId,
				PUSH_CATEGORY_WORKFLOW[input.category],
				{ push: input.enabled },
			)
			return { ok: true }
		}
		case 'quiet_hours': {
			const { quietStart, quietEnd, timeZone } = input.quiet
			if ((quietStart === null) !== (quietEnd === null)) {
				return { ok: false, status: 400, error: 'quiet_hours_incomplete' }
			}
			await upsertPreference(userId, organizationId, ALERT_SETTINGS_WORKFLOW, {
				quietStart,
				quietEnd,
				timeZone,
			})
			return { ok: true }
		}
		case 'snooze': {
			if (input.option === 'clear') {
				await upsertPreference(
					userId,
					organizationId,
					ALERT_SETTINGS_WORKFLOW,
					{
						snoozedUntil: null,
					},
				)
				return { ok: true }
			}
			const policy = await loadAlertPolicySettings(userId, organizationId)
			const until = snoozeEnd(
				input.option,
				now,
				input.timeZone ?? policy.timeZone,
				input.until ?? null,
			)
			if (until === null)
				return { ok: false, status: 400, error: 'invalid_snooze' }
			await upsertPreference(userId, organizationId, ALERT_SETTINGS_WORKFLOW, {
				snoozedUntil: new Date(until),
			})
			return { ok: true }
		}
		case 'threshold': {
			if (!isThresholdKind(input.kind)) {
				return { ok: false, status: 400, error: 'invalid_kind' }
			}
			await upsertPreference(userId, organizationId, input.kind, {
				threshold: input.threshold,
			})
			return { ok: true }
		}
	}
}

export type AlertLogEntry = {
	id: string
	kind: string
	outcome: string
	channels: string[]
	critical: boolean
	createdAt: number
	locationId: string | null
	/** Who it went to: the member's name (managers see everyone's), else null (your own). */
	to: string | null
	recipient: boolean
}

/**
 * The alert log: what fired, to whom and whether it was snoozed. A member sees
 * their own entries; a member who can edit settings sees the organization's.
 */
export async function loadAlertLog(
	userId: string,
	organizationId: string,
	limit = 50,
): Promise<{ entries: AlertLogEntry[]; scope: 'mine' | 'organization' }> {
	const canSeeAll = await userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const rows = await db
		.select({
			id: AlertLog.id,
			kind: AlertLog.kind,
			outcome: AlertLog.outcome,
			channels: AlertLog.channels,
			critical: AlertLog.critical,
			createdAt: AlertLog.createdAt,
			locationId: AlertLog.locationId,
			userId: AlertLog.userId,
			recipientId: AlertLog.recipientId,
			name: User.name,
			username: User.username,
		})
		.from(AlertLog)
		.leftJoin(User, eq(User.id, AlertLog.userId))
		.where(
			canSeeAll
				? eq(AlertLog.organizationId, organizationId)
				: and(
						eq(AlertLog.organizationId, organizationId),
						eq(AlertLog.userId, userId),
					),
		)
		.orderBy(desc(AlertLog.createdAt))
		.limit(Math.min(Math.max(limit, 1), 200))
	return {
		scope: canSeeAll ? 'organization' : 'mine',
		entries: rows.map((row) => {
			let channels: string[] = []
			try {
				const parsed: unknown = JSON.parse(row.channels)
				channels = Array.isArray(parsed)
					? parsed.filter((c): c is string => typeof c === 'string')
					: []
			} catch {
				channels = []
			}
			return {
				id: row.id,
				kind: row.kind,
				outcome: row.outcome,
				channels,
				critical: row.critical,
				createdAt: row.createdAt.getTime(),
				locationId: row.locationId,
				to:
					row.userId === userId
						? null
						: row.recipientId
							? null
							: (row.name ?? row.username ?? null),
				recipient: row.recipientId !== null,
			}
		}),
	}
}
