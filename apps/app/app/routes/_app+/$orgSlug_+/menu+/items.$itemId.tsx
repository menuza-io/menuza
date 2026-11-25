import { requireUserId } from '@repo/auth'
import { parseDailySaleLimit } from '@repo/common/daily-dish-limits'
import { parseMenuChannels } from '@repo/common/menu-channels'
import { popularModeSchema, type PopularMode } from '@repo/common/menu-popular'
import { parseOrderTypePrices } from '@repo/common/menu-pricing'
import {
	dietaryTagsOf,
	MenuItemInputSchema,
	parseMenuVariations,
	parseMenuItemImageKeys,
	storedKitchenHighlight,
	storedKitchenName,
} from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	and,
	inArray,
	or,
	OrganizationMenuItem,
	OrganizationMenuCategory,
	OrganizationMenuModifierGroup,
	OrganizationLocation,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMediaAsset,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { DishPageCard } from '#app/components/menu/dish-page-card.tsx'
import { ItemForm } from '#app/components/menu/item-form.tsx'
import { PhotoTestPanel } from '#app/components/menu/photo-test-panel.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { effectiveIsPopularForMode } from '#app/utils/menu/auto-popular.server.ts'
import { deleteMenuEntityReferences } from '#app/utils/menu/cleanup.server.ts'
import {
	dailyLimitColumn,
	dailyLimitLocationIds,
} from '#app/utils/menu/daily-limit-save.ts'
import { safeEnqueueMenuSync } from '#app/utils/menu/menu-sync.server.ts'
import { recordMenuChange } from '#app/utils/menu/menu-updates.server.ts'
import {
	dietaryAndOrderTypeColumns,
	MENU_JSON_FORM_KEYS,
	narrowOverrideChannels,
	parseChannelsFormData,
	parseMenuJsonFormValue,
} from '#app/utils/menu/menu-write-columns.ts'
import {
	assertCategoryIdsInOrganization,
	assertItemInOrganization,
	assertLocationIdsInOrganization,
	assertMediaKeysInOrganization,
	assertModifierGroupIdsInOrganization,
} from '#app/utils/menu/ownership.server.ts'
import { photoTestCountsReader } from '#app/utils/menu/photo-test-results.server.ts'
import {
	isPhotoTestsEnabled,
	listPhotoTestsForItem,
	photoTestImageUrls,
	stopPhotoTestsForChangedDish,
} from '#app/utils/menu/photo-tests.server.ts'
import {
	assertCanDeleteMenuItem,
	assertNoLockedFieldWrites,
	detectChangedItemPosFields,
	handlePosFieldOverrideIntent,
	lockedFieldsForOne,
	PosFieldLockedError,
} from '#app/utils/menu/pos-ownership.server.ts'
import { isDailyDishLimitsEnabled } from '#app/utils/orders/daily-dish-limits.server.ts'
import { buildSlotLimitsContext } from '#app/utils/orders/slot-limits.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})

	await requireMenuRead(request, organization.id)

	const itemId = params.itemId
	if (!itemId) {
		throw new Response('Item not found', { status: 404 })
	}

	const item = await db.query.OrganizationMenuItem.findFirst({
		where: and(
			eq(OrganizationMenuItem.id, itemId),
			eq(OrganizationMenuItem.organizationId, organization.id),
		),
		with: {
			categoryAssignments: {
				orderBy: [asc(OrganizationMenuItemCategoryAssignment.position)],
			},
			modifierGroupAssignments: {
				orderBy: [asc(OrganizationMenuItemModifierGroupAssignment.position)],
			},
		},
	})

	if (!item) {
		throw new Response('Item not found', { status: 404 })
	}

	const imageKeys = parseMenuItemImageKeys(item.imageKeys, item.imageKey)
	const variations = parseMenuVariations(item.variations)
	const mediaKeys = [
		...new Set([
			...imageKeys,
			...variations.variants.flatMap((variant) =>
				variant.imageKey ? [variant.imageKey] : [],
			),
		]),
	]
	const mediaAssets =
		mediaKeys.length > 0
			? await db
					.select({
						id: OrganizationMediaAsset.id,
						objectKey: OrganizationMediaAsset.objectKey,
						updatedAt: OrganizationMediaAsset.updatedAt,
					})
					.from(OrganizationMediaAsset)
					.where(
						and(
							eq(OrganizationMediaAsset.organizationId, organization.id),
							or(
								inArray(OrganizationMediaAsset.id, mediaKeys),
								inArray(OrganizationMediaAsset.objectKey, mediaKeys),
							),
						),
					)
			: []
	const mediaUrlsByKey = new Map<string, string>()
	for (const media of mediaAssets) {
		const url = `/resources/images?mediaId=${encodeURIComponent(media.id)}&v=${media.updatedAt.getTime()}`
		mediaUrlsByKey.set(media.id, url)
		mediaUrlsByKey.set(media.objectKey, url)
	}
	const images = imageKeys.flatMap((key) => {
		const url = mediaUrlsByKey.get(key)
		return url ? [{ key, url }] : []
	})

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = localesConfig.defaultLocale
	const supportedLocales = localesConfig.locales

	const allCategories = await db.query.OrganizationMenuCategory.findMany({
		where: eq(OrganizationMenuCategory.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuCategory.position)],
	})

	const allModifierGroups =
		await db.query.OrganizationMenuModifierGroup.findMany({
			where: eq(OrganizationMenuModifierGroup.organizationId, organization.id),
			orderBy: [asc(OrganizationMenuModifierGroup.position)],
		})

	const allLocations = await db.query.OrganizationLocation.findMany({
		where: eq(OrganizationLocation.organizationId, organization.id),
		orderBy: [
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		],
	})

	// Load existing overrides
	const existingOverrides =
		await db.query.OrganizationMenuLocationOverride.findMany({
			where: and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'item'),
				eq(OrganizationMenuLocationOverride.entityId, item.id),
			),
		})

	const locationOverrides: Record<string, any> = {}
	for (const ov of existingOverrides) {
		locationOverrides[ov.locationId] = {
			locationId: ov.locationId,
			isEnabled: ov.isEnabled ?? true,
			price: ov.price,
			availabilityStatus: ov.availabilityStatus,
			channels: ov.channels ? parseMenuChannels(ov.channels) : null,
		}
	}

	let allergens: string[] = []
	try {
		if (item.allergens) allergens = JSON.parse(item.allergens) as string[]
	} catch {}

	const slotLimits = await buildSlotLimitsContext(organization.id)
	const dailyLimitsEnabled = await isDailyDishLimitsEnabled(organization.id)
	const posLock = await lockedFieldsForOne(organization.id, 'item', item.id)
	// #137: "Give this dish its own page", offered while dish pages are on.
	const dishPage = (await getLandingFeatures(organization.id)).dishPages
		? { enabled: item.sitePageEnabled, slug: item.siteSlug }
		: null

	// Photo tests (#192): the running and past tests of this dish, with the
	// regional numbers (counts only).
	const photoTestsEnabled = await isPhotoTestsEnabled(organization.id)
	const photoTestList = photoTestsEnabled
		? await listPhotoTestsForItem({
				organizationId: organization.id,
				itemId: item.id,
				readCounts: photoTestCountsReader(request, organization.slug),
			})
		: []
	const photoTests = photoTestsEnabled
		? {
				tests: photoTestList.map((test) => ({
					...test,
					startedAt: test.startedAt.toISOString(),
					endedAt: test.endedAt?.toISOString() ?? null,
				})),
				urls: await photoTestImageUrls(organization.id, photoTestList),
			}
		: null

	return {
		organization,
		dishPage,
		photoTests,
		defaultLocale,
		supportedLocales,
		slotLimitsEnabled: slotLimits.enabled,
		dailyLimitsEnabled,
		posLock,
		item: {
			id: item.id,
			displayName: item.displayName,
			internalName: item.internalName ?? '',
			kitchenName: item.kitchenName ?? JSON.stringify({ [defaultLocale]: '' }),
			kitchenHighlight: item.kitchenHighlight ?? 'none',
			description: item.description ?? '',
			price: item.price,
			imageKey: item.imageKey,
			imageUrl: item.imageUrl,
			images,
			variationImageUrls: Object.fromEntries(mediaUrlsByKey),
			variations: {
				...variations,
				variants: variations.variants.map((variant) => ({
					...variant,
					imageKey:
						variant.imageKey && mediaUrlsByKey.has(variant.imageKey)
							? variant.imageKey
							: null,
				})),
			},
			isAlcohol: item.isAlcohol,
			isGlutenFree: item.isGlutenFree,
			isVegetarian: item.isVegetarian,
			dietaryTags: dietaryTagsOf(item),
			orderTypePrices: parseOrderTypePrices(item.orderTypePrices),
			allergens,
			calorieMin: item.calorieMin,
			calorieMax: item.calorieMax,
			applySalesTax: item.applySalesTax,
			excludeFromOverride: item.excludeFromOverride,
			excludeFromDiscounts: item.excludeFromDiscounts,
			excludeFromOrderLimits: item.excludeFromOrderLimits,
			dailySaleLimit: parseDailySaleLimit(item.dailySaleLimit),
			isPopular: item.isPopular,
			popularMode: popularModeSchema
				.catch('auto')
				.parse(item.popularMode) as PopularMode,
			isUpsell: item.isUpsell,
			channels: parseMenuChannels(item.channels),
			availabilityStatus: item.availabilityStatus as
				'available' | 'unavailable_until_tomorrow' | 'unavailable',
			assignedCategoryIds: item.categoryAssignments.map((ca) => ca.categoryId),
			assignedModifierGroupIds: item.modifierGroupAssignments.map(
				(ma) => ma.modifierGroupId,
			),
			locationOverrides,
		},
		allCategories: allCategories.map((c) => ({
			id: c.id,
			displayName: c.displayName,
			internalName: c.internalName,
		})),
		allModifierGroups: allModifierGroups.map((g) => ({
			id: g.id,
			name: g.name,
			selectionType: g.selectionType,
		})),
		allLocations: allLocations.map((l) => ({
			id: l.id,
			name: l.name,
			slug: l.slug,
			isDefault: l.isDefault,
			timezone: l.timezone,
			storeHours: l.storeHours,
			onlineHours: l.onlineHours,
			specialHours: l.specialHours,
		})),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})

	const userId = await requireMenuWrite(request, organization.id)

	const itemId = params.itemId
	if (!itemId) {
		throw new Response('Item not found', { status: 404 })
	}

	await assertItemInOrganization(organization.id, itemId)

	const formData = await request.formData()
	const defaultLocale = organization.siteDefaultLocale ?? 'en'

	const overrideResponse = await handlePosFieldOverrideIntent({
		organization,
		userId,
		request,
		formData,
		entityType: 'item',
		entityId: itemId,
		defaultLocale,
	})
	if (overrideResponse) return overrideResponse

	if (formData.get('intent') === 'delete-item') {
		try {
			await assertCanDeleteMenuItem(organization.id, itemId)
		} catch (error) {
			if (error instanceof PosFieldLockedError) return error.toResponse()
			throw error
		}
		await db.transaction(async (tx) => {
			await tx
				.delete(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.id, itemId),
						eq(OrganizationMenuItem.organizationId, organization.id),
					),
				)
			await deleteMenuEntityReferences(organization.id, 'item', itemId, tx)
		})
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		await safeEnqueueMenuSync(organization.id, {
			kind: 'menu',
			entityType: 'all',
		})
		return redirect(`/${organization.slug}/menu/items`)
	}

	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if ((MENU_JSON_FORM_KEYS as readonly string[]).includes(key)) {
			rawData[key] = parseMenuJsonFormValue(value)
		} else if (
			key === 'allergens' ||
			key === 'imageKeys' ||
			key === 'variations' ||
			key === 'assignedCategoryIds' ||
			key === 'assignedModifierGroupIds'
		) {
			try {
				rawData[key] = JSON.parse(value as string)
			} catch {
				rawData[key] = []
			}
		} else if (key === 'locationOverrides') {
			try {
				rawData[key] = JSON.parse(value as string)
			} catch {
				rawData[key] = {}
			}
		} else if (
			key === 'isAlcohol' ||
			key === 'isGlutenFree' ||
			key === 'isVegetarian' ||
			key === 'applySalesTax' ||
			key === 'excludeFromOverride' ||
			key === 'excludeFromDiscounts' ||
			key === 'excludeFromOrderLimits' ||
			key === 'isPopular' ||
			key === 'isUpsell'
		) {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const channelsParsed = parseChannelsFormData(formData)
	if (!channelsParsed.ok) {
		return Response.json(
			{ error: { channels: ['Invalid channels'] } },
			{ status: 400 },
		)
	}

	const popularModeProvided = formData.has('popularMode')
	const popularModeParsed = popularModeProvided
		? popularModeSchema.safeParse(rawData.popularMode)
		: null
	if (popularModeParsed && !popularModeParsed.success) {
		return Response.json(
			{ error: { popularMode: ['Invalid popular mode'] } },
			{ status: 400 },
		)
	}

	const parsed = MenuItemInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data
	const rawOverrides =
		rawData.locationOverrides &&
		typeof rawData.locationOverrides === 'object' &&
		!Array.isArray(rawData.locationOverrides)
			? (rawData.locationOverrides as Record<string, { channels?: unknown }>)
			: undefined

	const imageKeys = parseMenuItemImageKeys(
		JSON.stringify(data.imageKeys),
		data.imageKey ?? null,
	)
	const primaryImageKey = imageKeys[0] ?? null
	const nextPrice = data.variations.variants.length
		? Math.min(...data.variations.variants.map((variant) => variant.price))
		: data.price
	const nextUnavailableUntil =
		(data.availabilityStatus === 'unavailable_until' ||
			data.availabilityStatus === 'unavailable_until_tomorrow') &&
		data.unavailableUntil
			? data.unavailableUntil
			: null

	const posLock = await lockedFieldsForOne(organization.id, 'item', itemId)
	if (posLock.isLinked) {
		const [currentRow, currentCats, currentGroups, currentLocOverrides] =
			await Promise.all([
				db
					.select()
					.from(OrganizationMenuItem)
					.where(
						and(
							eq(OrganizationMenuItem.id, itemId),
							eq(OrganizationMenuItem.organizationId, organization.id),
						),
					)
					.limit(1)
					.then((r) => r[0]),
				db
					.select({
						categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
					})
					.from(OrganizationMenuItemCategoryAssignment)
					.where(eq(OrganizationMenuItemCategoryAssignment.itemId, itemId))
					.orderBy(asc(OrganizationMenuItemCategoryAssignment.position)),
				db
					.select({
						modifierGroupId:
							OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
					})
					.from(OrganizationMenuItemModifierGroupAssignment)
					.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, itemId))
					.orderBy(asc(OrganizationMenuItemModifierGroupAssignment.position)),
				db
					.select()
					.from(OrganizationMenuLocationOverride)
					.where(
						and(
							eq(
								OrganizationMenuLocationOverride.organizationId,
								organization.id,
							),
							eq(OrganizationMenuLocationOverride.entityType, 'item'),
							eq(OrganizationMenuLocationOverride.entityId, itemId),
						),
					),
			])

		if (currentRow) {
			try {
				const changedPosFields = detectChangedItemPosFields({
					current: {
						displayName: currentRow.displayName,
						description: currentRow.description,
						price: currentRow.price,
						variations: currentRow.variations,
						imageKey: currentRow.imageKey,
						imageUrl: currentRow.imageUrl,
						imageKeys: currentRow.imageKeys,
						applySalesTax: currentRow.applySalesTax,
						availabilityStatus: currentRow.availabilityStatus,
						unavailableUntil: currentRow.unavailableUntil,
						categoryIds: currentCats.map((c) => c.categoryId),
						modifierGroupIds: currentGroups.map((g) => g.modifierGroupId),
					},
					next: {
						displayName: data.displayName,
						description: data.description || null,
						price: nextPrice,
						variations: data.variations,
						imageKeys,
						imageUrl: formData.has('imageUrl')
							? data.imageUrl || null
							: currentRow.imageUrl,
						applySalesTax: data.applySalesTax,
						availabilityStatus: data.availabilityStatus,
						unavailableUntil: nextUnavailableUntil,
						categoryIds: data.assignedCategoryIds,
						modifierGroupIds: data.assignedModifierGroupIds,
					},
					defaultLocale,
				})
				assertNoLockedFieldWrites(posLock, changedPosFields)

				const prevPriceByLoc = new Map(
					currentLocOverrides.map((ov) => [ov.locationId, ov.price ?? null]),
				)
				const incomingOverrides = data.locationOverrides ?? {}
				const allLocIds = new Set([
					...prevPriceByLoc.keys(),
					...Object.keys(incomingOverrides),
				])
				for (const locId of allLocIds) {
					const prevLocPrice = prevPriceByLoc.get(locId) ?? null
					const nextLocPrice = data.variations.groups.length
						? null
						: (incomingOverrides[locId]?.price ?? null)
					const priceDiffers =
						prevLocPrice === null || nextLocPrice === null
							? prevLocPrice !== nextLocPrice
							: Math.abs(prevLocPrice - nextLocPrice) > 1e-6
					if (priceDiffers) {
						assertNoLockedFieldWrites(posLock, ['price'], { locationId: locId })
					}
				}
			} catch (error) {
				if (error instanceof PosFieldLockedError) return error.toResponse()
				throw error
			}
		}
	}

	const [priorItemRow, priorLocOverrides] = await Promise.all([
		db
			.select({
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.id, itemId),
					eq(OrganizationMenuItem.organizationId, organization.id),
				),
			)
			.limit(1)
			.then((r) => r[0]),
		db
			.select({
				locationId: OrganizationMenuLocationOverride.locationId,
				availabilityStatus: OrganizationMenuLocationOverride.availabilityStatus,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organization.id),
					eq(OrganizationMenuLocationOverride.entityType, 'item'),
					eq(OrganizationMenuLocationOverride.entityId, itemId),
				),
			),
	])

	await db.transaction(async (tx) => {
		await assertMediaKeysInOrganization(
			organization.id,
			[
				...data.variations.variants.flatMap((variant) =>
					variant.imageKey ? [variant.imageKey] : [],
				),
				...data.imageKeys,
				...(data.imageKey ? [data.imageKey] : []),
			],
			tx,
		)
		await assertCategoryIdsInOrganization(
			organization.id,
			data.assignedCategoryIds,
			tx,
		)
		await assertModifierGroupIdsInOrganization(
			organization.id,
			data.assignedModifierGroupIds,
			tx,
		)
		await assertLocationIdsInOrganization(
			organization.id,
			Object.values(data.locationOverrides ?? {})
				.map((entry) => entry.locationId)
				.filter((id): id is string => typeof id === 'string'),
			tx,
		)
		await assertLocationIdsInOrganization(
			organization.id,
			dailyLimitLocationIds(data.dailySaleLimit),
			tx,
		)

		let effectiveBaseChannels = channelsParsed.channels
		let effectivePopularMode: PopularMode = popularModeParsed?.success
			? popularModeParsed.data
			: 'auto'
		if (!channelsParsed.provided || !popularModeProvided) {
			const [currentItem] = await tx
				.select({
					channels: OrganizationMenuItem.channels,
					popularMode: OrganizationMenuItem.popularMode,
				})
				.from(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.id, itemId),
						eq(OrganizationMenuItem.organizationId, organization.id),
					),
				)
			if (!channelsParsed.provided) {
				effectiveBaseChannels = parseMenuChannels(currentItem?.channels)
			}
			if (!popularModeProvided) {
				effectivePopularMode = popularModeSchema
					.catch('auto')
					.parse(currentItem?.popularMode)
			}
		}
		const nextIsPopular = effectiveIsPopularForMode(
			effectivePopularMode,
			data.isPopular,
		)

		// Update Item
		await tx
			.update(OrganizationMenuItem)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				kitchenName: storedKitchenName(data.kitchenName),
				kitchenHighlight: storedKitchenHighlight(data.kitchenHighlight),
				description: data.description || null,
				price: nextPrice,
				variations: JSON.stringify(data.variations),
				imageKey: primaryImageKey,
				imageUrl: primaryImageKey
					? data.imageUrl || null
					: data.imageUrl || null,
				imageKeys: JSON.stringify(imageKeys),
				isAlcohol: data.isAlcohol,
				...(await dietaryAndOrderTypeColumns(data, async () => {
					const [current] = await tx
						.select({ dietaryTags: OrganizationMenuItem.dietaryTags })
						.from(OrganizationMenuItem)
						.where(eq(OrganizationMenuItem.id, params.itemId ?? ''))
					return current?.dietaryTags
				})),
				allergens: JSON.stringify(data.allergens),
				calorieMin: data.calorieMin ?? null,
				calorieMax: data.calorieMax ?? null,
				applySalesTax: data.applySalesTax,
				excludeFromOverride: data.excludeFromOverride,
				excludeFromDiscounts: data.excludeFromDiscounts,
				excludeFromOrderLimits: data.excludeFromOrderLimits,
				...dailyLimitColumn(
					formData.has('dailySaleLimit'),
					data.dailySaleLimit,
				),
				popularMode: effectivePopularMode,
				isPopular: nextIsPopular,
				isUpsell: data.isUpsell,
				...(channelsParsed.provided
					? { channels: channelsParsed.serialized }
					: {}),
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenuItem.id, itemId),
					eq(OrganizationMenuItem.organizationId, organization.id),
				),
			)

		// Replace category assignments
		await tx
			.delete(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.itemId, itemId))

		if (data.assignedCategoryIds.length > 0) {
			await tx.insert(OrganizationMenuItemCategoryAssignment).values(
				data.assignedCategoryIds.map((categoryId, index) => ({
					categoryId,
					itemId,
					position: index,
				})),
			)
		}

		// Replace modifier group assignments
		await tx
			.delete(OrganizationMenuItemModifierGroupAssignment)
			.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, itemId))

		if (data.assignedModifierGroupIds.length > 0) {
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values(
				data.assignedModifierGroupIds.map((modifierGroupId, index) => ({
					itemId,
					modifierGroupId,
					position: index,
				})),
			)
		}

		// Replace location overrides
		await tx
			.delete(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organization.id),
					eq(OrganizationMenuLocationOverride.entityType, 'item'),
					eq(OrganizationMenuLocationOverride.entityId, itemId),
				),
			)

		const overrideEntries = Object.values(data.locationOverrides ?? {})
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'item',
					entityId: itemId,
					isEnabled: entry.isEnabled,
					price: data.variations.groups.length ? null : entry.price,
					availabilityStatus: entry.availabilityStatus,
					channels: narrowOverrideChannels(
						effectiveBaseChannels,
						rawOverrides?.[entry.locationId]?.channels,
					),
				})),
			)
		}
	})

	await recordMenuChange({
		organization,
		userId,
		request,
		resourceType: 'menu_item',
		resourceId: itemId,
		details: 'Menu item edited.',
	})

	// A photo change made here ends a running test of this dish: it would no
	// longer compare what is live (#192).
	await stopPhotoTestsForChangedDish({
		organizationId: organization.id,
		itemId,
		newMainKey: primaryImageKey,
	})

	const globalAvailabilityChanged =
		priorItemRow !== undefined &&
		(priorItemRow.availabilityStatus !== data.availabilityStatus ||
			(priorItemRow.unavailableUntil?.getTime() ?? null) !==
				(nextUnavailableUntil?.getTime() ?? null))
	const priorAvailByLoc = new Map(
		priorLocOverrides.map((ov) => [
			ov.locationId,
			ov.availabilityStatus ?? null,
		]),
	)
	const nextOverridesObj = data.locationOverrides ?? {}
	const changedOverrideLocations = [
		...new Set([...priorAvailByLoc.keys(), ...Object.keys(nextOverridesObj)]),
	].filter(
		(locId) =>
			(priorAvailByLoc.get(locId) ?? null) !==
			(nextOverridesObj[locId]?.availabilityStatus ?? null),
	)

	if (globalAvailabilityChanged) {
		await safeEnqueueMenuSync(organization.id, {
			kind: 'availability',
			entityType: 'item',
			entityId: itemId,
		})
	} else if (changedOverrideLocations.length > 0) {
		await safeEnqueueMenuSync(organization.id, {
			locationIds: changedOverrideLocations,
			kind: 'availability',
			entityType: 'item',
			entityId: itemId,
		})
	}
	await safeEnqueueMenuSync(organization.id, {
		kind: 'menu',
		entityType: 'all',
	})

	return redirect(`/${organization.slug}/menu/items`)
}

export default function EditItemRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		item,
		allCategories,
		allModifierGroups,
		allLocations,
		slotLimitsEnabled,
		dailyLimitsEnabled,
		posLock,
		dishPage,
		photoTests,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ItemForm
				pageTitle="Edit Item"
				initialData={item}
				itemId={item.id}
				dataRegion={organization.dataRegion}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allCategories={allCategories}
				allModifierGroups={allModifierGroups}
				allLocations={allLocations}
				slotLimitsEnabled={slotLimitsEnabled}
				dailyLimitsEnabled={dailyLimitsEnabled}
				posLock={posLock}
				isSubmitting={isSubmitting}
			/>
			{photoTests && item.imageKey ? (
				<div className="px-4 pb-6 md:px-2">
					<PhotoTestPanel
						orgSlug={organization.slug}
						itemId={item.id}
						tests={photoTests.tests}
						urls={photoTests.urls}
					/>
				</div>
			) : null}
			{dishPage ? (
				<div className="px-4 pb-6 md:px-2">
					<DishPageCard
						orgSlug={organization.slug}
						itemId={item.id}
						enabled={dishPage.enabled}
						slug={dishPage.slug}
					/>
				</div>
			) : null}
		</div>
	)
}
