import { ORG_PERMISSIONS } from '@repo/auth'
import {
	isUnavailableUntilExpired,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	Integration,
	lte,
	MenuSyncOutbox,
	Notification,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
	sql,
	User,
	UserOrganization,
} from '@repo/database'
import {
	isDoorDashStoreVerified,
	isPosOwnershipField,
	isPosProvider,
	isSyncFailing,
	mergePosSyncHealth,
	parseOverriddenFields,
	parsePosConfig,
	PosError,
	providerKind,
	providerNames,
	providerWriteMode,
	pushAvailability,
	pushHolidayHours,
	pushMenu,
	resolveFieldOwnership,
	sanitizeIntegrationErrorMessage,
	writeFields,
	type PosProvider,
} from '@repo/integrations'
import { ENV } from 'varlock/env'
import { resolveAlertMembers } from '#app/utils/alerts/members.server.ts'
import {
	applyAlertPolicy,
	recordDeliveredChannels,
} from '#app/utils/alerts/policy.server.ts'
import { sendPushToUser } from '#app/utils/alerts/push.server.ts'
import { isOperatorPushEnabled } from '#app/utils/alerts/switches.server.ts'
import { wakeOperatorAlertsAt } from '#app/utils/alerts/wake.server.ts'
import { reconcileDeliveryPauses } from '#app/utils/integrations/delivery-pause.server.ts'
import {
	isAutoSyncEnabled,
	isMenuAutoSyncSwitchOn,
	isPosOwnershipEnabled,
	isStoreSettingsEnabled,
} from '#app/utils/integrations/flags.server.ts'
import {
	MENU_SYNC_FAILING_NOTIFICATION_TYPE,
	menuSyncAlertPath,
} from '#app/utils/integrations/sync-alerts.ts'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'

export const MENU_SYNC_WORKFLOW_START_PATH = '/workflows/menu-sync/start'
export const MENU_PUSH_MIN_INTERVAL_MS = 15 * 60 * 1000
export const MENU_SYNC_BASE_BACKOFF_SECONDS = 30
export const MENU_SYNC_MAX_BACKOFF_SECONDS = 3600

export type EnqueueMenuSyncInput = {
	locationIds?: string[] | null
	kind: 'availability' | 'menu' | 'holiday_hours'
	entityType: 'item' | 'modifier_option' | 'menu' | 'all'
	entityId?: string
	available?: boolean
	menuId?: string
	immediate?: boolean
	now?: Date
}

export type EnqueueMenuSyncResult = {
	queued: number
	integrationIds: string[]
}

export type DrainMenuSyncOptions = {
	now?: Date
	organizationId?: string
	integrationId?: string
	nightly?: boolean
}

export type DrainMenuSyncResult = {
	skipped?: 'kill_switch'
	nightlyQueued: number
	availabilitySent: number
	availabilityFailed: number
	menuSent: number
	menuFailed: number
	holidayHoursSent?: number
	holidayHoursFailed?: number
	alerted: number
	deliveryPausesResumed: number
	deliveryPausesRenewed: number
}

/**
 * Best-effort wake-up of `MenuSyncWorkflow` for `runAt` (`step.sleepUntil`).
 * With no worker configured or a failed request, the 15-minute sweep still
 * drains queued rows.
 */
export async function wakeMenuSyncAt(runAt: Date): Promise<boolean> {
	const rawUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string' &&
		ENV.JOBS_CRON_WORKER_URL.trim()
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: typeof process !== 'undefined' && process.env?.JOBS_CRON_WORKER_URL
				? process.env.JOBS_CRON_WORKER_URL.trim()
				: ''
	if (!rawUrl) return false
	const token =
		typeof ENV.INTERNAL_COMMAND_TOKEN === 'string' && ENV.INTERNAL_COMMAND_TOKEN
			? ENV.INTERNAL_COMMAND_TOKEN
			: (process.env?.INTERNAL_COMMAND_TOKEN ?? '')
	try {
		const response = await fetch(
			`${rawUrl.replace(/\/$/, '')}${MENU_SYNC_WORKFLOW_START_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		void response.body?.cancel().catch(() => undefined)
		return response.ok
	} catch {
		return false
	}
}

export function computeMenuSyncBackoffMs(
	attempts: number,
	retryAfterSeconds?: number,
): number {
	const safeAttempts = Math.max(1, attempts)
	const exponentialSeconds = Math.min(
		MENU_SYNC_MAX_BACKOFF_SECONDS,
		MENU_SYNC_BASE_BACKOFF_SECONDS * 2 ** (safeAttempts - 1),
	)
	const backoffMs = exponentialSeconds * 1000
	if (
		typeof retryAfterSeconds === 'number' &&
		Number.isFinite(retryAfterSeconds) &&
		retryAfterSeconds > 0
	) {
		return Math.max(backoffMs, Math.ceil(retryAfterSeconds * 1000))
	}
	return backoffMs
}

type EligibleIntegration = typeof Integration.$inferSelect & {
	providerName: PosProvider
}

function isEligibleIntegrationConnection(
	integration: typeof Integration.$inferSelect,
): integration is EligibleIntegration {
	if (!integration.isActive) return false
	if (!isPosProvider(integration.providerName)) return false
	if (
		integration.providerName === 'doordash' &&
		parsePosConfig(integration.config).environment === 'live' &&
		!isDoorDashStoreVerified(integration.config)
	) {
		return false
	}
	return true
}

async function resolveEffectiveEntityAvailability(
	organizationId: string,
	entityType: 'item' | 'modifier_option',
	entityId: string,
	locationId: string | null,
	now: Date,
): Promise<boolean | null> {
	if (entityType === 'item') {
		const [item] = await db
			.select({
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
				variations: OrganizationMenuItem.variations,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.id, entityId),
					eq(OrganizationMenuItem.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!item) return null
		if (item.availabilityStatus === 'hidden') return false
		const variations = parseMenuVariations(item.variations)
		const availableVariants = variations.variants.filter((v) =>
			isUnavailableUntilExpired(v.availabilityStatus, v.unavailableUntil, now),
		)
		const globalAvailable =
			isUnavailableUntilExpired(
				item.availabilityStatus,
				item.unavailableUntil,
				now,
			) &&
			(!variations.variants.length || availableVariants.length > 0)
		if (!globalAvailable || !locationId) return globalAvailable

		const [override] = await db
			.select({
				isEnabled: OrganizationMenuLocationOverride.isEnabled,
				availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
				unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.locationId, locationId),
					eq(OrganizationMenuLocationOverride.entityType, 'item'),
					eq(OrganizationMenuLocationOverride.entityId, entityId),
				),
			)
			.limit(1)
		if (!override) return true
		if (override.isEnabled === false) return false
		return override.availabilityStatus
			? isUnavailableUntilExpired(
					override.availabilityStatus,
					override.unavailableUntil,
					now,
				)
			: true
	}

	const [option] = await db
		.select({
			availabilityStatus: OrganizationMenuOption.availabilityStatus,
			unavailableUntil: OrganizationMenuOption.unavailableUntil,
		})
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.id, entityId),
				eq(OrganizationMenuOption.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!option) return null
	if (option.availabilityStatus === 'hidden') return false
	const globalAvailable = isUnavailableUntilExpired(
		option.availabilityStatus,
		option.unavailableUntil,
		now,
	)
	if (!globalAvailable || !locationId) return globalAvailable

	const [override] = await db
		.select({
			isEnabled: OrganizationMenuLocationOverride.isEnabled,
			availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
			unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
		})
		.from(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organizationId),
				eq(OrganizationMenuLocationOverride.locationId, locationId),
				eq(OrganizationMenuLocationOverride.entityType, 'modifier_option'),
				eq(OrganizationMenuLocationOverride.entityId, entityId),
			),
		)
		.limit(1)
	if (!override) return true
	if (override.isEnabled === false) return false
	return override.availabilityStatus
		? isUnavailableUntilExpired(
				override.availabilityStatus,
				override.unavailableUntil,
				now,
			)
		: true
}

/**
 * Enqueues a coalesced menu or availability sync into `MenuSyncOutbox` for all
 * matching active POS and delivery integrations of the organization (#74).
 *
 * No-ops unless `integrations.auto_sync` and `MENU_AUTO_SYNC_ENABLED` are on.
 */
export async function enqueueMenuSync(
	organizationId: string,
	input: EnqueueMenuSyncInput,
): Promise<EnqueueMenuSyncResult> {
	if (!(await isAutoSyncEnabled(organizationId))) {
		return { queued: 0, integrationIds: [] }
	}
	if (Array.isArray(input.locationIds) && input.locationIds.length === 0) {
		return { queued: 0, integrationIds: [] }
	}

	const now = input.now ?? new Date()
	const allActive = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
			),
		)

	const locationSet = Array.isArray(input.locationIds)
		? new Set(input.locationIds)
		: null
	const candidates = allActive.filter((row): row is EligibleIntegration => {
		if (!isEligibleIntegrationConnection(row)) return false
		if (!locationSet) return true
		return (
			row.organizationLocationId === null ||
			locationSet.has(row.organizationLocationId)
		)
	})
	if (candidates.length === 0) {
		return { queued: 0, integrationIds: [] }
	}

	const posOwnershipEnabled = await isPosOwnershipEnabled(organizationId)
	const queuedIntegrationIds: string[] = []
	let earliestWakeAt: Date | null = null

	if (input.kind === 'availability') {
		if (
			(input.entityType !== 'item' && input.entityType !== 'modifier_option') ||
			!input.entityId
		) {
			return { queued: 0, integrationIds: [] }
		}

		const candidateIds = candidates.map((c) => c.id)
		const links = await db
			.select({
				integrationId: OrganizationMenuPosLink.integrationId,
				overriddenFields: OrganizationMenuPosLink.overriddenFields,
			})
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.organizationId, organizationId),
					eq(OrganizationMenuPosLink.entityType, input.entityType),
					eq(OrganizationMenuPosLink.localId, input.entityId),
					inArray(OrganizationMenuPosLink.integrationId, candidateIds),
				),
			)
		const linkByIntegration = new Map(links.map((l) => [l.integrationId, l]))

		for (const integration of candidates) {
			const provider = integration.providerName
			if (!writeFields[provider].includes('available')) continue

			if (posOwnershipEnabled && providerKind[provider] === 'pos') {
				const ownership = resolveFieldOwnership(provider, integration.config)
				const overridden = new Set(
					parseOverriddenFields(
						linkByIntegration.get(integration.id)?.overriddenFields,
					),
				)
				if (ownership.available === 'pos' && !overridden.has('available')) {
					continue
				}
			}

			const effectiveAvailable =
				input.available !== undefined
					? input.available
					: await resolveEffectiveEntityAvailability(
							organizationId,
							input.entityType,
							input.entityId,
							integration.organizationLocationId,
							now,
						)
			if (effectiveAvailable === null) continue

			const payload = JSON.stringify({ available: effectiveAvailable })
			await db
				.insert(MenuSyncOutbox)
				.values({
					organizationId,
					integrationId: integration.id,
					kind: 'availability',
					entityType: input.entityType,
					entityId: input.entityId,
					payload,
					status: 'queued',
					attempts: 0,
					nextAttemptAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						MenuSyncOutbox.integrationId,
						MenuSyncOutbox.kind,
						MenuSyncOutbox.entityType,
						MenuSyncOutbox.entityId,
					],
					targetWhere: sql`${MenuSyncOutbox.status} = 'queued'`,
					set: {
						payload,
						updatedAt: now,
						nextAttemptAt: input.immediate
							? now
							: sql`CASE WHEN ${MenuSyncOutbox.attempts} > 0 THEN ${MenuSyncOutbox.nextAttemptAt} ELSE ${now.getTime()} END`,
					},
				})

			queuedIntegrationIds.push(integration.id)
			if (!earliestWakeAt || now < earliestWakeAt) {
				earliestWakeAt = now
			}
		}

		if (earliestWakeAt) {
			void wakeMenuSyncAt(earliestWakeAt)
		}
		return {
			queued: queuedIntegrationIds.length,
			integrationIds: queuedIntegrationIds,
		}
	}

	if (input.kind === 'holiday_hours') {
		if (!(await isStoreSettingsEnabled(organizationId))) {
			return { queued: 0, integrationIds: [] }
		}
		for (const integration of candidates) {
			if (providerKind[integration.providerName] !== 'delivery') continue
			if (parsePosConfig(integration.config).store?.holidaySync !== true) {
				continue
			}
			await db
				.insert(MenuSyncOutbox)
				.values({
					organizationId,
					integrationId: integration.id,
					kind: 'holiday_hours',
					entityType: 'all',
					entityId: '',
					payload: null,
					status: 'queued',
					attempts: 0,
					nextAttemptAt: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: [
						MenuSyncOutbox.integrationId,
						MenuSyncOutbox.kind,
						MenuSyncOutbox.entityType,
						MenuSyncOutbox.entityId,
					],
					targetWhere: sql`${MenuSyncOutbox.status} = 'queued'`,
					set: {
						updatedAt: now,
						nextAttemptAt: input.immediate
							? now
							: sql`CASE WHEN ${MenuSyncOutbox.attempts} > 0 THEN ${MenuSyncOutbox.nextAttemptAt} ELSE ${now.getTime()} END`,
					},
				})
			queuedIntegrationIds.push(integration.id)
			if (!earliestWakeAt || now < earliestWakeAt) {
				earliestWakeAt = now
			}
		}
		if (earliestWakeAt) {
			void wakeMenuSyncAt(earliestWakeAt)
		}
		return {
			queued: queuedIntegrationIds.length,
			integrationIds: queuedIntegrationIds,
		}
	}

	// kind === 'menu': coalesce onto ('menu', 'all', '') per integration
	const posCandidates = posOwnershipEnabled
		? candidates.filter((c) => providerKind[c.providerName] === 'pos')
		: []
	const posIntegrationLinks = posCandidates.length
		? await db
				.select({
					integrationId: OrganizationMenuPosLink.integrationId,
					overriddenFields: OrganizationMenuPosLink.overriddenFields,
				})
				.from(OrganizationMenuPosLink)
				.where(
					and(
						eq(OrganizationMenuPosLink.organizationId, organizationId),
						inArray(
							OrganizationMenuPosLink.integrationId,
							posCandidates.map((c) => c.id),
						),
					),
				)
		: []
	const hasOverrideByIntegration = new Set<string>()
	for (const row of posIntegrationLinks) {
		if (parseOverriddenFields(row.overriddenFields).length > 0) {
			hasOverrideByIntegration.add(row.integrationId)
		}
	}

	for (const integration of candidates) {
		const provider = integration.providerName
		// Read-only platforms (Toast: writeMode === 'none') receive availability ONLY.
		if (
			providerWriteMode[provider] === 'none' ||
			writeFields[provider].length === 0
		) {
			continue
		}

		if (posOwnershipEnabled && providerKind[provider] === 'pos') {
			const ownership = resolveFieldOwnership(provider, integration.config)
			const hasMenuzaOwnedWritableField = writeFields[provider].some((field) =>
				isPosOwnershipField(field) ? ownership[field] === 'menuza' : false,
			)
			if (
				!hasMenuzaOwnedWritableField &&
				!hasOverrideByIntegration.has(integration.id) &&
				ownership.name === 'pos' &&
				ownership.price === 'pos'
			) {
				continue
			}
		}

		const parsedConfig = parsePosConfig(integration.config)
		const lastPushMs = parsedConfig.syncHealth?.lastMenuPushAt
			? Date.parse(parsedConfig.syncHealth.lastMenuPushAt)
			: Number.NaN
		const earliestAllowedMs =
			!input.immediate && !Number.isNaN(lastPushMs)
				? lastPushMs + MENU_PUSH_MIN_INTERVAL_MS
				: now.getTime()
		const nextAttemptAt = new Date(Math.max(now.getTime(), earliestAllowedMs))
		const payloadObj: { menuId?: string; immediate?: boolean } = {}
		if (input.menuId) payloadObj.menuId = input.menuId
		if (input.immediate) payloadObj.immediate = true
		const payload =
			Object.keys(payloadObj).length > 0 ? JSON.stringify(payloadObj) : null

		await db
			.insert(MenuSyncOutbox)
			.values({
				organizationId,
				integrationId: integration.id,
				kind: 'menu',
				entityType: 'all',
				entityId: '',
				payload,
				status: 'queued',
				attempts: 0,
				nextAttemptAt,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					MenuSyncOutbox.integrationId,
					MenuSyncOutbox.kind,
					MenuSyncOutbox.entityType,
					MenuSyncOutbox.entityId,
				],
				targetWhere: sql`${MenuSyncOutbox.status} = 'queued'`,
				set: {
					...(payload !== null ? { payload } : {}),
					updatedAt: now,
					nextAttemptAt: input.immediate
						? now
						: sql`CASE WHEN ${MenuSyncOutbox.attempts} > 0 THEN MAX(${MenuSyncOutbox.nextAttemptAt}, ${nextAttemptAt.getTime()}) ELSE ${nextAttemptAt.getTime()} END`,
				},
			})

		queuedIntegrationIds.push(integration.id)
		if (!earliestWakeAt || nextAttemptAt < earliestWakeAt) {
			earliestWakeAt = nextAttemptAt
		}
	}

	if (earliestWakeAt) {
		void wakeMenuSyncAt(earliestWakeAt)
	}
	return {
		queued: queuedIntegrationIds.length,
		integrationIds: queuedIntegrationIds,
	}
}

/**
 * Safe fire-and-forget wrapper around `enqueueMenuSync` for menu write actions
 * so outbox errors never abort a restaurant's menu save.
 */
export async function safeEnqueueMenuSync(
	organizationId: string,
	input: EnqueueMenuSyncInput,
): Promise<void> {
	try {
		await enqueueMenuSync(organizationId, input)
	} catch (error) {
		console.error('Failed to enqueue menu sync', {
			organizationId,
			kind: input.kind,
			reason: error instanceof Error ? error.message : 'unknown',
		})
	}
}

async function resolveManagerRecipientsForSyncFailure(
	organizationId: string,
	locationId: string | null,
	now: Date,
): Promise<Array<{ userId: string; email: string }>> {
	const fromPermissions = await resolveAlertMembers({
		organizationId,
		permission: ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		locationId,
		now,
	})
	const byUserId = new Map<string, { userId: string; email: string }>()
	for (const member of fromPermissions) {
		byUserId.set(member.userId, {
			userId: member.userId,
			email: member.email,
		})
	}

	// Also include active, unbanned members with built-in `org_role_admin` so
	// minimal test fixtures without role-permission join seeds still receive alerts.
	const adminRows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				eq(UserOrganization.organizationRoleId, 'org_role_admin'),
			),
		)

	for (const row of adminRows) {
		if (byUserId.has(row.userId) || !row.email) continue
		const banned =
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		if (banned) continue
		if (locationId !== null) {
			const scope = await resolveMemberLocationIds(row.userId, organizationId)
			if (scope !== null && !scope.includes(locationId)) continue
		}
		byUserId.set(row.userId, { userId: row.userId, email: row.email })
	}

	return [...byUserId.values()].sort((a, b) => a.userId.localeCompare(b.userId))
}

async function notifyManagersOfSyncFailure(input: {
	integration: typeof Integration.$inferSelect & { providerName: PosProvider }
	firstFailedAt: Date
	lastError: string
	now: Date
}): Promise<number> {
	const { integration, firstFailedAt, lastError, now } = input
	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
		})
		.from(Organization)
		.where(eq(Organization.id, integration.organizationId))
		.limit(1)
	if (!organization) return 0

	const locale = await orgDefaultLocale(organization.id)
	let locationName: string | null = null
	if (integration.organizationLocationId) {
		const [loc] = await db
			.select({ name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, integration.organizationLocationId),
					eq(OrganizationLocation.organizationId, organization.id),
				),
			)
			.limit(1)
		if (loc) {
			locationName = displayLocationName(loc.name, null, locale)
		}
	}

	const managers = await resolveManagerRecipientsForSyncFailure(
		organization.id,
		integration.organizationLocationId,
		now,
	)
	if (managers.length === 0) return 0

	const providerLabel = providerNames[integration.providerName]
	const entityId = `${integration.id}:${firstFailedAt.getTime()}`
	const payload = {
		orgSlug: organization.slug,
		integrationId: integration.id,
		providerName: integration.providerName,
		providerLabel,
		locationId: integration.organizationLocationId,
		locationName,
		firstFailedAt: firstFailedAt.toISOString(),
		lastError,
	}

	const pushEnabled = await isOperatorPushEnabled(organization.id)
	const baseUrl = String(ENV.BASE_URL ?? process.env.BASE_URL ?? '').replace(
		/\/$/,
		'',
	)
	const actionPath = menuSyncAlertPath(integration.organizationLocationId)
	const url = baseUrl ? `${baseUrl}/${organization.slug}${actionPath}` : null

	let notified = 0
	for (const manager of managers) {
		const [inserted] = await db
			.insert(Notification)
			.values({
				userId: manager.userId,
				organizationId: organization.id,
				type: MENU_SYNC_FAILING_NOTIFICATION_TYPE,
				entityId,
				payload: JSON.stringify(payload),
				isRead: false,
				isSeen: false,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (!inserted) continue
		notified++

		const policy = await applyAlertPolicy({
			userId: manager.userId,
			organizationId: organization.id,
			locationId: integration.organizationLocationId,
			kind: MENU_SYNC_FAILING_NOTIFICATION_TYPE,
			entityId,
			critical: false,
			notificationId: inserted.id,
			channelsOwed: pushEnabled ? ['push'] : [],
			now: now.getTime(),
		})
		if (policy.decision.outcome === 'held') {
			void wakeOperatorAlertsAt(new Date(policy.decision.until))
		}
		if (
			pushEnabled &&
			!policy.replay &&
			(policy.decision.outcome === 'deliver' ||
				policy.decision.outcome === 'critical')
		) {
			const sent = await sendPushToUser({
				userId: manager.userId,
				notificationId: inserted.id,
				kind: MENU_SYNC_FAILING_NOTIFICATION_TYPE,
				url,
				copyFor: (pushLocale) =>
					pushLocale === 'ar'
						? {
								title: `تعذرت مزامنة القائمة مع ${providerLabel}`,
								body: locationName
									? `فشلت التحديثات لمدة ٢٤ ساعة (${locationName}). افتح التكاملات للمراجعة.`
									: 'فشلت التحديثات لمدة ٢٤ ساعة. افتح التكاملات للمراجعة.',
							}
						: {
								title: `${providerLabel} menu sync failing`,
								body: locationName
									? `Updates have failed for 24 hours (${locationName}). Open Integrations to reconnect.`
									: 'Updates have failed for 24 hours. Open Integrations to reconnect.',
							},
			})
			await recordDeliveredChannels(
				policy.logId,
				sent > 0 ? ['in_app', 'push'] : ['in_app'],
				{ notificationId: inserted.id },
			)
		} else {
			await recordDeliveredChannels(policy.logId, ['in_app'], {
				notificationId: inserted.id,
			})
		}
	}
	return notified
}

async function handleSyncOutboxFailure(input: {
	row: typeof MenuSyncOutbox.$inferSelect
	integration: typeof Integration.$inferSelect & { providerName: PosProvider }
	error: unknown
	now: Date
}): Promise<{ alerted: number }> {
	const { row, integration, error, now } = input
	const attempts = row.attempts + 1
	const retryAfterSeconds =
		error instanceof PosError && error.status === 429
			? error.retryAfterSeconds
			: undefined
	const delayMs = computeMenuSyncBackoffMs(attempts, retryAfterSeconds)
	const nextAttemptAt = new Date(now.getTime() + delayMs)
	const sanitizedError = sanitizeIntegrationErrorMessage(error)

	const existingConfig = parsePosConfig(integration.config)
	const existingFirstMs = existingConfig.syncHealth?.firstFailedAt
		? Date.parse(existingConfig.syncHealth.firstFailedAt)
		: Number.NaN
	const candidateFirstFailedAt =
		row.firstFailedAt ??
		(!Number.isNaN(existingFirstMs) ? new Date(existingFirstMs) : now)
	const firstFailedAt =
		!Number.isNaN(existingFirstMs) &&
		existingFirstMs < candidateFirstFailedAt.getTime()
			? new Date(existingFirstMs)
			: candidateFirstFailedAt

	await db
		.update(MenuSyncOutbox)
		.set({
			status: 'queued',
			attempts,
			firstFailedAt,
			nextAttemptAt,
			lastError: sanitizedError,
			updatedAt: now,
		})
		.where(eq(MenuSyncOutbox.id, row.id))

	let alertedAt = existingConfig.syncHealth?.alertedAt ?? null
	let alerted = 0

	const draftConfig = mergePosSyncHealth(integration.config, {
		firstFailedAt: firstFailedAt.toISOString(),
		lastFailedAt: now.toISOString(),
		lastError: sanitizedError,
		alertedAt,
	})

	if (isSyncFailing(draftConfig, now) && !alertedAt) {
		alerted = await notifyManagersOfSyncFailure({
			integration,
			firstFailedAt,
			lastError: sanitizedError,
			now,
		})
		alertedAt = now.toISOString()
	}

	const finalConfig = mergePosSyncHealth(integration.config, {
		firstFailedAt: firstFailedAt.toISOString(),
		lastFailedAt: now.toISOString(),
		lastError: sanitizedError,
		alertedAt,
	})
	await db
		.update(Integration)
		.set({ config: finalConfig, updatedAt: now })
		.where(eq(Integration.id, integration.id))

	if (delayMs < MENU_PUSH_MIN_INTERVAL_MS) {
		void wakeMenuSyncAt(nextAttemptAt)
	}

	return { alerted }
}

async function enqueueNightlyMenuSyncs(
	options: DrainMenuSyncOptions | undefined,
	now: Date,
): Promise<number> {
	const conditions = [eq(Integration.isActive, true)]
	if (options?.organizationId) {
		conditions.push(eq(Integration.organizationId, options.organizationId))
	}
	if (options?.integrationId) {
		conditions.push(eq(Integration.id, options.integrationId))
	}
	const rows = await db
		.select()
		.from(Integration)
		.where(and(...conditions))

	const deliveryMenuRows = rows.filter(
		(row): row is typeof row & { providerName: PosProvider } =>
			isEligibleIntegrationConnection(row) &&
			providerWriteMode[row.providerName] === 'menu',
	)
	if (deliveryMenuRows.length === 0) return 0

	const enabledByOrg = new Map<string, boolean>()
	const storeSettingsByOrg = new Map<string, boolean>()
	let queued = 0
	for (const integration of deliveryMenuRows) {
		let enabled = enabledByOrg.get(integration.organizationId)
		if (enabled === undefined) {
			enabled = await isAutoSyncEnabled(integration.organizationId)
			enabledByOrg.set(integration.organizationId, enabled)
		}
		if (!enabled) continue

		await db
			.insert(MenuSyncOutbox)
			.values({
				organizationId: integration.organizationId,
				integrationId: integration.id,
				kind: 'menu',
				entityType: 'all',
				entityId: '',
				payload: null,
				status: 'queued',
				attempts: 0,
				nextAttemptAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					MenuSyncOutbox.integrationId,
					MenuSyncOutbox.kind,
					MenuSyncOutbox.entityType,
					MenuSyncOutbox.entityId,
				],
				targetWhere: sql`${MenuSyncOutbox.status} = 'queued'`,
				set: {
					nextAttemptAt: now,
					updatedAt: now,
				},
			})
		queued++

		if (
			providerKind[integration.providerName] === 'delivery' &&
			parsePosConfig(integration.config).store?.holidaySync === true
		) {
			let storeEnabled = storeSettingsByOrg.get(integration.organizationId)
			if (storeEnabled === undefined) {
				storeEnabled = await isStoreSettingsEnabled(integration.organizationId)
				storeSettingsByOrg.set(integration.organizationId, storeEnabled)
			}
			if (storeEnabled) {
				await db
					.insert(MenuSyncOutbox)
					.values({
						organizationId: integration.organizationId,
						integrationId: integration.id,
						kind: 'holiday_hours',
						entityType: 'all',
						entityId: '',
						payload: null,
						status: 'queued',
						attempts: 0,
						nextAttemptAt: now,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [
							MenuSyncOutbox.integrationId,
							MenuSyncOutbox.kind,
							MenuSyncOutbox.entityType,
							MenuSyncOutbox.entityId,
						],
						targetWhere: sql`${MenuSyncOutbox.status} = 'queued'`,
						set: {
							nextAttemptAt: now,
							updatedAt: now,
						},
					})
				queued++
			}
		}
	}
	return queued
}

function parseAvailabilityPayload(raw: string | null): boolean | undefined {
	if (!raw) return undefined
	try {
		const parsed = JSON.parse(raw) as { available?: unknown }
		return typeof parsed.available === 'boolean' ? parsed.available : undefined
	} catch {
		return undefined
	}
}

function parseMenuPayload(raw: string | null): {
	menuId?: string
	immediate?: boolean
} {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw) as { menuId?: unknown; immediate?: unknown }
		return {
			...(typeof parsed.menuId === 'string' && parsed.menuId.trim()
				? { menuId: parsed.menuId.trim() }
				: {}),
			...(parsed.immediate === true ? { immediate: true } : {}),
		}
	} catch {
		return {}
	}
}

async function resolveTargetMenuIdForIntegration(
	organizationId: string,
	locationId: string | null,
	preferredMenuId?: string,
): Promise<string | null> {
	const menus = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.organizationId, organizationId))
		.orderBy(asc(OrganizationMenu.position))
	if (menus.length === 0) return null

	let disabledMenuIds = new Set<string>()
	if (locationId) {
		const overrides = await db
			.select({
				entityId: OrganizationMenuLocationOverride.entityId,
				isEnabled: OrganizationMenuLocationOverride.isEnabled,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.locationId, locationId),
					eq(OrganizationMenuLocationOverride.entityType, 'menu'),
				),
			)
		disabledMenuIds = new Set(
			overrides.filter((ov) => ov.isEnabled === false).map((ov) => ov.entityId),
		)
	}

	if (
		preferredMenuId &&
		menus.some((m) => m.id === preferredMenuId) &&
		!disabledMenuIds.has(preferredMenuId)
	) {
		return preferredMenuId
	}
	const firstEnabled = menus.find((m) => !disabledMenuIds.has(m.id))
	return firstEnabled?.id ?? menus[0]!.id
}

/**
 * Drains due rows from `MenuSyncOutbox` (#74).
 *
 * Always processes due `availability` rows BEFORE and independently of `menu`
 * rows so a failing full-menu push never delays sold-out updates.
 */
export async function drainMenuSyncOutbox(
	options?: DrainMenuSyncOptions,
): Promise<DrainMenuSyncResult> {
	const now = options?.now ?? new Date()
	const pauseReconcile = await reconcileDeliveryPauses({
		now,
		organizationId: options?.organizationId,
		integrationId: options?.integrationId,
	})

	if (!isMenuAutoSyncSwitchOn()) {
		return {
			skipped: 'kill_switch',
			nightlyQueued: 0,
			availabilitySent: 0,
			availabilityFailed: 0,
			menuSent: 0,
			menuFailed: 0,
			alerted: 0,
			deliveryPausesResumed: pauseReconcile.resumed,
			deliveryPausesRenewed: pauseReconcile.renewed,
		}
	}

	const nightlyQueued = options?.nightly
		? await enqueueNightlyMenuSyncs(options, now)
		: 0

	const buildDueQuery = (kind: 'availability' | 'menu' | 'holiday_hours') => {
		const conditions = [
			eq(MenuSyncOutbox.status, 'queued'),
			eq(MenuSyncOutbox.kind, kind),
			lte(MenuSyncOutbox.nextAttemptAt, now),
		]
		if (options?.organizationId) {
			conditions.push(eq(MenuSyncOutbox.organizationId, options.organizationId))
		}
		if (options?.integrationId) {
			conditions.push(eq(MenuSyncOutbox.integrationId, options.integrationId))
		}
		return db
			.select()
			.from(MenuSyncOutbox)
			.where(and(...conditions))
			.orderBy(asc(MenuSyncOutbox.nextAttemptAt), asc(MenuSyncOutbox.createdAt))
	}

	let availabilitySent = 0
	let availabilityFailed = 0
	let menuSent = 0
	let menuFailed = 0
	let holidayHoursSent = 0
	let holidayHoursFailed = 0
	let alerted = 0

	// 1. High-priority: availability updates FIRST
	const dueAvailability = await buildDueQuery('availability')
	for (const row of dueAvailability) {
		if (!(await isAutoSyncEnabled(row.organizationId))) continue

		const [integration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, row.integrationId))
			.limit(1)
		if (!integration || !isEligibleIntegrationConnection(integration)) {
			await db
				.update(MenuSyncOutbox)
				.set({
					status: 'failed',
					lastError: 'Integration inactive or disconnected.',
					updatedAt: now,
				})
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		if (row.entityType !== 'item' && row.entityType !== 'modifier_option') {
			await db
				.update(MenuSyncOutbox)
				.set({
					status: 'failed',
					lastError: 'Invalid entityType',
					updatedAt: now,
				})
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		const parsedAvailable = parseAvailabilityPayload(row.payload)
		const available =
			parsedAvailable !== undefined
				? parsedAvailable
				: await resolveEffectiveEntityAvailability(
						row.organizationId,
						row.entityType,
						row.entityId,
						integration.organizationLocationId,
						now,
					)
		if (available === null) {
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		const respectPosOwnership = await isPosOwnershipEnabled(row.organizationId)
		try {
			await pushAvailability(integration.id, row.organizationId, {
				entityType: row.entityType,
				entityId: row.entityId,
				available,
				respectPosOwnership,
				now,
			})
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			availabilitySent++
		} catch (error) {
			// Ownership refusal (409 Availability is managed in <POS>) is a policy skip, not an outage.
			if (
				error instanceof PosError &&
				error.status === 409 &&
				error.message.includes('managed in')
			) {
				await db
					.update(MenuSyncOutbox)
					.set({ status: 'sent', lastError: null, updatedAt: now })
					.where(eq(MenuSyncOutbox.id, row.id))
				continue
			}
			availabilityFailed++
			const failureResult = await handleSyncOutboxFailure({
				row,
				integration,
				error,
				now,
			})
			alerted += failureResult.alerted
		}
	}

	// 2. Full menu pushes SECOND (completely independent of availability)
	const dueMenu = await buildDueQuery('menu')
	for (const row of dueMenu) {
		if (!(await isAutoSyncEnabled(row.organizationId))) continue

		const [integration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, row.integrationId))
			.limit(1)
		if (!integration || !isEligibleIntegrationConnection(integration)) {
			await db
				.update(MenuSyncOutbox)
				.set({
					status: 'failed',
					lastError: 'Integration inactive or disconnected.',
					updatedAt: now,
				})
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		if (providerWriteMode[integration.providerName] === 'none') {
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		const menuPayload = parseMenuPayload(row.payload)
		if (!options?.nightly && !menuPayload.immediate && row.attempts === 0) {
			const parsedConfig = parsePosConfig(integration.config)
			const lastPushMs = parsedConfig.syncHealth?.lastMenuPushAt
				? Date.parse(parsedConfig.syncHealth.lastMenuPushAt)
				: Number.NaN
			if (
				!Number.isNaN(lastPushMs) &&
				now.getTime() - lastPushMs < MENU_PUSH_MIN_INTERVAL_MS
			) {
				const throttledUntil = new Date(lastPushMs + MENU_PUSH_MIN_INTERVAL_MS)
				await db
					.update(MenuSyncOutbox)
					.set({ nextAttemptAt: throttledUntil, updatedAt: now })
					.where(eq(MenuSyncOutbox.id, row.id))
				void wakeMenuSyncAt(throttledUntil)
				continue
			}
		}

		const storeMenuIds =
			providerKind[integration.providerName] === 'delivery'
				? (parsePosConfig(integration.config).store?.menuIds ?? [])
				: []

		const targetMenuArg: string | string[] | null =
			storeMenuIds.length > 0
				? storeMenuIds
				: await resolveTargetMenuIdForIntegration(
						row.organizationId,
						integration.organizationLocationId,
						menuPayload.menuId,
					)
		if (!targetMenuArg) {
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		const respectPosOwnership = await isPosOwnershipEnabled(row.organizationId)
		try {
			await pushMenu(integration.id, row.organizationId, targetMenuArg, {
				locationId: integration.organizationLocationId,
				respectPosOwnership,
				now,
			})
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			menuSent++
		} catch (error) {
			menuFailed++
			const failureResult = await handleSyncOutboxFailure({
				row,
				integration,
				error,
				now,
			})
			alerted += failureResult.alerted
		}
	}

	// 3. Holiday hours pushes
	const dueHolidayHours = await buildDueQuery('holiday_hours')
	for (const row of dueHolidayHours) {
		if (!(await isAutoSyncEnabled(row.organizationId))) continue
		if (!(await isStoreSettingsEnabled(row.organizationId))) continue

		const [integration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, row.integrationId))
			.limit(1)
		if (
			!integration ||
			!isEligibleIntegrationConnection(integration) ||
			providerKind[integration.providerName] !== 'delivery'
		) {
			await db
				.update(MenuSyncOutbox)
				.set({
					status: 'failed',
					lastError: 'Integration inactive or disconnected.',
					updatedAt: now,
				})
				.where(eq(MenuSyncOutbox.id, row.id))
			continue
		}

		try {
			await pushHolidayHours(integration.id, row.organizationId, { now })
			await db
				.update(MenuSyncOutbox)
				.set({ status: 'sent', lastError: null, updatedAt: now })
				.where(eq(MenuSyncOutbox.id, row.id))
			holidayHoursSent++
		} catch (error) {
			holidayHoursFailed++
			const failureResult = await handleSyncOutboxFailure({
				row,
				integration,
				error,
				now,
			})
			alerted += failureResult.alerted
		}
	}

	return {
		nightlyQueued,
		availabilitySent,
		availabilityFailed,
		menuSent,
		menuFailed,
		holidayHoursSent,
		holidayHoursFailed,
		alerted,
		deliveryPausesResumed: pauseReconcile.resumed,
		deliveryPausesRenewed: pauseReconcile.renewed,
	}
}
