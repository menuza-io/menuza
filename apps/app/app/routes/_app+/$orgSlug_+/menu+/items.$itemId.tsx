import { requireUserId } from '@repo/auth'
import {
	MenuItemInputSchema,
	parseMenuItemImageKeys,
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
import { ItemForm } from '#app/components/menu/item-form.tsx'
import {
	assertCategoryIdsInOrganization,
	assertItemInOrganization,
	assertLocationIdsInOrganization,
	assertModifierGroupIdsInOrganization,
} from '#app/utils/menu/ownership.server.ts'
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
	const mediaAssets =
		imageKeys.length > 0
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
								inArray(OrganizationMediaAsset.id, imageKeys),
								inArray(OrganizationMediaAsset.objectKey, imageKeys),
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
		}
	}

	let allergens: string[] = []
	try {
		if (item.allergens) allergens = JSON.parse(item.allergens) as string[]
	} catch {}

	return {
		organization,
		defaultLocale,
		supportedLocales,
		item: {
			id: item.id,
			displayName: item.displayName,
			internalName: item.internalName ?? '',
			description: item.description ?? '',
			price: item.price,
			imageKey: item.imageKey,
			imageUrl: item.imageUrl,
			images,
			isAlcohol: item.isAlcohol,
			isGlutenFree: item.isGlutenFree,
			isVegetarian: item.isVegetarian,
			allergens,
			calorieMin: item.calorieMin,
			calorieMax: item.calorieMax,
			applySalesTax: item.applySalesTax,
			excludeFromOverride: item.excludeFromOverride,
			isPopular: item.isPopular,
			isUpsell: item.isUpsell,
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
	})

	const itemId = params.itemId
	if (!itemId) {
		throw new Response('Item not found', { status: 404 })
	}

	await assertItemInOrganization(organization.id, itemId)

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (
			key === 'allergens' ||
			key === 'imageKeys' ||
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
			key === 'isPopular' ||
			key === 'isUpsell'
		) {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const parsed = MenuItemInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data

	const imageKeys = parseMenuItemImageKeys(
		JSON.stringify(data.imageKeys),
		data.imageKey ?? null,
	)
	const primaryImageKey = imageKeys[0] ?? null

	await assertCategoryIdsInOrganization(
		organization.id,
		data.assignedCategoryIds,
	)
	await assertModifierGroupIdsInOrganization(
		organization.id,
		data.assignedModifierGroupIds,
	)
	await assertLocationIdsInOrganization(
		organization.id,
		Object.values(data.locationOverrides ?? {})
			.map((entry) => entry.locationId)
			.filter((id): id is string => typeof id === 'string'),
	)

	await db.transaction(async (tx) => {
		// Update Item
		await tx
			.update(OrganizationMenuItem)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				description: data.description || null,
				price: data.price,
				imageKey: primaryImageKey,
				imageUrl: primaryImageKey ? data.imageUrl || null : null,
				imageKeys: JSON.stringify(imageKeys),
				isAlcohol: data.isAlcohol,
				isGlutenFree: data.isGlutenFree,
				isVegetarian: data.isVegetarian,
				allergens: JSON.stringify(data.allergens),
				calorieMin: data.calorieMin ?? null,
				calorieMax: data.calorieMax ?? null,
				applySalesTax: data.applySalesTax,
				excludeFromOverride: data.excludeFromOverride,
				isPopular: data.isPopular,
				isUpsell: data.isUpsell,
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
					price: entry.price,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

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
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ItemForm
				pageTitle="Edit Item"
				initialData={item}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allCategories={allCategories}
				allModifierGroups={allModifierGroups}
				allLocations={allLocations}
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
