import {
	and,
	db,
	eq,
	inArray,
	Integration,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import {
	deliveryMenuLimits,
	isPosProvider,
	mergePosStoreSettings,
	parsePosConfig,
	PosError,
	providerKind,
	providerNames,
	pushHolidayHours,
	pushMenu,
	type PosDeliveryStoreSettings,
	type PosProvider,
} from '@repo/integrations'
import { buildEmailIdentity } from '#app/utils/email-sender/sender.server.ts'
import { isAutoSyncEnabled } from '#app/utils/integrations/flags.server.ts'
import { parseLegalContact } from '#app/utils/legal/contact.server.ts'
import {
	computeMenuHealthFor,
	loadMenuHealthData,
} from '#app/utils/menu/menu-health.server.ts'
import { safeEnqueueMenuSync } from '#app/utils/menu/menu-sync.server.ts'

export const STORE_READINESS_THRESHOLDS = {
	maxMissingPhotoRatio: 0.2,
} as const

export type StoreReadinessReasonCode =
	| 'managed_by_pos'
	| 'no_menus_selected'
	| 'menu_limit_reached'
	| 'zero_price'
	| 'missing_photos'
	| 'location_missing_address'
	| 'location_missing_phone'
	| 'location_missing_email'

export type StoreReadinessReason = {
	code: StoreReadinessReasonCode
	message: string
	href?: string
}

export type StoreReadinessResult = {
	ready: boolean
	managedByPos: boolean
	reasons: StoreReadinessReason[]
	stats: {
		selectedMenuCount: number
		publishedDishCount: number
		zeroPriceCount: number
		missingPhotoCount: number
		missingPhotoRatio: number
		hasAddress: boolean
		hasPhone: boolean
		hasEmail: boolean
	}
}

function hasNonEmptyAddress(rawAddress: string | null | undefined): boolean {
	if (!rawAddress) return false
	const trimmed = rawAddress.trim()
	if (!trimmed) return false
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>
			return Boolean(
				(typeof parsed.formattedAddress === 'string' &&
					parsed.formattedAddress.trim()) ||
				(typeof parsed.streetName === 'string' && parsed.streetName.trim()) ||
				(typeof parsed.city === 'string' && parsed.city.trim()),
			)
		} catch {
			return false
		}
	}
	return true
}

export async function isDeliveryManagedByPos(
	organizationId: string,
	locationId: string | null | undefined,
	deliveryProvider: PosProvider,
): Promise<boolean> {
	if (!locationId) return false
	const rows = await db
		.select({
			providerName: Integration.providerName,
			config: Integration.config,
		})
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.organizationLocationId, locationId),
				eq(Integration.isActive, true),
			),
		)

	return rows.some((row) => {
		if (!isPosProvider(row.providerName)) return false
		if (providerKind[row.providerName] !== 'pos') return false
		return Boolean(
			parsePosConfig(row.config).feedsDelivery?.includes(deliveryProvider),
		)
	})
}

export async function evaluateStoreReadiness(
	organizationId: string,
	integrationId: string,
): Promise<StoreReadinessResult> {
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

	if (
		!integration ||
		!isPosProvider(integration.providerName) ||
		providerKind[integration.providerName] !== 'delivery'
	) {
		throw new PosError('Delivery integration not found.', 404)
	}

	const providerName = integration.providerName as PosProvider
	const parsedConfig = parsePosConfig(integration.config)
	const store = parsedConfig.store ?? {
		menuIds: [],
		holidaySync: false,
		live: false,
	}

	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
			legalContact: Organization.legalContact,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)

	if (!organization) {
		throw new PosError('Organization not found.', 404)
	}

	const location = integration.organizationLocationId
		? await db
				.select({
					id: OrganizationLocation.id,
					address: OrganizationLocation.address,
					phone: OrganizationLocation.phone,
					email: OrganizationLocation.email,
				})
				.from(OrganizationLocation)
				.where(
					and(
						eq(OrganizationLocation.id, integration.organizationLocationId),
						eq(OrganizationLocation.organizationId, organizationId),
					),
				)
				.limit(1)
				.then((rows) => rows[0] ?? null)
		: null

	const managedByPos = await isDeliveryManagedByPos(
		organizationId,
		integration.organizationLocationId,
		providerName,
	)

	const reasons: StoreReadinessReason[] = []
	if (managedByPos) {
		reasons.push({
			code: 'managed_by_pos',
			message: `${providerNames[providerName]} menus are managed by your connected POS.`,
		})
	}

	if (store.menuIds.length === 0) {
		reasons.push({
			code: 'no_menus_selected',
			message: 'Select at least one menu for this delivery store.',
			href: `/${organization.slug}/menu`,
		})
	}

	const limit = deliveryMenuLimits[providerName]
	if (limit !== undefined && store.menuIds.length > limit) {
		reasons.push({
			code: 'menu_limit_reached',
			message: `${providerNames[providerName]} supports up to ${limit} menus per store.`,
		})
	}

	let publishedDishCount = 0
	let zeroPriceCount = 0
	let missingPhotoCount = 0
	let missingPhotoRatio = 0

	if (store.menuIds.length > 0) {
		const catRows = await db
			.select({ categoryId: OrganizationMenuCategoryAssignment.categoryId })
			.from(OrganizationMenuCategoryAssignment)
			.where(inArray(OrganizationMenuCategoryAssignment.menuId, store.menuIds))
		const categoryIds = [...new Set(catRows.map((row) => row.categoryId))]

		const itemRows = categoryIds.length
			? await db
					.select({
						itemId: OrganizationMenuItemCategoryAssignment.itemId,
					})
					.from(OrganizationMenuItemCategoryAssignment)
					.where(
						inArray(
							OrganizationMenuItemCategoryAssignment.categoryId,
							categoryIds,
						),
					)
			: []
		const selectedItemIds = new Set(itemRows.map((row) => row.itemId))

		const disabledItemIds = new Set<string>()
		if (integration.organizationLocationId && selectedItemIds.size > 0) {
			const overrides = await db
				.select({
					entityId: OrganizationMenuLocationOverride.entityId,
					isEnabled: OrganizationMenuLocationOverride.isEnabled,
				})
				.from(OrganizationMenuLocationOverride)
				.where(
					and(
						eq(OrganizationMenuLocationOverride.organizationId, organizationId),
						eq(
							OrganizationMenuLocationOverride.locationId,
							integration.organizationLocationId,
						),
						eq(OrganizationMenuLocationOverride.entityType, 'item'),
					),
				)
			for (const ov of overrides) {
				if (ov.isEnabled === false) disabledItemIds.add(ov.entityId)
			}
		}

		const healthData = await loadMenuHealthData(organizationId)
		const scopedItems = healthData.items.filter(
			(item) =>
				selectedItemIds.has(item.id) &&
				item.availabilityStatus !== 'hidden' &&
				!disabledItemIds.has(item.id),
		)
		publishedDishCount = scopedItems.length

		if (publishedDishCount > 0) {
			const health = computeMenuHealthFor(organization, {
				...healthData,
				items: scopedItems,
			})
			zeroPriceCount =
				health.checks.find((check) => check.key === 'zero_price')?.count ?? 0
			missingPhotoCount =
				health.checks.find((check) => check.key === 'no_photo')?.count ?? 0
			missingPhotoRatio = missingPhotoCount / publishedDishCount

			if (zeroPriceCount > 0) {
				reasons.push({
					code: 'zero_price',
					message: `${zeroPriceCount} published dish${zeroPriceCount === 1 ? ' has' : 'es have'} a $0 price.`,
					href: `/${organization.slug}/menu/items?health=zero_price`,
				})
			}

			if (missingPhotoRatio > STORE_READINESS_THRESHOLDS.maxMissingPhotoRatio) {
				reasons.push({
					code: 'missing_photos',
					message: `${missingPhotoCount} of ${publishedDishCount} published dishes are missing photos (max 20%).`,
					href: `/${organization.slug}/menu/items?health=no_photo`,
				})
			}
		}
	}

	const hasAddress = hasNonEmptyAddress(location?.address)
	const hasPhone = Boolean(location?.phone?.trim())
	const emailSender = await buildEmailIdentity(organizationId)
	const contactEmail =
		location?.email?.trim() ||
		parseLegalContact(organization.legalContact).email?.trim() ||
		emailSender?.replyTo?.trim() ||
		''
	const hasEmail = Boolean(contactEmail)

	if (location) {
		const locationHref = `/${organization.slug}/settings/locations/${location.id}`
		if (!hasAddress) {
			reasons.push({
				code: 'location_missing_address',
				message: 'Add a street address for this location.',
				href: locationHref,
			})
		}
		if (!hasPhone) {
			reasons.push({
				code: 'location_missing_phone',
				message: 'Add a phone number for this location.',
				href: locationHref,
			})
		}
		if (!hasEmail) {
			reasons.push({
				code: 'location_missing_email',
				message: 'Add a contact email for this location.',
				href: locationHref,
			})
		}
	}

	return {
		ready: reasons.length === 0,
		managedByPos,
		reasons,
		stats: {
			selectedMenuCount: store.menuIds.length,
			publishedDishCount,
			zeroPriceCount,
			missingPhotoCount,
			missingPhotoRatio,
			hasAddress,
			hasPhone,
			hasEmail,
		},
	}
}

export async function saveStoreSettings(
	organizationId: string,
	integrationId: string,
	input: { menuIds: string[]; holidaySync: boolean },
): Promise<{
	store: PosDeliveryStoreSettings
	readiness: StoreReadinessResult
}> {
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

	if (
		!integration ||
		!isPosProvider(integration.providerName) ||
		providerKind[integration.providerName] !== 'delivery'
	) {
		throw new PosError('Delivery integration not found.', 404)
	}

	const providerName = integration.providerName as PosProvider
	const managedByPos = await isDeliveryManagedByPos(
		organizationId,
		integration.organizationLocationId,
		providerName,
	)
	if (managedByPos) {
		throw new PosError(
			`${providerNames[providerName]} menus are managed by your connected POS.`,
			409,
			{ code: 'managed_by_pos' },
		)
	}

	const menuIds = [
		...new Set(input.menuIds.map((id) => id.trim()).filter(Boolean)),
	]
	if (menuIds.length === 0) {
		throw new PosError('Select at least one menu for this store.', 400, {
			code: 'no_menus_selected',
		})
	}

	const limit = deliveryMenuLimits[providerName]
	if (limit !== undefined && menuIds.length > limit) {
		throw new PosError(
			`${providerNames[providerName]} supports up to ${limit} menus per store.`,
			400,
			{ code: 'menu_limit_reached' },
		)
	}

	const orgMenus = await db
		.select({ id: OrganizationMenu.id })
		.from(OrganizationMenu)
		.where(
			and(
				eq(OrganizationMenu.organizationId, organizationId),
				inArray(OrganizationMenu.id, menuIds),
			),
		)
	if (orgMenus.length !== menuIds.length) {
		throw new PosError('One or more selected menus were not found.', 404)
	}

	const previousStore = parsePosConfig(integration.config).store
	const prevSet = new Set(previousStore?.menuIds ?? [])
	const menusChanged =
		prevSet.size !== menuIds.length || menuIds.some((id) => !prevSet.has(id))

	const nextConfig = mergePosStoreSettings(integration.config, {
		menuIds,
		holidaySync: input.holidaySync,
	})
	const now = new Date()
	await db
		.update(Integration)
		.set({ config: nextConfig, updatedAt: now })
		.where(eq(Integration.id, integration.id))

	if (menusChanged && (await isAutoSyncEnabled(organizationId))) {
		await safeEnqueueMenuSync(organizationId, {
			kind: 'menu',
			entityType: 'all',
			locationIds: integration.organizationLocationId
				? [integration.organizationLocationId]
				: null,
			immediate: true,
			now,
		})
	}

	const store = parsePosConfig(nextConfig).store!
	const readiness = await evaluateStoreReadiness(organizationId, integration.id)
	return { store, readiness }
}

export async function goLiveDeliveryStore(
	organizationId: string,
	integrationId: string,
	options?: { now?: Date },
): Promise<
	| { ok: true; status: 200; readiness: StoreReadinessResult }
	| {
			ok: false
			status: 400
			error: string
			reasons: StoreReadinessReason[]
			readiness: StoreReadinessResult
	  }
> {
	const readiness = await evaluateStoreReadiness(organizationId, integrationId)
	if (!readiness.ready) {
		return {
			ok: false,
			status: 400,
			error: readiness.reasons[0]?.message ?? 'Store is not ready to go live.',
			reasons: readiness.reasons,
			readiness,
		}
	}

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
		throw new PosError('Delivery integration not found.', 404)
	}

	const store = parsePosConfig(integration.config).store
	const now = options?.now ?? new Date()
	await pushMenu(integration.id, organizationId, store?.menuIds, {
		locationId: integration.organizationLocationId,
		now,
	})
	if (store?.holidaySync) {
		await pushHolidayHours(integration.id, organizationId, { now })
	}

	const [latest] = await db
		.select({ config: Integration.config })
		.from(Integration)
		.where(eq(Integration.id, integration.id))
		.limit(1)
	const nextConfig = mergePosStoreSettings(
		latest?.config ?? integration.config,
		{
			live: true,
		},
	)
	await db
		.update(Integration)
		.set({ config: nextConfig, updatedAt: now })
		.where(eq(Integration.id, integration.id))

	return { ok: true, status: 200, readiness }
}
