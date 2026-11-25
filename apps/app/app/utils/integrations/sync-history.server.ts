import {
	and,
	asc,
	db,
	desc,
	eq,
	Integration,
	IntegrationLog,
	OrganizationMenu,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import {
	importCatalog,
	isPosProvider,
	PosError,
	providerWriteMode,
	pushAvailability,
	pushMenu,
	redactSecrets,
	toSafeSyncErrorMessage,
	writeFields,
} from '@repo/integrations'
import {
	isAutoSyncEnabled,
	isPosOwnershipEnabled,
} from '#app/utils/integrations/flags.server.ts'
import { enqueueMenuSync } from '#app/utils/menu/menu-sync.server.ts'

export type SyncHistoryKind = 'import' | 'push' | 'availability' | 'other'

export type SyncHistoryItemCounts = {
	created?: number
	updated?: number
	skipped?: number
	pushed?: number
	total?: number
	menuId?: string
	menuName?: string
	entityType?: 'item' | 'modifier_option'
	entityId?: string
	available?: boolean
}

export type SyncHistoryRetryPayload =
	| { kind: 'push'; menuId?: string; locationId?: string | null }
	| {
			kind: 'availability'
			entityType: 'item' | 'modifier_option'
			entityId: string
			available: boolean
	  }
	| { kind: 'import'; menuId?: string }

export type SyncHistoryEntryDto = {
	id: string
	action: string
	kind: SyncHistoryKind
	status: 'success' | 'error' | 'pending'
	itemCounts: SyncHistoryItemCounts | null
	errorMessage: string | null
	createdAt: string
	retryable: boolean
	retryPayload: SyncHistoryRetryPayload | null
}

export type SyncHistoryPageResult = {
	integration: {
		id: string
		providerName: string
		locationId: string | null
	}
	entries: SyncHistoryEntryDto[]
	page: number
	pageSize: number
	hasMore: boolean
}

export type RetrySyncResult =
	| {
			ok: true
			mode: 'queued' | 'direct'
			action: string
			pushed?: number
			created?: number
			updated?: number
			skipped?: number
	  }
	| {
			ok: false
			status: number
			error: string
	  }

function classifyActionKind(action: string): SyncHistoryKind {
	switch (action) {
		case 'pos_import':
			return 'import'
		case 'pos_push':
			return 'push'
		case 'pos_availability':
			return 'availability'
		default:
			return 'other'
	}
}

function parseRedactedRequestData(
	raw: string | null,
): Record<string, unknown> | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		return redactSecrets(parsed as Record<string, unknown>)
	} catch {
		return null
	}
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyStringOrUndefined(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function extractItemCounts(
	data: Record<string, unknown> | null,
): SyncHistoryItemCounts | null {
	if (!data) return null
	const created = finiteNumberOrUndefined(data.created)
	const updated = finiteNumberOrUndefined(data.updated)
	const skipped = finiteNumberOrUndefined(data.skipped)
	const pushed =
		finiteNumberOrUndefined(data.pushed) ?? finiteNumberOrUndefined(data.items)
	const total = finiteNumberOrUndefined(data.total)
	const menuId = nonEmptyStringOrUndefined(data.menuId)
	const menuName = nonEmptyStringOrUndefined(data.menuName)
	const entityType =
		data.entityType === 'item' || data.entityType === 'modifier_option'
			? data.entityType
			: undefined
	const entityId = nonEmptyStringOrUndefined(data.entityId)
	const available =
		typeof data.available === 'boolean' ? data.available : undefined

	const counts: SyncHistoryItemCounts = {
		...(created !== undefined ? { created } : {}),
		...(updated !== undefined ? { updated } : {}),
		...(skipped !== undefined ? { skipped } : {}),
		...(pushed !== undefined ? { pushed } : {}),
		...(total !== undefined ? { total } : {}),
		...(menuId ? { menuId } : {}),
		...(menuName ? { menuName } : {}),
		...(entityType ? { entityType } : {}),
		...(entityId ? { entityId } : {}),
		...(available !== undefined ? { available } : {}),
	}
	return Object.keys(counts).length > 0 ? counts : null
}

function buildRetryPayload(
	action: string,
	status: string,
	providerName: string,
	locationId: string | null,
	counts: SyncHistoryItemCounts | null,
): SyncHistoryRetryPayload | null {
	if (status !== 'error' || !isPosProvider(providerName)) return null

	if (action === 'pos_push') {
		if (providerWriteMode[providerName] === 'none') return null
		return {
			kind: 'push',
			...(counts?.menuId ? { menuId: counts.menuId } : {}),
			...(locationId ? { locationId } : {}),
		}
	}

	if (action === 'pos_availability') {
		if (!writeFields[providerName].includes('available')) return null
		if (
			(counts?.entityType === 'item' ||
				counts?.entityType === 'modifier_option') &&
			counts.entityId &&
			typeof counts.available === 'boolean'
		) {
			return {
				kind: 'availability',
				entityType: counts.entityType,
				entityId: counts.entityId,
				available: counts.available,
			}
		}
		return null
	}

	if (action === 'pos_import') {
		return {
			kind: 'import',
			...(counts?.menuId ? { menuId: counts.menuId } : {}),
		}
	}

	return null
}

/**
 * Returns one page of redacted sync history for an organization-owned
 * integration, or `null` when the integration does not belong to `organizationId`.
 * Raw `responseData` is never queried or returned.
 */
export async function listIntegrationSyncHistory(
	organizationId: string,
	integrationId: string,
	options?: {
		page?: number
		failuresOnly?: boolean
		pageSize?: number
	},
): Promise<SyncHistoryPageResult | null> {
	const [integration] = await db
		.select({
			id: Integration.id,
			providerName: Integration.providerName,
			organizationLocationId: Integration.organizationLocationId,
		})
		.from(Integration)
		.where(
			and(
				eq(Integration.id, integrationId),
				eq(Integration.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!integration) return null

	const page = Math.max(1, Math.floor(options?.page ?? 1))
	const pageSize = Math.min(
		100,
		Math.max(1, Math.floor(options?.pageSize ?? 50)),
	)
	const offset = (page - 1) * pageSize

	const conditions = [eq(IntegrationLog.integrationId, integration.id)]
	if (options?.failuresOnly) {
		conditions.push(eq(IntegrationLog.status, 'error'))
	}

	// Never select `responseData`; it is strictly for server-side diagnostics.
	const rows = await db
		.select({
			id: IntegrationLog.id,
			action: IntegrationLog.action,
			status: IntegrationLog.status,
			requestData: IntegrationLog.requestData,
			errorMessage: IntegrationLog.errorMessage,
			createdAt: IntegrationLog.createdAt,
		})
		.from(IntegrationLog)
		.where(and(...conditions))
		.orderBy(desc(IntegrationLog.createdAt), desc(IntegrationLog.id))
		.limit(pageSize + 1)
		.offset(offset)

	const hasMore = rows.length > pageSize
	const pageRows = rows.slice(0, pageSize)

	const entries: SyncHistoryEntryDto[] = pageRows.map((row) => {
		const parsedData = parseRedactedRequestData(row.requestData)
		const itemCounts = extractItemCounts(parsedData)
		const status: 'success' | 'error' | 'pending' =
			row.status === 'success' ||
			row.status === 'error' ||
			row.status === 'pending'
				? row.status
				: 'error'
		const retryPayload = buildRetryPayload(
			row.action,
			status,
			integration.providerName,
			integration.organizationLocationId,
			itemCounts,
		)

		return {
			id: row.id,
			action: row.action,
			kind: classifyActionKind(row.action),
			status,
			itemCounts,
			errorMessage: row.errorMessage
				? toSafeSyncErrorMessage(row.errorMessage)
				: null,
			createdAt:
				row.createdAt instanceof Date
					? row.createdAt.toISOString()
					: new Date(row.createdAt).toISOString(),
			retryable: retryPayload !== null,
			retryPayload,
		}
	})

	return {
		integration: {
			id: integration.id,
			providerName: integration.providerName,
			locationId: integration.organizationLocationId,
		},
		entries,
		page,
		pageSize,
		hasMore,
	}
}

async function resolveMenuIdForRetry(
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
	if (preferredMenuId && menus.some((m) => m.id === preferredMenuId)) {
		return preferredMenuId
	}

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
		const disabled = new Set(
			overrides.filter((o) => o.isEnabled === false).map((o) => o.entityId),
		)
		const firstEnabled = menus.find((m) => !disabled.has(m.id))
		if (firstEnabled) return firstEnabled.id
	}

	return menus[0]!.id
}

/**
 * Retries a failed POS/delivery sync log entry after verifying org & integration
 * ownership. Uses `enqueueMenuSync` (#74) when `integrations.auto_sync` is on,
 * or executes `pushMenu` / `pushAvailability` / `importCatalog` directly.
 */
export async function retryIntegrationSyncLog(
	organizationId: string,
	integrationId: string,
	logId: string,
): Promise<RetrySyncResult> {
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

	const [log] = await db
		.select({
			id: IntegrationLog.id,
			action: IntegrationLog.action,
			status: IntegrationLog.status,
			requestData: IntegrationLog.requestData,
		})
		.from(IntegrationLog)
		.where(
			and(
				eq(IntegrationLog.id, logId),
				eq(IntegrationLog.integrationId, integration.id),
			),
		)
		.limit(1)

	if (!log) {
		return { ok: false, status: 404, error: 'Sync history entry not found.' }
	}

	if (!isPosProvider(integration.providerName)) {
		return {
			ok: false,
			status: 400,
			error: 'This integration does not support sync retries.',
		}
	}

	const parsedData = parseRedactedRequestData(log.requestData)
	const counts = extractItemCounts(parsedData)
	const retryPayload = buildRetryPayload(
		log.action,
		log.status,
		integration.providerName,
		integration.organizationLocationId,
		counts,
	)

	if (!retryPayload) {
		return {
			ok: false,
			status: 400,
			error: 'This sync entry cannot be retried.',
		}
	}

	try {
		if (retryPayload.kind === 'push') {
			const menuId = await resolveMenuIdForRetry(
				organizationId,
				integration.organizationLocationId,
				retryPayload.menuId,
			)
			if (!menuId) {
				return {
					ok: false,
					status: 400,
					error: 'No menu found to sync.',
				}
			}

			if (await isAutoSyncEnabled(organizationId)) {
				await enqueueMenuSync(organizationId, {
					locationIds: integration.organizationLocationId
						? [integration.organizationLocationId]
						: undefined,
					kind: 'menu',
					entityType: 'all',
					menuId,
					immediate: true,
				})
				return { ok: true, mode: 'queued', action: log.action }
			}

			const result = await pushMenu(integration.id, organizationId, menuId, {
				locationId: integration.organizationLocationId,
				respectPosOwnership: await isPosOwnershipEnabled(organizationId),
			})
			return {
				ok: true,
				mode: 'direct',
				action: log.action,
				pushed: result.pushed,
			}
		}

		if (retryPayload.kind === 'availability') {
			if (await isAutoSyncEnabled(organizationId)) {
				await enqueueMenuSync(organizationId, {
					locationIds: integration.organizationLocationId
						? [integration.organizationLocationId]
						: undefined,
					kind: 'availability',
					entityType: retryPayload.entityType,
					entityId: retryPayload.entityId,
					available: retryPayload.available,
					immediate: true,
				})
				return { ok: true, mode: 'queued', action: log.action }
			}

			await pushAvailability(integration.id, organizationId, {
				entityType: retryPayload.entityType,
				entityId: retryPayload.entityId,
				available: retryPayload.available,
				respectPosOwnership: await isPosOwnershipEnabled(organizationId),
			})
			return { ok: true, mode: 'direct', action: log.action, pushed: 1 }
		}

		let targetMenuId = retryPayload.menuId
		if (targetMenuId) {
			const [ownedMenu] = await db
				.select({ id: OrganizationMenu.id })
				.from(OrganizationMenu)
				.where(
					and(
						eq(OrganizationMenu.id, targetMenuId),
						eq(OrganizationMenu.organizationId, organizationId),
					),
				)
				.limit(1)
			if (!ownedMenu) targetMenuId = undefined
		}

		const imported = await importCatalog(
			integration.id,
			organizationId,
			targetMenuId,
		)
		return {
			ok: true,
			mode: 'direct',
			action: log.action,
			created: imported.created,
			updated: imported.updated,
			skipped: imported.skipped,
		}
	} catch (error) {
		const status =
			error instanceof PosError && error.status >= 400 && error.status < 600
				? error.status
				: 502
		return {
			ok: false,
			status,
			error: toSafeSyncErrorMessage(error),
		}
	}
}
