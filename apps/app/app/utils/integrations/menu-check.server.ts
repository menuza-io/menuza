import {
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	Integration,
	IntegrationLog,
	MenuSyncOutbox,
	OrganizationMenu,
	OrganizationMenuLocationOverride,
	OrganizationMenuPosLink,
} from '@repo/database'
import {
	compareStoreMenu,
	integrationManager,
	isDoorDashStoreVerified,
	isPosIntegrationProvider,
	isPosProvider,
	loadMenusForSync,
	mergePosMenuCheckState,
	parseOverriddenFields,
	parsePosConfig,
	PosError,
	posOwnershipFields,
	providerKind,
	providerNames,
	providerRegistry,
	pushMenu,
	readFields,
	resolveFieldOwnership,
	type MenuDiff,
	type PosCompareItemOwnership,
	type PosCompareOwnership,
	type PosMenuCheckState,
	type PosOwnershipField,
	type PosProvider,
	type RemoteItem,
} from '@repo/integrations'
import {
	isAutoSyncEnabled,
	isMenuCheckEnabled,
	isPosOwnershipEnabled,
} from '#app/utils/integrations/flags.server.ts'
import {
	drainMenuSyncOutbox,
	enqueueMenuSync,
} from '#app/utils/menu/menu-sync.server.ts'

export const MANUAL_MENU_CHECK_DAILY_LIMIT = 3
export const MENU_CHECK_READ_ERROR_MESSAGE = 'Could not check'

export type DeliveryMenuCheckTrigger = 'auto' | 'manual'

export type DeliveryMenuCheckSummary = {
	lastCheckedAt: string | null
	lastAttemptAt: string | null
	lastStatus: 'match' | 'diff' | 'error' | null
	diffCount: number
	posChangedCount: number
	lastError: string | null
	manualChecksToday: number
	manualChecksLimit: number
	diffs: MenuDiff[]
}

export type RunDeliveryMenuCheckResult =
	| {
			ok: true
			skipped?: 'already_checked_today'
			menuCheck: PosMenuCheckState
			diffs: MenuDiff[]
			errorDiffCount: number
			posChangedCount: number
			totalDiffCount: number
	  }
	| {
			ok: false
			status: number
			error: string
			message?: string
			menuCheck?: PosMenuCheckState
	  }

export type RunDailyDeliveryMenuChecksResult = {
	checked: number
	matched: number
	differing: number
	failed: number
	skipped: number
}

export type FixDeliveryMenuResult =
	| {
			ok: true
			mode: 'direct' | 'queued'
			pushed?: number
	  }
	| {
			ok: false
			status: number
			error: string
	  }

function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10)
}

function isEligibleDeliveryIntegration(
	integration: typeof Integration.$inferSelect,
): integration is typeof Integration.$inferSelect & {
	providerName: PosProvider
} {
	if (!integration.isActive) return false
	if (!isPosProvider(integration.providerName)) return false
	if (providerKind[integration.providerName] !== 'delivery') return false
	if (
		integration.providerName === 'doordash' &&
		parsePosConfig(integration.config).environment === 'live' &&
		!isDoorDashStoreVerified(integration.config)
	) {
		return false
	}
	return true
}

async function resolveExpectedMenuIds(
	organizationId: string,
	locationId: string | null,
	configuredMenuIds: readonly string[],
): Promise<string[]> {
	const orgMenus = await db
		.select({
			id: OrganizationMenu.id,
			availabilityStatus: OrganizationMenu.availabilityStatus,
		})
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.organizationId, organizationId))
		.orderBy(asc(OrganizationMenu.position))

	if (orgMenus.length === 0) return []
	const existingById = new Map(orgMenus.map((m) => [m.id, m]))

	if (configuredMenuIds.length > 0) {
		return configuredMenuIds.filter((id) => existingById.has(id))
	}

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
			overrides
				.filter((row) => row.isEnabled === false)
				.map((row) => row.entityId),
		)
	}

	return orgMenus
		.filter(
			(menu) =>
				menu.availabilityStatus !== 'hidden' && !disabledMenuIds.has(menu.id),
		)
		.map((menu) => menu.id)
}

async function loadPosOwnershipContext(
	organizationId: string,
	locationId: string | null,
	deliveryProvider: PosProvider,
): Promise<PosCompareOwnership | undefined> {
	const activeIntegrations = await db
		.select({
			id: Integration.id,
			providerName: Integration.providerName,
			organizationLocationId: Integration.organizationLocationId,
			config: Integration.config,
		})
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
			),
		)

	const posIntegrations = activeIntegrations.filter((row) => {
		if (!isPosProvider(row.providerName)) return false
		if (providerKind[row.providerName] !== 'pos') return false
		if (
			locationId &&
			row.organizationLocationId &&
			row.organizationLocationId !== locationId
		) {
			return false
		}
		return true
	})

	if (posIntegrations.length === 0) return undefined

	const ownershipByIntegrationId = new Map<string, Set<PosOwnershipField>>()
	let managedByPos = false
	const defaultOwnedFields = new Set<PosOwnershipField>()

	for (const pos of posIntegrations) {
		const resolved = resolveFieldOwnership(
			pos.providerName as PosProvider,
			pos.config,
		)
		const owned = new Set<PosOwnershipField>(
			posOwnershipFields.filter((field) => resolved[field] === 'pos'),
		)
		ownershipByIntegrationId.set(pos.id, owned)

		const parsed = parsePosConfig(pos.config)
		if (parsed.feedsDelivery?.includes(deliveryProvider)) {
			managedByPos = true
			for (const field of owned) {
				defaultOwnedFields.add(field)
			}
		}
	}

	const links = await db
		.select({
			integrationId: OrganizationMenuPosLink.integrationId,
			localId: OrganizationMenuPosLink.localId,
			overriddenFields: OrganizationMenuPosLink.overriddenFields,
		})
		.from(OrganizationMenuPosLink)
		.where(
			and(
				eq(OrganizationMenuPosLink.organizationId, organizationId),
				eq(OrganizationMenuPosLink.entityType, 'item'),
				inArray(
					OrganizationMenuPosLink.integrationId,
					posIntegrations.map((p) => p.id),
				),
			),
		)

	if (links.length === 0 && !managedByPos) return undefined

	const itemsById = new Map<string, PosCompareItemOwnership>()
	for (const link of links) {
		const posOwned = ownershipByIntegrationId.get(link.integrationId)
		if (!posOwned) continue
		const overridden = new Set(parseOverriddenFields(link.overriddenFields))
		const effectiveOwned = [...posOwned].filter(
			(field) => !overridden.has(field),
		)
		const existing = itemsById.get(link.localId)
		if (existing) {
			const mergedOwned = new Set([
				...(existing.ownedFields ?? []),
				...effectiveOwned,
			])
			itemsById.set(link.localId, {
				posLinked: true,
				ownedFields: [...mergedOwned],
				overriddenFields: [],
			})
		} else {
			itemsById.set(link.localId, {
				posLinked: true,
				ownedFields: effectiveOwned,
				overriddenFields: [...overridden],
			})
		}
	}

	return {
		managedByPos,
		...(defaultOwnedFields.size > 0
			? { ownedFields: [...defaultOwnedFields] }
			: {}),
		itemsById,
	}
}

/**
 * Parses `diffs` stored on the latest successful `menu_check` `IntegrationLog`.
 */
export function parseStoredMenuCheckDiffs(
	rawRequestData: string | null | undefined,
): MenuDiff[] {
	if (!rawRequestData) return []
	try {
		const parsed = JSON.parse(rawRequestData) as { diffs?: unknown }
		if (!Array.isArray(parsed.diffs)) return []
		return parsed.diffs.filter(
			(entry): entry is MenuDiff =>
				Boolean(entry) &&
				typeof entry === 'object' &&
				typeof (entry as MenuDiff).kind === 'string' &&
				typeof (entry as MenuDiff).dishName === 'string',
		)
	} catch {
		return []
	}
}

/**
 * Loads the latest stored menu-check summary and diffs for a set of
 * delivery integration IDs (from `Integration.config.menuCheck` and the
 * latest successful `menu_check` `IntegrationLog` entry).
 */
export async function loadDeliveryMenuCheckSummaries(
	integrations: ReadonlyArray<typeof Integration.$inferSelect>,
	now = new Date(),
): Promise<Map<string, DeliveryMenuCheckSummary>> {
	const result = new Map<string, DeliveryMenuCheckSummary>()
	if (integrations.length === 0) return result

	const today = utcDayKey(now)
	const ids = integrations.map((i) => i.id)
	const logs = await db
		.select({
			integrationId: IntegrationLog.integrationId,
			requestData: IntegrationLog.requestData,
		})
		.from(IntegrationLog)
		.where(
			and(
				inArray(IntegrationLog.integrationId, ids),
				eq(IntegrationLog.action, 'menu_check'),
				eq(IntegrationLog.status, 'success'),
			),
		)
		.orderBy(desc(IntegrationLog.createdAt), desc(IntegrationLog.id))

	const latestDiffsByIntegration = new Map<string, MenuDiff[]>()
	for (const log of logs) {
		if (latestDiffsByIntegration.has(log.integrationId)) continue
		latestDiffsByIntegration.set(
			log.integrationId,
			parseStoredMenuCheckDiffs(log.requestData),
		)
	}

	for (const integration of integrations) {
		const menuCheck = parsePosConfig(integration.config).menuCheck
		const manualChecksToday =
			menuCheck?.manualChecksDate === today ? menuCheck.manualChecksCount : 0
		result.set(integration.id, {
			lastCheckedAt: menuCheck?.lastCheckedAt ?? null,
			lastAttemptAt: menuCheck?.lastAttemptAt ?? null,
			lastStatus: menuCheck
				? menuCheck.lastError
					? 'error'
					: menuCheck.lastCheckedAt
						? menuCheck.lastStatus
						: null
				: null,
			diffCount: menuCheck?.diffCount ?? 0,
			posChangedCount: menuCheck?.posChangedCount ?? 0,
			lastError: menuCheck?.lastError ?? null,
			manualChecksToday,
			manualChecksLimit: MANUAL_MENU_CHECK_DAILY_LIMIT,
			diffs:
				menuCheck && (menuCheck.diffCount > 0 || menuCheck.posChangedCount > 0)
					? (latestDiffsByIntegration.get(integration.id) ?? [])
					: [],
		})
	}

	return result
}

/**
 * Runs a menu match check for a single delivery integration (#144).
 *
 * - Gated by `isMenuCheckEnabled(organizationId)`.
 * - Enforces 1 auto check/day and 3 manual checks/day per connection.
 * - On read failure, records `'Could not check'` on `lastAttemptAt`/`lastError`
 *   without clearing the last successful check result.
 * - Never auto-fixes or pushes automatically.
 */
export async function runDeliveryMenuCheck(
	integrationId: string,
	organizationId: string,
	options?: {
		trigger?: DeliveryMenuCheckTrigger
		now?: Date
	},
): Promise<RunDeliveryMenuCheckResult> {
	if (!(await isMenuCheckEnabled(organizationId))) {
		return { ok: false, status: 404, error: 'feature_off' }
	}

	const trigger = options?.trigger ?? 'manual'
	const now = options?.now ?? new Date()
	const today = utcDayKey(now)
	const nowIso = now.toISOString()

	const [integration] = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.id, integrationId),
				eq(Integration.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!integration) {
		return {
			ok: false,
			status: 404,
			error: 'integration_not_found',
			message: 'Integration not found.',
		}
	}
	if (
		!isPosProvider(integration.providerName) ||
		providerKind[integration.providerName] !== 'delivery'
	) {
		return {
			ok: false,
			status: 400,
			error: 'not_delivery_integration',
			message: 'Menu checks apply to delivery platform connections only.',
		}
	}
	if (!integration.isActive) {
		return {
			ok: false,
			status: 400,
			error: 'integration_inactive',
			message: 'Connect this delivery platform before checking its menu.',
		}
	}
	if (
		integration.providerName === 'doordash' &&
		parsePosConfig(integration.config).environment === 'live' &&
		!isDoorDashStoreVerified(integration.config)
	) {
		return {
			ok: false,
			status: 403,
			error: 'doordash_not_verified',
			message:
				'This DoorDash store is not verified for menu sync. Complete DoorDash onboarding first.',
		}
	}

	const providerName = integration.providerName as PosProvider
	const parsedConfig = parsePosConfig(integration.config)
	const existingCheck = parsedConfig.menuCheck

	if (trigger === 'auto') {
		const checkedToday = existingCheck?.lastCheckedAt?.slice(0, 10) === today
		const attemptedToday = existingCheck?.lastAttemptAt?.slice(0, 10) === today
		if (checkedToday || attemptedToday) {
			return {
				ok: true,
				skipped: 'already_checked_today',
				menuCheck: existingCheck ?? {
					lastCheckedAt: null,
					lastAttemptAt: null,
					lastStatus: 'match',
					diffCount: 0,
					posChangedCount: 0,
					lastError: null,
					manualChecksDate: null,
					manualChecksCount: 0,
				},
				diffs: [],
				errorDiffCount: existingCheck?.diffCount ?? 0,
				posChangedCount: existingCheck?.posChangedCount ?? 0,
				totalDiffCount:
					(existingCheck?.diffCount ?? 0) +
					(existingCheck?.posChangedCount ?? 0),
			}
		}
	}

	const manualChecksToday =
		existingCheck?.manualChecksDate === today
			? existingCheck.manualChecksCount
			: 0
	if (
		trigger === 'manual' &&
		manualChecksToday >= MANUAL_MENU_CHECK_DAILY_LIMIT
	) {
		return {
			ok: false,
			status: 429,
			error: 'check_limit_reached',
			message: 'You can run up to 3 manual checks per day for this store.',
			menuCheck: existingCheck,
		}
	}

	const provider = providerRegistry.get(providerName)
	if (!isPosIntegrationProvider(provider)) {
		return {
			ok: false,
			status: 400,
			error: 'unsupported_provider',
			message: `Provider '${providerName}' is not supported.`,
		}
	}

	const manualPatch: Partial<PosMenuCheckState> =
		trigger === 'manual'
			? {
					manualChecksDate: today,
					manualChecksCount: manualChecksToday + 1,
				}
			: {}

	let remoteCatalog
	try {
		remoteCatalog = await provider.readCatalog(integration)
	} catch {
		const nextConfig = mergePosMenuCheckState(integration.config, {
			lastAttemptAt: nowIso,
			lastStatus: 'error',
			lastError: MENU_CHECK_READ_ERROR_MESSAGE,
			...manualPatch,
		})
		await db
			.update(Integration)
			.set({ config: nextConfig, updatedAt: now })
			.where(eq(Integration.id, integration.id))

		await integrationManager.logIntegrationActivity(
			integration.id,
			'menu_check',
			'error',
			{
				provider: providerName,
				trigger,
				attemptedAt: nowIso,
			},
			MENU_CHECK_READ_ERROR_MESSAGE,
		)

		return {
			ok: false,
			status: 502,
			error: 'read_failed',
			message: MENU_CHECK_READ_ERROR_MESSAGE,
			menuCheck: parsePosConfig(nextConfig).menuCheck,
		}
	}

	const expectedMenuIds = await resolveExpectedMenuIds(
		organizationId,
		integration.organizationLocationId,
		parsedConfig.store?.menuIds ?? [],
	)
	const loaded = expectedMenuIds.length
		? await loadMenusForSync(organizationId, expectedMenuIds, {
				locationId: integration.organizationLocationId,
				now,
			})
		: { items: [] as RemoteItem[] }

	const posOwnership = await loadPosOwnershipContext(
		organizationId,
		integration.organizationLocationId,
		providerName,
	)

	const comparison = compareStoreMenu(
		loaded.items,
		remoteCatalog.items,
		readFields[providerName],
		posOwnership,
	)

	const nextStatus = comparison.errorDiffCount > 0 ? 'diff' : 'match'
	const nextConfig = mergePosMenuCheckState(integration.config, {
		lastCheckedAt: nowIso,
		lastAttemptAt: nowIso,
		lastStatus: nextStatus,
		diffCount: comparison.errorDiffCount,
		posChangedCount: comparison.posChangedCount,
		lastError: null,
		...manualPatch,
	})

	await db
		.update(Integration)
		.set({ config: nextConfig, updatedAt: now })
		.where(eq(Integration.id, integration.id))

	await integrationManager.logIntegrationActivity(
		integration.id,
		'menu_check',
		'success',
		{
			provider: providerName,
			trigger,
			checkedAt: nowIso,
			localCount: loaded.items.length,
			remoteCount: remoteCatalog.items.length,
			diffCount: comparison.errorDiffCount,
			posChangedCount: comparison.posChangedCount,
			totalDiffCount: comparison.totalDiffCount,
			truncated: comparison.totalDiffCount > comparison.diffs.length,
			diffs: comparison.diffs,
		},
	)

	return {
		ok: true,
		menuCheck: parsePosConfig(nextConfig).menuCheck!,
		diffs: comparison.diffs,
		errorDiffCount: comparison.errorDiffCount,
		posChangedCount: comparison.posChangedCount,
		totalDiffCount: comparison.totalDiffCount,
	}
}

/**
 * Daily cron sweep (#144): checks every active delivery integration in
 * organizations with `integrations.menu_check` enabled (at most once per day).
 */
export async function runDailyDeliveryMenuChecks(options?: {
	now?: Date
	organizationId?: string
}): Promise<RunDailyDeliveryMenuChecksResult> {
	const now = options?.now ?? new Date()
	const conditions = [eq(Integration.isActive, true)]
	if (options?.organizationId) {
		conditions.push(eq(Integration.organizationId, options.organizationId))
	}

	const rows = await db
		.select()
		.from(Integration)
		.where(and(...conditions))

	const deliveryRows = rows.filter(isEligibleDeliveryIntegration)
	const enabledByOrg = new Map<string, boolean>()

	let checked = 0
	let matched = 0
	let differing = 0
	let failed = 0
	let skipped = 0

	for (const integration of deliveryRows) {
		let enabled = enabledByOrg.get(integration.organizationId)
		if (enabled === undefined) {
			enabled = await isMenuCheckEnabled(integration.organizationId)
			enabledByOrg.set(integration.organizationId, enabled)
		}
		if (!enabled) {
			skipped++
			continue
		}

		const result = await runDeliveryMenuCheck(
			integration.id,
			integration.organizationId,
			{ trigger: 'auto', now },
		)
		if (!result.ok) {
			failed++
			continue
		}
		if (result.skipped) {
			skipped++
			continue
		}
		checked++
		if (result.errorDiffCount > 0) {
			differing++
		} else {
			matched++
		}
	}

	return { checked, matched, differing, failed, skipped }
}

/**
 * Operator-triggered push ("Fix by pushing") to overwrite a mismatched
 * delivery platform menu with Menuza's expected menu through #74 (#144).
 * Never invoked automatically.
 */
export async function fixDeliveryMenuByPushing(
	integrationId: string,
	organizationId: string,
	options?: { now?: Date },
): Promise<FixDeliveryMenuResult> {
	if (!(await isMenuCheckEnabled(organizationId))) {
		return { ok: false, status: 404, error: 'feature_off' }
	}

	const now = options?.now ?? new Date()
	const [integration] = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.id, integrationId),
				eq(Integration.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!integration) {
		return { ok: false, status: 404, error: 'Integration not found.' }
	}
	if (
		!isPosProvider(integration.providerName) ||
		providerKind[integration.providerName] !== 'delivery'
	) {
		return {
			ok: false,
			status: 400,
			error: 'Fix by pushing applies to delivery platform connections only.',
		}
	}
	if (!integration.isActive) {
		return {
			ok: false,
			status: 400,
			error: 'Connect this delivery platform before pushing.',
		}
	}

	const parsedConfig = parsePosConfig(integration.config)
	const storeMenuIds = parsedConfig.store?.menuIds ?? []
	const targetMenuIds = await resolveExpectedMenuIds(
		organizationId,
		integration.organizationLocationId,
		storeMenuIds,
	)
	if (targetMenuIds.length === 0) {
		return {
			ok: false,
			status: 400,
			error: 'Create or select at least one menu before pushing.',
		}
	}

	const respectPosOwnership = await isPosOwnershipEnabled(organizationId)
	const autoSyncOn = await isAutoSyncEnabled(organizationId)

	try {
		if (autoSyncOn) {
			await enqueueMenuSync(organizationId, {
				locationIds: integration.organizationLocationId
					? [integration.organizationLocationId]
					: undefined,
				kind: 'menu',
				entityType: 'all',
				menuId: targetMenuIds[0],
				immediate: true,
				now,
			})

			if (storeMenuIds.length === 0 && targetMenuIds.length > 1) {
				const pushedResult = await pushMenu(
					integration.id,
					organizationId,
					targetMenuIds,
					{
						locationId: integration.organizationLocationId,
						respectPosOwnership,
						now,
					},
				)
				await db
					.update(MenuSyncOutbox)
					.set({ status: 'sent', lastError: null, updatedAt: now })
					.where(
						and(
							eq(MenuSyncOutbox.integrationId, integration.id),
							eq(MenuSyncOutbox.kind, 'menu'),
							eq(MenuSyncOutbox.status, 'queued'),
						),
					)
				await markMenuInSyncAfterPush(integration.id, now)
				return {
					ok: true,
					mode: 'direct',
					pushed: pushedResult.pushed,
				}
			}

			const drained = await drainMenuSyncOutbox({
				organizationId,
				integrationId: integration.id,
				now,
			})
			if (drained.menuFailed > 0) {
				return {
					ok: false,
					status: 502,
					error: `Could not push menu to ${providerNames[integration.providerName]}.`,
				}
			}
			if (drained.menuSent > 0) {
				await markMenuInSyncAfterPush(integration.id, now)
			}
			return {
				ok: true,
				mode: 'queued',
			}
		}

		const result = await pushMenu(
			integration.id,
			organizationId,
			targetMenuIds,
			{
				locationId: integration.organizationLocationId,
				respectPosOwnership,
				now,
			},
		)
		await markMenuInSyncAfterPush(integration.id, now)
		return {
			ok: true,
			mode: 'direct',
			pushed: result.pushed,
		}
	} catch (error) {
		const status =
			error instanceof PosError && error.status >= 400 && error.status < 600
				? error.status
				: 502
		return {
			ok: false,
			status,
			error:
				error instanceof Error
					? error.message
					: 'Could not push menu to delivery platform.',
		}
	}
}

async function markMenuInSyncAfterPush(
	integrationId: string,
	now: Date,
): Promise<void> {
	const [latest] = await db
		.select({ config: Integration.config })
		.from(Integration)
		.where(eq(Integration.id, integrationId))
		.limit(1)
	if (!latest) return
	const nowIso = now.toISOString()
	const nextConfig = mergePosMenuCheckState(latest.config, {
		lastCheckedAt: nowIso,
		lastAttemptAt: nowIso,
		lastStatus: 'match',
		diffCount: 0,
		posChangedCount: 0,
		lastError: null,
	})
	await db
		.update(Integration)
		.set({ config: nextConfig, updatedAt: now })
		.where(eq(Integration.id, integrationId))
}
