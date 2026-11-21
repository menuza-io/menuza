import { requireUserId } from '@repo/auth'
import { popularModeSchema } from '@repo/common/menu-popular'
import {
	MenuItemInputSchema,
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
	OrganizationMenuItem,
	OrganizationMenuCategory,
	OrganizationMenuModifierGroup,
	OrganizationLocation,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { ItemForm } from '#app/components/menu/item-form.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { effectiveIsPopularForMode } from '#app/utils/menu/auto-popular.server.ts'
import {
	dailyLimitColumn,
	dailyLimitLocationIds,
} from '#app/utils/menu/daily-limit-save.ts'
import { autoTranslateNewItem } from '#app/utils/menu/menu-auto-translate.server.ts'
import {
	dietaryAndOrderTypeColumns,
	MENU_JSON_FORM_KEYS,
	narrowOverrideChannels,
	parseChannelsFormData,
	parseMenuJsonFormValue,
} from '#app/utils/menu/menu-write-columns.ts'
import {
	assertCategoryIdsInOrganization,
	assertLocationIdsInOrganization,
	assertMediaKeysInOrganization,
	assertModifierGroupIdsInOrganization,
} from '#app/utils/menu/ownership.server.ts'
import { isDailyDishLimitsEnabled } from '#app/utils/orders/daily-dish-limits.server.ts'
import { buildSlotLimitsContext } from '#app/utils/orders/slot-limits.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})

	await requireMenuRead(request, organization.id)

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = localesConfig.defaultLocale
	const supportedLocales = localesConfig.locales

	const url = new URL(request.url)
	const initialCategoryId = url.searchParams.get('categoryId')

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

	const slotLimits = await buildSlotLimitsContext(organization.id)
	const dailyLimitsEnabled = await isDailyDishLimitsEnabled(organization.id)

	return {
		organization,
		defaultLocale,
		supportedLocales,
		slotLimitsEnabled: slotLimits.enabled,
		dailyLimitsEnabled,
		initialCategoryId,
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
		siteLocales: true,
	})

	const userId = await requireMenuWrite(request, organization.id)

	const formData = await request.formData()
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

	const popularModeParsed = formData.has('popularMode')
		? popularModeSchema.safeParse(rawData.popularMode)
		: { success: true as const, data: 'auto' as const }
	if (!popularModeParsed.success) {
		return Response.json(
			{ error: { popularMode: ['Invalid popular mode'] } },
			{ status: 400 },
		)
	}
	const popularMode = popularModeParsed.data

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

	const newItemId = await db.transaction(async (tx) => {
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

		// Create Item
		const [newItem] = await tx
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
				displayName: data.displayName,
				internalName: data.internalName || null,
				kitchenName: storedKitchenName(data.kitchenName),
				kitchenHighlight: storedKitchenHighlight(data.kitchenHighlight),
				description: data.description || null,
				price: data.variations.variants.length
					? Math.min(
							...data.variations.variants.map((variant) => variant.price),
						)
					: data.price,
				variations: JSON.stringify(data.variations),
				imageKey: primaryImageKey,
				imageUrl: primaryImageKey ? data.imageUrl || null : null,
				imageKeys: JSON.stringify(imageKeys),
				isAlcohol: data.isAlcohol,
				...(await dietaryAndOrderTypeColumns(data)),
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
				popularMode,
				isPopular: effectiveIsPopularForMode(popularMode, data.isPopular),
				isUpsell: data.isUpsell,
				channels: channelsParsed.serialized,
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
			})
			.returning()

		if (!newItem) {
			throw new Error('Failed to create item')
		}

		// Insert Category Assignments
		if (data.assignedCategoryIds.length > 0) {
			await tx.insert(OrganizationMenuItemCategoryAssignment).values(
				data.assignedCategoryIds.map((categoryId, index) => ({
					categoryId,
					itemId: newItem.id,
					position: index,
				})),
			)
		}

		// Insert Modifier Group Assignments
		if (data.assignedModifierGroupIds.length > 0) {
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values(
				data.assignedModifierGroupIds.map((modifierGroupId, index) => ({
					itemId: newItem.id,
					modifierGroupId,
					position: index,
				})),
			)
		}

		// Insert Location Overrides
		const overrideEntries = Object.values(data.locationOverrides ?? {})
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'item',
					entityId: newItem.id,
					isEnabled: entry.isEnabled,
					price: data.variations.groups.length ? null : entry.price,
					availabilityStatus: entry.availabilityStatus,
					channels: narrowOverrideChannels(
						channelsParsed.channels,
						rawOverrides?.[entry.locationId]?.channels,
					),
				})),
			)
		}

		return newItem.id
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	// "Translate new dishes automatically" (Menu health, Review suggestions):
	// fills the other languages' empty name and description. It never fails
	// the create; it purges the cache again only when it wrote something.
	await autoTranslateNewItem({
		organization,
		userId,
		request,
		itemId: newItemId,
		displayName: data.displayName,
		description: data.description || null,
	})

	return redirect(`/${organization.slug}/menu/items`)
}

export default function CreateItemRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		initialCategoryId,
		allCategories,
		allModifierGroups,
		allLocations,
		slotLimitsEnabled,
		dailyLimitsEnabled,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ItemForm
				pageTitle="Create Item"
				initialData={
					initialCategoryId
						? { assignedCategoryIds: [initialCategoryId] }
						: undefined
				}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allCategories={allCategories}
				allModifierGroups={allModifierGroups}
				allLocations={allLocations}
				slotLimitsEnabled={slotLimitsEnabled}
				dailyLimitsEnabled={dailyLimitsEnabled}
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
