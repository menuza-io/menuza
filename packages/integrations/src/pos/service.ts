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
	OrganizationLocation,
	OrganizationMenuPosLink as PosLink,
	and,
	db,
	eq,
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
import { localizedText, loadMenuForSync } from './project.ts'
import { parsePosConfig } from './transport.ts'
import { isPosIntegrationProvider } from './providers/index.ts'
import { type Integration } from '../database-types'
import {
	importRemoteLocationForIntegration,
	probePosCatalog,
} from './location-import.ts'
import { providerNames, isPosProvider, type PosProvider } from './types.ts'
import {
	localItemHasModifierGroups,
	persistImportedItemModifiers,
} from './import-menu-modifiers.ts'

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

/**
 * Pushes the app menu to the connected platform. Menu-level platforms replace
 * the whole menu; item-level platforms create or update each linked item.
 */
export async function pushMenu(
	integrationId: string,
	organizationId: string,
	menuId: string,
) {
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const provider = getProvider(integration.providerName as PosProvider)
	const { items, menus } = await loadMenuForSync(organizationId, menuId)

	if (provider.writeMode === 'menu') {
		const current = await provider.readCatalog(integration)
		await provider.submitMenu(integration, items, menus, current.version)
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_push',
			'success',
			{ provider: integration.providerName, items: items.length },
		)
		return { mode: 'menu' as const, pushed: items.length }
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
		const remoteIdByLocal = new Map(
			links.map((link) => [link.localId, link.remoteId]),
		)

		for (const item of new Map(items.map((item) => [item.id, item])).values()) {
			const remoteId = remoteIdByLocal.get(item.id)
			const remote = remoteId ? remoteById.get(remoteId) : undefined
			const key = idempotencyKey(
				integration.id,
				item.id,
				JSON.stringify(item),
				remote?.version,
			)
			if (remoteId) {
				await adapter.update(
					{
						...item,
						id: remoteId,
						variationId: remote?.variationId,
						version: remote?.version ?? 1,
					},
					key,
					catalog.currency,
				)
			} else {
				const created = await adapter.create(item, key, catalog.currency)
				remoteIdByLocal.set(item.id, created.id)
				await db
					.insert(PosLink)
					.values({
						organizationId,
						integrationId: integration.id,
						providerName: integration.providerName,
						entityType: 'item',
						remoteId: created.id,
						localId: item.id,
					})
					.onConflictDoNothing()
			}
		}
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_push',
			'success',
			{ provider: integration.providerName, items: items.length },
		)
		return { mode: 'item' as const, pushed: items.length }
	}

	// Read-only platforms (Toast) only accept availability updates.
	throw new PosError(
		`${providerNames[integration.providerName as PosProvider]} is import-only. Push is not supported.`,
		400,
	)
}

/**
 * Imports the remote catalog into the app. Non-destructive: items already
 * linked to this connection are left untouched.
 */
export async function importCatalog(
	integrationId: string,
	organizationId: string,
	menuId?: string,
) {
	const integration = await getIntegrationForOrg(integrationId, organizationId)
	const provider = getProvider(integration.providerName as PosProvider)
	const catalog = await provider.readCatalog(integration)

	const targetMenu = await ensureTargetMenu(
		organizationId,
		menuId,
		providerNames[integration.providerName as PosProvider],
	)
	const links = await db
		.select()
		.from(PosLink)
		.where(
			and(
				eq(PosLink.integrationId, integration.id),
				eq(PosLink.entityType, 'item'),
			),
		)
	const linkedRemoteIds = new Set(links.map((link) => link.remoteId))
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
	let skipped = 0
	for (const item of catalog.items) {
		if (linkedRemoteIds.has(item.id)) {
			const link = linkByRemoteId.get(item.id)
			if (
				link &&
				item.modifierGroups.length > 0 &&
				!(await localItemHasModifierGroups(link.localId))
			) {
				await persistImportedItemModifiers({
					organizationId,
					integrationId: integration.id,
					providerName: integration.providerName,
					item,
					localItemId: link.localId,
				})
			}
			skipped++
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
			})
			.onConflictDoNothing()
		await persistImportedItemModifiers({
			organizationId,
			integrationId: integration.id,
			providerName: integration.providerName,
			item,
			localItemId: local.id,
		})
		created++
	}

	await integrationManager.logIntegrationActivity(
		integration.id,
		'pos_import',
		'success',
		{ provider: integration.providerName, created, skipped },
	)
	return { created, skipped, total: catalog.items.length }
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
