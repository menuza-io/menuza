/**
 * POS connection orchestration used by the app routes and the onboarding
 * wizard: connect a sandbox store, read its catalog, push the app menu to it,
 * and import its catalog into the app.
 */

import {
	Integration as IntegrationTable,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationLocation,
	OrganizationMenuPosLink as PosLink,
	and,
	asc,
	db,
	eq,
	inArray,
} from '@repo/database'
import { idempotencyKey } from './adapter.ts'
import { integrationManager } from '../integration-manager.ts'
import {
	findScopedIntegration,
	resolveOrganizationLocationIdForConnect,
} from '../location-integrations.ts'
import { providerRegistry } from '../provider.ts'
import {
	hasAppCredentials,
	providerUsesMerchantOAuth,
	resolveCredentials,
} from './credentials.ts'
import {
	buildDoorDashIntegrationConfig,
	isDoorDashStoreVerified,
	type DoorDashStoreLink,
} from './doordash-connect.ts'
import { isPosSandboxConnectAllowed } from './sandbox-policy.ts'
import { PosError } from './errors.ts'
import {
	computeRemoteItemHash,
	extractPosValues,
	isPosOwnershipField,
	parseOverriddenFields,
	type PosOwnershipField,
} from './ownership.ts'
import { projectSpecialHoursForPlatform } from './hours.ts'
import { localizedText, loadMenuForSync, loadMenusForSync } from './project.ts'
import { pick, snapshotOf } from './snapshot.ts'
import {
	clearPosSyncHealthFailures,
	mergePosStoreSettings,
	parsePosConfig,
	resolveFieldOwnership,
} from './transport.ts'
import { isPosIntegrationProvider } from './providers/index.ts'
import { type Integration } from '../database-types'
import {
	importRemoteLocationForIntegration,
	probePosCatalog,
} from './location-import.ts'
import {
	deliveryMenuLimits,
	providerKind,
	providerNames,
	readFields,
	writeFields,
	isPosProvider,
	type MenuField,
	type PosProvider,
	type RemoteItem,
	type RemoteMenu,
	type Snapshot,
} from './types.ts'
import { persistImportedItemModifiers } from './import-menu-modifiers.ts'
import { toSafeSyncErrorMessage } from '../redact.ts'

/**
 * After merchant OAuth: import store profile when the org has no locations yet,
 * then probe the catalog connection.
 */
export async function finalizePosOAuthConnection(
	integration: Integration,
): Promise<Integration> {
	try {
		await importRemoteLocationForIntegration(integration)
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_location_import',
			'error',
			{ provider: integration.providerName },
			error instanceof Error ? error.message : 'Unknown error',
		)
	}
	await probePosCatalog(integration)
	const refreshed = await integrationManager.getIntegration(integration.id)
	return refreshed ?? integration
}

/** Starts merchant OAuth when Menuza app credentials are configured. */
export async function startPosOAuth(
	organizationId: string,
	providerName: string,
	redirectUri: string,
	options?: { redirectUrl?: string; organizationLocationId?: string },
) {
	if (!isPosProvider(providerName)) {
		throw new PosError(`Unknown POS provider '${providerName}'.`, 400)
	}
	if (
		!hasAppCredentials(providerName) ||
		!providerUsesMerchantOAuth(providerName)
	) {
		throw new PosError(
			`${providerNames[providerName]} is not configured for OAuth. Connect in sandbox mode or set app credentials.`,
			400,
		)
	}
	const organizationLocationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		providerName,
		options?.organizationLocationId,
	)
	if (!organizationLocationId) {
		throw new PosError('A restaurant location is required to connect.', 400)
	}
	return integrationManager.initiateOAuth(
		organizationId,
		providerName,
		redirectUri,
		{
			redirectUrl: options?.redirectUrl,
			oauthRedirectUri: redirectUri,
			organizationLocationId,
		},
	)
}

function assertDoorDashVerified(integration: Integration) {
	if (integration.providerName !== 'doordash') return
	if (parsePosConfig(integration.config).environment !== 'live') return
	if (!isDoorDashStoreVerified(integration.config)) {
		throw new PosError(
			'This DoorDash store is not verified for menu sync. Complete DoorDash onboarding first.',
			403,
		)
	}
}

async function getIntegrationForOrg(
	integrationId: string,
	organizationId: string,
) {
	const integration = await db
		.select()
		.from(IntegrationTable)
		.where(
			and(
				eq(IntegrationTable.id, integrationId),
				eq(IntegrationTable.organizationId, organizationId),
			),
		)
		.limit(1)
		.then((rows) => rows[0])
	if (!integration) throw new PosError('Integration not found.', 404)
	if (!isPosProvider(integration.providerName)) {
		throw new PosError('This integration is not a POS platform.', 400)
	}
	assertDoorDashVerified(integration)
	return integration
}

function getProvider(providerName: PosProvider) {
	const provider = providerRegistry.get(providerName) as unknown
	if (!isPosIntegrationProvider(provider)) {
		throw new PosError(
			`Provider '${providerName}' is not a POS integration.`,
			400,
		)
	}
	return provider
}

/**
 * Creates or reactivates a POS connection for the organization. The mode comes
 * from the platform credentials in the environment (sandbox when a platform has
 * none). The connect probe is best-effort: if it fails the connection is still
 * created so the operator can retry.
 */
export type ConnectPosProviderOptions = {
	doorDash?: DoorDashStoreLink
}

export async function connectPosProvider(
	organizationId: string,
	providerName: string,
	organizationLocationId: string,
	options?: ConnectPosProviderOptions,
) {
	if (!isPosProvider(providerName)) {
		throw new PosError(`Unknown POS provider '${providerName}'.`, 400)
	}
	const resolvedLocationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		providerName,
		organizationLocationId,
	)
	if (!resolvedLocationId) {
		throw new PosError('A restaurant location is required to connect.', 400)
	}
	if (
		providerName === 'doordash' &&
		hasAppCredentials('doordash') &&
		process.env.DOORDASH_ALLOW_MANUAL_STORE_LINK !== 'true'
	) {
		throw new PosError(
			'DoorDash requires verified store onboarding before linking. Contact support or complete DoorDash SSIO.',
			403,
		)
	}
	if (!hasAppCredentials(providerName) && !isPosSandboxConnectAllowed()) {
		throw new PosError(
			'POS sandbox mode is only available in development. Configure platform credentials to connect live.',
			400,
		)
	}
	const provider = getProvider(providerName)
	const credentials = resolveCredentials(providerName)
	const directLive =
		hasAppCredentials(providerName) && !providerUsesMerchantOAuth(providerName)

	let configObject: Record<string, unknown>
	if (directLive && providerName === 'doordash') {
		const link = options?.doorDash
		if (!link?.doorDashStoreId) {
			throw new PosError(
				'Enter the DoorDash store ID for this restaurant location.',
				400,
			)
		}
		const menuzaLocationId = link.menuzaLocationId?.trim() || resolvedLocationId
		if (menuzaLocationId !== resolvedLocationId) {
			throw new PosError(
				'DoorDash must be linked to the selected restaurant location.',
				400,
			)
		}
		const location = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, menuzaLocationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.limit(1)
			.then((rows) => rows[0])
		if (!location) {
			throw new PosError(
				'That location does not belong to this organization.',
				400,
			)
		}
		configObject = buildDoorDashIntegrationConfig({
			menuzaLocationId,
			doorDashStoreId: link.doorDashStoreId,
		})
	} else {
		configObject = {
			environment: directLive ? 'live' : credentials.mode,
			merchantId: credentials.merchantId,
		}
	}
	const config = JSON.stringify(configObject)

	const existing = await findScopedIntegration(
		organizationId,
		providerName,
		resolvedLocationId,
	)

	let integration
	if (existing) {
		const externalStoreId =
			directLive &&
			typeof configObject.merchantId === 'string' &&
			configObject.merchantId
				? configObject.merchantId
				: null
		const [updated] = await db
			.update(IntegrationTable)
			.set({
				config,
				providerType: provider.type,
				externalStoreId,
				isActive: true,
				lastSyncAt: new Date(),
			})
			.where(eq(IntegrationTable.id, existing.id))
			.returning()
		integration = updated
	} else {
		const externalStoreId =
			directLive &&
			typeof configObject.merchantId === 'string' &&
			configObject.merchantId
				? configObject.merchantId
				: null
		const [created] = await db
			.insert(IntegrationTable)
			.values({
				organizationId,
				organizationLocationId: resolvedLocationId,
				providerName,
				providerType: provider.type,
				externalStoreId,
				config,
				isActive: true,
				lastSyncAt: new Date(),
			})
			.returning()
		integration = created
	}
	if (!integration) throw new PosError('Failed to create the connection.', 500)

	return finalizePosOAuthConnection(integration)
}

/** Reads the remote catalog and returns a summary (used by "Import menu"). */
export async function readCatalogSummary(
	integrationId: string,
	organizationId: string,
) {
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const provider = getProvider(integration.providerName as PosProvider)
	const catalog = await provider.readCatalog(integration)
	return {
		providerName: integration.providerName,
		currency: catalog.currency,
		items: catalog.items.length,
		menus: catalog.menus.length,
	}
}

export function sanitizeIntegrationErrorMessage(error: unknown): string {
	return toSafeSyncErrorMessage(error)
}

const EMPTY_SNAPSHOT: Snapshot = {
	name: '',
	description: '',
	category: 'Uncategorized',
	price: 0,
	imageUrl: null,
	available: true,
	modifierGroups: [],
	variations: [],
	menus: [],
	allergens: [],
	alcohol: false,
	taxRate: null,
}

export type PushMenuOptions = {
	locationId?: string | null
	/**
	 * When true (default), POS-owned non-overridden fields (#93) on linked items
	 * retain their remote POS values and are never pushed back to that POS.
	 */
	respectPosOwnership?: boolean
	now?: Date
}

/**
 * Pushes the app menu to the connected platform. Menu-level platforms replace
 * the whole menu; item-level platforms create or update each linked item.
 */
export async function pushMenu(
	integrationId: string,
	organizationId: string,
	menuIdOrIds?: string | string[],
	options?: PushMenuOptions,
) {
	const now = options?.now ?? new Date()
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const providerName = integration.providerName as PosProvider
	const provider = getProvider(providerName)
	const allowedWriteFields = writeFields[providerName]

	// Read-only platforms (Toast) only accept availability updates.
	if (provider.writeMode === 'none' || allowedWriteFields.length === 0) {
		throw new PosError(
			`${providerNames[providerName]} is import-only. Push is not supported.`,
			400,
		)
	}

	const locationId =
		options?.locationId !== undefined
			? options.locationId
			: integration.organizationLocationId

	const parsedConfig = parsePosConfig(integration.config)
	const useMultiMenu = menuIdOrIds === undefined || Array.isArray(menuIdOrIds)
	const targetMenuIds =
		menuIdOrIds === undefined
			? (parsedConfig.store?.menuIds ?? [])
			: Array.isArray(menuIdOrIds)
				? [...new Set(menuIdOrIds.map((id) => id.trim()).filter(Boolean))]
				: menuIdOrIds.trim()
					? [menuIdOrIds.trim()]
					: []

	if (targetMenuIds.length === 0) {
		throw new PosError(
			'Select at least one menu before syncing this store.',
			400,
			{ code: 'no_menus_selected' },
		)
	}

	const menuLimit = deliveryMenuLimits[providerName]
	if (menuLimit !== undefined && targetMenuIds.length > menuLimit) {
		throw new PosError(
			`${providerNames[providerName]} supports up to ${menuLimit} menus per store.`,
			400,
			{ code: 'menu_limit_reached' },
		)
	}

	if (providerKind[providerName] === 'delivery' && locationId) {
		const activeLocationIntegrations = await db
			.select({
				id: IntegrationTable.id,
				providerName: IntegrationTable.providerName,
				config: IntegrationTable.config,
			})
			.from(IntegrationTable)
			.where(
				and(
					eq(IntegrationTable.organizationId, organizationId),
					eq(IntegrationTable.organizationLocationId, locationId),
					eq(IntegrationTable.isActive, true),
				),
			)
		const managingPos = activeLocationIntegrations.find((row) => {
			if (!isPosProvider(row.providerName)) return false
			if (providerKind[row.providerName] !== 'pos') return false
			return parsePosConfig(row.config).feedsDelivery?.includes(providerName)
		})
		if (managingPos) {
			throw new PosError(
				`${providerNames[providerName]} menus are managed by ${providerNames[managingPos.providerName as PosProvider]}.`,
				409,
				{ code: 'managed_by_pos' },
			)
		}
	}

	let items: RemoteItem[]
	let menus: RemoteMenu[]
	let menuLogMeta: { menuId: string; menuIds?: string[]; menuName: string }

	if (useMultiMenu) {
		const loaded = await loadMenusForSync(organizationId, targetMenuIds, {
			locationId,
			now,
		})
		items = loaded.items
		menus = loaded.menus
		menuLogMeta = {
			menuId: targetMenuIds[0]!,
			menuIds: targetMenuIds,
			menuName: loaded.selectedMenus.map((m) => m.name).join(', '),
		}
	} else {
		const loaded = await loadMenuForSync(organizationId, targetMenuIds[0]!, {
			locationId,
			now,
		})
		items = loaded.items
		menus = loaded.menus
		menuLogMeta = {
			menuId: loaded.menu.id,
			menuName: loaded.menu.name,
		}
	}

	try {
		if (provider.writeMode === 'menu') {
			const projectedItems: RemoteItem[] = items.map((item) => ({
				...pick(EMPTY_SNAPSHOT, snapshotOf(item), allowedWriteFields),
				id: item.id,
				variationId: item.variationId,
				version: item.version,
			}))
			const current = await provider.readCatalog(integration)
			await provider.submitMenu(
				integration,
				projectedItems,
				menus,
				current.version,
			)
			const nextConfig = clearPosSyncHealthFailures(integration.config, {
				lastMenuPushAt: now.toISOString(),
			})
			await db
				.update(IntegrationTable)
				.set({
					lastSyncAt: now,
					config: nextConfig,
					updatedAt: now,
				})
				.where(eq(IntegrationTable.id, integration.id))
			await integrationManager.logIntegrationActivity(
				integration.id,
				'pos_push',
				'success',
				{
					provider: integration.providerName,
					...menuLogMeta,
					pushed: projectedItems.length,
					items: projectedItems.length,
					...(locationId ? { locationId } : {}),
				},
			)
			return { mode: 'menu' as const, pushed: projectedItems.length }
		}

		if (provider.writeMode === 'item') {
			const adapter = await provider.adapter(integration)
			const catalog = await provider.readCatalog(integration)
			const remoteById = new Map(catalog.items.map((item) => [item.id, item]))
			const links = await db
				.select()
				.from(PosLink)
				.where(
					and(
						eq(PosLink.integrationId, integration.id),
						eq(PosLink.entityType, 'item'),
					),
				)
			const linkByLocal = new Map(links.map((link) => [link.localId, link]))
			const respectPosOwnership =
				(options?.respectPosOwnership ?? true) &&
				providerKind[providerName] === 'pos'
			const ownership = resolveFieldOwnership(providerName, integration.config)
			let pushed = 0

			for (const item of new Map(
				items.map((entry) => [entry.id, entry]),
			).values()) {
				const link = linkByLocal.get(item.id)
				const remoteId = link?.remoteId
				const remote = remoteId ? remoteById.get(remoteId) : undefined

				if (remoteId) {
					if (respectPosOwnership) {
						if (!remote && ownership.name === 'pos') {
							continue
						}
						const overridden = new Set(
							parseOverriddenFields(link?.overriddenFields),
						)
						const writableMenuzaFields: MenuField[] = allowedWriteFields.filter(
							(field) => {
								if (isPosOwnershipField(field)) {
									return ownership[field] === 'menuza' || overridden.has(field)
								}
								if (field === 'variations') {
									return ownership.price === 'menuza' || overridden.has('price')
								}
								return true
							},
						)
						if (writableMenuzaFields.length === 0) {
							continue
						}
						if (remote) {
							const remoteSnapshot = snapshotOf(remote)
							const merged = pick(
								remoteSnapshot,
								snapshotOf(item),
								writableMenuzaFields,
							)
							const beforeComparable = pick(
								EMPTY_SNAPSHOT,
								remoteSnapshot,
								allowedWriteFields,
							)
							const afterComparable = pick(
								EMPTY_SNAPSHOT,
								merged,
								allowedWriteFields,
							)
							if (
								JSON.stringify(beforeComparable) ===
								JSON.stringify(afterComparable)
							) {
								continue
							}
							const key = idempotencyKey(
								integration.id,
								item.id,
								JSON.stringify(merged),
								remote.version,
							)
							await adapter.update(
								{
									...merged,
									id: remoteId,
									variationId: remote.variationId,
									version: remote.version,
								},
								key,
								catalog.currency,
							)
							pushed++
							continue
						}
					}

					const mergedSnapshot = remote
						? pick(snapshotOf(remote), snapshotOf(item), allowedWriteFields)
						: pick(EMPTY_SNAPSHOT, snapshotOf(item), allowedWriteFields)
					const key = idempotencyKey(
						integration.id,
						item.id,
						JSON.stringify(mergedSnapshot),
						remote?.version,
					)
					await adapter.update(
						{
							...mergedSnapshot,
							id: remoteId,
							variationId: remote?.variationId,
							version: remote?.version ?? 1,
						},
						key,
						catalog.currency,
					)
					pushed++
				} else {
					const createdPayload: RemoteItem = {
						...pick(EMPTY_SNAPSHOT, snapshotOf(item), allowedWriteFields),
						id: item.id,
						variationId: item.variationId,
						version: item.version,
					}
					const key = idempotencyKey(
						integration.id,
						item.id,
						JSON.stringify(createdPayload),
					)
					const created = await adapter.create(
						createdPayload,
						key,
						catalog.currency,
					)
					const hash = computeRemoteItemHash(created)
					const posValues = JSON.stringify(extractPosValues(created))
					await db
						.insert(PosLink)
						.values({
							organizationId,
							integrationId: integration.id,
							providerName: integration.providerName,
							entityType: 'item',
							remoteId: created.id,
							localId: item.id,
							lastSyncedHash: hash,
							lastSyncedAt: now,
							posValues,
							overriddenFields: '[]',
						})
						.onConflictDoNothing()
					pushed++
				}
			}

			const nextConfig = clearPosSyncHealthFailures(integration.config, {
				lastMenuPushAt: now.toISOString(),
			})
			await db
				.update(IntegrationTable)
				.set({
					lastSyncAt: now,
					config: nextConfig,
					updatedAt: now,
				})
				.where(eq(IntegrationTable.id, integration.id))
			await integrationManager.logIntegrationActivity(
				integration.id,
				'pos_push',
				'success',
				{
					provider: integration.providerName,
					...menuLogMeta,
					pushed,
					items: pushed,
					...(locationId ? { locationId } : {}),
				},
			)
			return { mode: 'item' as const, pushed }
		}
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_push',
			'error',
			{
				provider: integration.providerName,
				...menuLogMeta,
				...(locationId ? { locationId } : {}),
			},
			sanitizeIntegrationErrorMessage(error),
		)
		throw error
	}

	throw new PosError(
		`${providerNames[providerName]} is import-only. Push is not supported.`,
		400,
	)
}

/**
 * Projects `OrganizationLocation.specialHours` and pushes upcoming holiday
 * hours to a connected delivery platform (#96).
 */
export async function pushHolidayHours(
	integrationId: string,
	organizationId: string,
	options?: { now?: Date },
) {
	const now = options?.now ?? new Date()
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const providerName = integration.providerName as PosProvider
	const provider = getProvider(providerName)

	if (providerKind[providerName] !== 'delivery') {
		throw new PosError(
			`${providerNames[providerName]} does not support holiday hours sync.`,
			400,
		)
	}

	const locationId = integration.organizationLocationId
	if (!locationId) {
		throw new PosError('Integration is not linked to a location.', 400)
	}

	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
			specialHours: OrganizationLocation.specialHours,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)

	if (!location) {
		throw new PosError('Location not found.', 404)
	}

	const hours = projectSpecialHoursForPlatform(
		location.specialHours,
		location.timezone,
		now,
	)

	try {
		await provider.submitHolidayHours(integration, hours)
		const nextConfig = mergePosStoreSettings(integration.config, {
			lastHolidaySyncAt: now.toISOString(),
		})
		await db
			.update(IntegrationTable)
			.set({
				config: nextConfig,
				updatedAt: now,
			})
			.where(eq(IntegrationTable.id, integration.id))
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_holiday_hours',
			'success',
			{
				provider: integration.providerName,
				locationId,
				count: hours.length,
			},
		)
		return { count: hours.length, hours }
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_holiday_hours',
			'error',
			{
				provider: integration.providerName,
				locationId,
				count: hours.length,
			},
			sanitizeIntegrationErrorMessage(error),
		)
		throw error
	}
}

export type PushAvailabilityInput = {
	entityType: 'item' | 'modifier_option'
	entityId: string
	available: boolean
	respectPosOwnership?: boolean
	now?: Date
}

/**
 * Pushes a single item or modifier option availability change to a connected
 * POS or delivery platform via its dedicated availability endpoint.
 */
export async function pushAvailability(
	integrationId: string,
	organizationId: string,
	input: PushAvailabilityInput,
) {
	const now = input.now ?? new Date()
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const providerName = integration.providerName as PosProvider
	const provider = getProvider(providerName)

	if (!writeFields[providerName].includes('available')) {
		throw new PosError(
			`${providerNames[providerName]} does not support availability updates.`,
			400,
		)
	}

	const [link] = await db
		.select()
		.from(PosLink)
		.where(
			and(
				eq(PosLink.integrationId, integration.id),
				eq(PosLink.entityType, input.entityType),
				eq(PosLink.localId, input.entityId),
			),
		)
		.limit(1)

	const respectPosOwnership =
		(input.respectPosOwnership ?? true) && providerKind[providerName] === 'pos'
	if (respectPosOwnership) {
		const ownership = resolveFieldOwnership(providerName, integration.config)
		const overridden = new Set(parseOverriddenFields(link?.overriddenFields))
		if (ownership.available === 'pos' && !overridden.has('available')) {
			throw new PosError(
				`Availability is managed in ${providerNames[providerName]}.`,
				409,
			)
		}
	}

	try {
		const catalog = await provider.readCatalog(integration)
		const remoteId = link?.remoteId ?? input.entityId
		let remoteItem =
			catalog.items.find((entry) => entry.id === remoteId) ??
			catalog.items.find((entry) => entry.id === input.entityId)

		if (
			input.entityType === 'modifier_option' &&
			!remoteItem &&
			provider.writeMode === 'item'
		) {
			const [optionRow] = await db
				.select({ displayName: OrganizationMenuOption.displayName })
				.from(OrganizationMenuOption)
				.where(
					and(
						eq(OrganizationMenuOption.id, input.entityId),
						eq(OrganizationMenuOption.organizationId, organizationId),
					),
				)
				.limit(1)
			const groupAssignments = await db
				.select({
					modifierGroupId:
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				})
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.where(
					eq(
						OrganizationMenuModifierGroupOptionAssignment.optionId,
						input.entityId,
					),
				)
			const groupIds = groupAssignments.map((row) => row.modifierGroupId)
			const itemAssignments = groupIds.length
				? await db
						.select({
							itemId: OrganizationMenuItemModifierGroupAssignment.itemId,
						})
						.from(OrganizationMenuItemModifierGroupAssignment)
						.where(
							inArray(
								OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
								groupIds,
							),
						)
				: []
			const parentLocalIds = [...new Set(itemAssignments.map((r) => r.itemId))]
			const parentLinks = parentLocalIds.length
				? await db
						.select()
						.from(PosLink)
						.where(
							and(
								eq(PosLink.integrationId, integration.id),
								eq(PosLink.entityType, 'item'),
								inArray(PosLink.localId, parentLocalIds),
							),
						)
				: []
			const targetOptionName = optionRow
				? localizedText(optionRow.displayName)
				: ''
			const adapter = await provider.adapter(integration)
			let updatedParents = 0

			for (const parentLocalId of parentLocalIds) {
				const parentRemoteId =
					parentLinks.find((l) => l.localId === parentLocalId)?.remoteId ??
					parentLocalId
				const parentRemote = catalog.items.find(
					(entry) => entry.id === parentRemoteId,
				)
				if (!parentRemote) continue
				const nextParent: RemoteItem = {
					...parentRemote,
					modifierGroups: parentRemote.modifierGroups.map((group) => ({
						...group,
						options: group.options.map((opt) =>
							opt.id === remoteId ||
							(targetOptionName && opt.name === targetOptionName)
								? { ...opt, available: input.available }
								: opt,
						),
					})),
				}
				await adapter.update(
					nextParent,
					idempotencyKey(
						providerName,
						integration.id,
						parentRemote.id,
						input.entityId,
						input.available,
						parentRemote.version,
					),
					catalog.currency,
				)
				updatedParents++
			}

			if (updatedParents > 0) {
				const nextConfig = clearPosSyncHealthFailures(integration.config)
				await db
					.update(IntegrationTable)
					.set({ lastSyncAt: now, config: nextConfig, updatedAt: now })
					.where(eq(IntegrationTable.id, integration.id))
				await integrationManager.logIntegrationActivity(
					integration.id,
					'pos_availability',
					'success',
					{
						provider: integration.providerName,
						entityType: input.entityType,
						entityId: input.entityId,
						available: input.available,
						pushed: updatedParents,
					},
				)
				return {
					provider: providerName,
					remoteId,
					available: input.available,
				}
			}
		}

		const targetItem: RemoteItem = remoteItem ?? {
			...EMPTY_SNAPSHOT,
			id: remoteId,
			available: input.available,
			version: 1,
		}
		await provider.setAvailability(integration, targetItem, input.available)

		const nextConfig = clearPosSyncHealthFailures(integration.config)
		await db
			.update(IntegrationTable)
			.set({ lastSyncAt: now, config: nextConfig, updatedAt: now })
			.where(eq(IntegrationTable.id, integration.id))
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_availability',
			'success',
			{
				provider: integration.providerName,
				entityType: input.entityType,
				entityId: input.entityId,
				available: input.available,
				pushed: 1,
			},
		)
		return {
			provider: providerName,
			remoteId: targetItem.id,
			available: input.available,
		}
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_availability',
			'error',
			{
				provider: integration.providerName,
				entityType: input.entityType,
				entityId: input.entityId,
				available: input.available,
			},
			sanitizeIntegrationErrorMessage(error),
		)
		throw error
	}
}

export type CatalogImportChange = {
	itemId: string
	name: string
	fields: string[]
}

export type CatalogImportResult = {
	created: number
	updated: number
	skipped: number
	total: number
	changes: CatalogImportChange[]
}

function applyPosTextToColumn(
	existing: string | null | undefined,
	nextPlain: string | null,
): string | null {
	if (nextPlain === null) {
		if (!existing || !existing.startsWith('{')) return null
		try {
			const parsed = JSON.parse(existing) as Record<string, string>
			delete parsed.en
			const remaining = Object.entries(parsed).filter(([, val]) =>
				Boolean(val?.trim()),
			)
			return remaining.length > 0
				? JSON.stringify(Object.fromEntries(remaining))
				: null
		} catch {
			return null
		}
	}
	if (existing && existing.startsWith('{')) {
		try {
			const parsed = JSON.parse(existing) as Record<string, string>
			parsed.en = nextPlain
			return JSON.stringify(parsed)
		} catch {
			return nextPlain
		}
	}
	return nextPlain
}

/**
 * Imports the remote catalog into the app. Creates unlinked items and updates
 * POS-owned, non-overridden fields on already-linked items when their remote
 * hash has changed (#93).
 */
export async function importCatalog(
	integrationId: string,
	organizationId: string,
	menuId?: string,
): Promise<CatalogImportResult> {
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const providerName = integration.providerName as PosProvider
	const provider = getProvider(providerName)
	let resolvedMenuId: string | undefined = menuId
	let resolvedMenuName: string | undefined

	try {
		const catalog = await provider.readCatalog(integration)
		const ownership = resolveFieldOwnership(providerName, integration.config)
		const providerReadable = new Set<string>(readFields[providerName])

		const targetMenu = await ensureTargetMenu(
			organizationId,
			menuId,
			providerNames[providerName],
		)
		resolvedMenuId = targetMenu.id
		resolvedMenuName = localizedText(targetMenu.displayName, 'Menu')
		const links = await db
			.select()
			.from(PosLink)
			.where(
				and(
					eq(PosLink.integrationId, integration.id),
					eq(PosLink.entityType, 'item'),
				),
			)
		const linkByRemoteId = new Map(links.map((link) => [link.remoteId, link]))

		const categoryIdByName = new Map<string, string>()
		const categoryIdFor = async (name: string) => {
			const cached = categoryIdByName.get(name)
			if (cached) return cached
			const existing = await db
				.select()
				.from(OrganizationMenuCategory)
				.where(
					and(
						eq(OrganizationMenuCategory.organizationId, organizationId),
						eq(OrganizationMenuCategory.displayName, name),
					),
				)
				.limit(1)
				.then((rows) => rows[0])
			let category = existing
			if (!category) {
				const inserted = await db
					.insert(OrganizationMenuCategory)
					.values({ organizationId, displayName: name })
					.returning()
				category = inserted[0]
				if (!category) throw new PosError('Failed to create category.', 500)
			}
			await db
				.insert(OrganizationMenuCategoryAssignment)
				.values({ menuId: targetMenu.id, categoryId: category.id })
				.onConflictDoNothing()
			categoryIdByName.set(name, category.id)
			return category.id
		}

		let created = 0
		let updated = 0
		let skipped = 0
		const changes: CatalogImportChange[] = []

		for (const item of catalog.items) {
			const hash = computeRemoteItemHash(item)
			const posValues = JSON.stringify(extractPosValues(item))
			const now = new Date()
			const link = linkByRemoteId.get(item.id)

			if (link) {
				if (link.lastSyncedHash === hash && link.posValues) {
					skipped++
					continue
				}

				// Always refresh stored POS values and sync hash/timestamp, even when
				// every changed field is locally overridden (#93 AC #6).
				await db
					.update(PosLink)
					.set({
						posValues,
						lastSyncedHash: hash,
						lastSyncedAt: now,
						updatedAt: now,
					})
					.where(eq(PosLink.id, link.id))

				const [currentItem] = await db
					.select()
					.from(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.id, link.localId),
							eq(OrganizationMenuItem.organizationId, organizationId),
						),
					)
					.limit(1)
				if (!currentItem) {
					skipped++
					continue
				}

				const overridden = new Set(parseOverriddenFields(link.overriddenFields))
				const shouldApply = (field: PosOwnershipField) =>
					ownership[field] === 'pos' &&
					!overridden.has(field) &&
					providerReadable.has(field)

				const itemUpdate: Partial<typeof OrganizationMenuItem.$inferInsert> = {}
				const changedFields: string[] = []

				if (shouldApply('name')) {
					const nextName = item.name || 'Imported item'
					if (localizedText(currentItem.displayName) !== nextName) {
						itemUpdate.displayName =
							applyPosTextToColumn(currentItem.displayName, nextName) ??
							nextName
						changedFields.push('name')
					}
				}

				if (shouldApply('description')) {
					const nextDesc = item.description || null
					const curDesc = localizedText(currentItem.description) || null
					if (curDesc !== nextDesc) {
						itemUpdate.description = applyPosTextToColumn(
							currentItem.description,
							nextDesc,
						)
						changedFields.push('description')
					}
				}

				if (shouldApply('price')) {
					const nextPrice = item.price / 100
					if (Math.abs(currentItem.price - nextPrice) > 1e-6) {
						itemUpdate.price = nextPrice
						changedFields.push('price')
					}
				}

				if (shouldApply('photo')) {
					const nextPhoto = item.imageUrl ?? null
					if ((currentItem.imageUrl ?? null) !== nextPhoto) {
						itemUpdate.imageUrl = nextPhoto
						changedFields.push('photo')
					}
				}

				if (shouldApply('available')) {
					const nextStatus = item.available ? 'available' : 'unavailable'
					if (currentItem.availabilityStatus !== nextStatus) {
						itemUpdate.availabilityStatus = nextStatus
						itemUpdate.unavailableUntil = null
						changedFields.push('available')
					}
				}

				if (
					shouldApply('tax') &&
					item.taxRate !== null &&
					item.taxRate !== undefined
				) {
					const nextTax = item.taxRate > 0
					if (currentItem.applySalesTax !== nextTax) {
						itemUpdate.applySalesTax = nextTax
						changedFields.push('tax')
					}
				}

				if (shouldApply('category')) {
					const targetCategoryId = await categoryIdFor(
						localizedText(item.category) || 'Uncategorized',
					)
					const currentCategoryLinks = await db
						.select({
							categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
						})
						.from(OrganizationMenuItemCategoryAssignment)
						.where(
							eq(OrganizationMenuItemCategoryAssignment.itemId, currentItem.id),
						)
						.orderBy(asc(OrganizationMenuItemCategoryAssignment.position))
					const currentCategoryIds = currentCategoryLinks.map(
						(c) => c.categoryId,
					)
					if (
						currentCategoryIds.length !== 1 ||
						currentCategoryIds[0] !== targetCategoryId
					) {
						await db
							.delete(OrganizationMenuItemCategoryAssignment)
							.where(
								eq(
									OrganizationMenuItemCategoryAssignment.itemId,
									currentItem.id,
								),
							)
						await db.insert(OrganizationMenuItemCategoryAssignment).values({
							categoryId: targetCategoryId,
							itemId: currentItem.id,
							position: 0,
						})
						changedFields.push('category')
					}
				}

				if (shouldApply('modifiers')) {
					const modifiersChanged = await persistImportedItemModifiers({
						organizationId,
						integrationId: integration.id,
						providerName: integration.providerName,
						item,
						localItemId: currentItem.id,
						ownership,
						syncExisting: true,
					})
					if (modifiersChanged) {
						changedFields.push('modifiers')
					}
				}

				if (Object.keys(itemUpdate).length > 0) {
					await db
						.update(OrganizationMenuItem)
						.set({ ...itemUpdate, updatedAt: now })
						.where(eq(OrganizationMenuItem.id, currentItem.id))
				}

				if (changedFields.length > 0) {
					updated++
					changes.push({
						itemId: currentItem.id,
						name: localizedText(
							itemUpdate.displayName ?? currentItem.displayName,
							item.name || 'Imported item',
						),
						fields: changedFields,
					})
				} else {
					skipped++
				}
				continue
			}

			const categoryId = await categoryIdFor(
				localizedText(item.category) || 'Uncategorized',
			)
			const local = await db
				.insert(OrganizationMenuItem)
				.values({
					organizationId,
					displayName: item.name || 'Imported item',
					description: item.description || null,
					price: item.price / 100,
					imageUrl: item.imageUrl ?? null,
					isAlcohol: Boolean(item.alcohol),
					allergens: JSON.stringify(item.allergens ?? []),
					applySalesTax:
						item.taxRate === null || item.taxRate === undefined
							? true
							: item.taxRate > 0,
					availabilityStatus: item.available ? 'available' : 'unavailable',
				})
				.returning()
				.then((rows) => rows[0]!)
			await db
				.insert(OrganizationMenuItemCategoryAssignment)
				.values({ categoryId, itemId: local.id })
				.onConflictDoNothing()
			await db
				.insert(PosLink)
				.values({
					organizationId,
					integrationId: integration.id,
					providerName: integration.providerName,
					entityType: 'item',
					remoteId: item.id,
					localId: local.id,
					lastSyncedHash: hash,
					lastSyncedAt: now,
					posValues,
					overriddenFields: '[]',
				})
				.onConflictDoNothing()
			await persistImportedItemModifiers({
				organizationId,
				integrationId: integration.id,
				providerName: integration.providerName,
				item,
				localItemId: local.id,
				ownership,
				syncExisting: false,
			})
			created++
		}

		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_import',
			'success',
			{
				provider: integration.providerName,
				menuId: targetMenu.id,
				menuName: resolvedMenuName,
				created,
				updated,
				skipped,
				total: catalog.items.length,
			},
		)
		return { created, updated, skipped, total: catalog.items.length, changes }
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_import',
			'error',
			{
				provider: integration.providerName,
				...(resolvedMenuId ? { menuId: resolvedMenuId } : {}),
				...(resolvedMenuName ? { menuName: resolvedMenuName } : {}),
			},
			sanitizeIntegrationErrorMessage(error),
		)
		throw error
	}
}

async function ensureTargetMenu(
	organizationId: string,
	menuId: string | undefined,
	providerLabel: string,
) {
	if (menuId) {
		const menu = await db
			.select()
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organizationId),
				),
			)
			.limit(1)
			.then((rows) => rows[0])
		if (!menu) throw new PosError('Menu not found.', 404)
		return menu
	}
	const name = `Imported from ${providerLabel}`
	const existing = await db
		.select()
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, organizationId),
				eq(OrganizationMenu.displayName, name),
			),
		)
		.limit(1)
		.then((rows) => rows[0])
	if (existing) return existing
	const [created] = await db
		.insert(OrganizationMenu)
		.values({ organizationId, displayName: name })
		.returning()
	return created!
}
