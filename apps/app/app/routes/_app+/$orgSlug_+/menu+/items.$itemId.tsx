import { requireUserId } from '@repo/auth'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
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
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

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

	const formData = await request.formData()
	const displayName = String(formData.get('displayName') || '')
	const internalName = String(formData.get('internalName') || '') || null
	const description = String(formData.get('description') || '') || null
	const price = parseFloat(String(formData.get('price') || '0')) || 0
	const imageKey = String(formData.get('imageKey') || '') || null
	const imageUrl = String(formData.get('imageUrl') || '') || null
	const imageKeys = parseMenuItemImageKeys(
		String(formData.get('imageKeys') || '[]'),
		imageKey,
	)
	const primaryImageKey = imageKeys[0] ?? null

	const isAlcohol = formData.get('isAlcohol') === 'true'
	const isGlutenFree = formData.get('isGlutenFree') === 'true'
	const isVegetarian = formData.get('isVegetarian') === 'true'

	const allergensRaw = String(formData.get('allergens') || '[]')
	let allergens: string[] = []
	try {
		allergens = JSON.parse(allergensRaw) as string[]
	} catch {}

	const calorieMinStr = String(formData.get('calorieMin') || '')
	const calorieMaxStr = String(formData.get('calorieMax') || '')
	const calorieMin = calorieMinStr ? parseInt(calorieMinStr, 10) : null
	const calorieMax = calorieMaxStr ? parseInt(calorieMaxStr, 10) : null

	const applySalesTax = formData.get('applySalesTax') === 'true'
	const excludeFromOverride = formData.get('excludeFromOverride') === 'true'
	const isPopular = formData.get('isPopular') === 'true'
	const isUpsell = formData.get('isUpsell') === 'true'
	const availabilityStatus = String(
		formData.get('availabilityStatus') || 'available',
	)
	const unavailableUntilRaw = String(formData.get('unavailableUntil') || '')
	const unavailableUntil =
		(availabilityStatus === 'unavailable_until' ||
			availabilityStatus === 'unavailable_until_tomorrow') &&
		unavailableUntilRaw
			? new Date(unavailableUntilRaw)
			: null

	const assignedCategoryIdsRaw = String(
		formData.get('assignedCategoryIds') || '[]',
	)
	let assignedCategoryIds: string[] = []
	try {
		assignedCategoryIds = JSON.parse(assignedCategoryIdsRaw) as string[]
	} catch {}

	const assignedModifierGroupIdsRaw = String(
		formData.get('assignedModifierGroupIds') || '[]',
	)
	let assignedModifierGroupIds: string[] = []
	try {
		assignedModifierGroupIds = JSON.parse(
			assignedModifierGroupIdsRaw,
		) as string[]
	} catch {}

	const locationOverridesRaw = String(formData.get('locationOverrides') || '{}')
	let locationOverrides: Record<string, any> = {}
	try {
		locationOverrides = JSON.parse(locationOverridesRaw) as Record<string, any>
	} catch {}

	// Update Item
	await db
		.update(OrganizationMenuItem)
		.set({
			displayName,
			internalName,
			description,
			price,
			imageKey: primaryImageKey,
			imageUrl: primaryImageKey ? imageUrl : null,
			imageKeys: JSON.stringify(imageKeys),
			isAlcohol,
			isGlutenFree,
			isVegetarian,
			allergens: JSON.stringify(allergens),
			calorieMin,
			calorieMax,
			applySalesTax,
			excludeFromOverride,
			isPopular,
			isUpsell,
			availabilityStatus,
			unavailableUntil,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(OrganizationMenuItem.id, itemId),
				eq(OrganizationMenuItem.organizationId, organization.id),
			),
		)

	// Replace category assignments
	await db
		.delete(OrganizationMenuItemCategoryAssignment)
		.where(eq(OrganizationMenuItemCategoryAssignment.itemId, itemId))

	if (assignedCategoryIds.length > 0) {
		await db.insert(OrganizationMenuItemCategoryAssignment).values(
			assignedCategoryIds.map((categoryId, index) => ({
				categoryId,
				itemId,
				position: index,
			})),
		)
	}

	// Replace modifier group assignments
	await db
		.delete(OrganizationMenuItemModifierGroupAssignment)
		.where(eq(OrganizationMenuItemModifierGroupAssignment.itemId, itemId))

	if (assignedModifierGroupIds.length > 0) {
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values(
			assignedModifierGroupIds.map((modifierGroupId, index) => ({
				itemId,
				modifierGroupId,
				position: index,
			})),
		)
	}

	// Replace location overrides
	await db
		.delete(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'item'),
				eq(OrganizationMenuLocationOverride.entityId, itemId),
			),
		)

	const overrideEntries = Object.values(locationOverrides)
	if (overrideEntries.length > 0) {
		await db.insert(OrganizationMenuLocationOverride).values(
			overrideEntries.map((entry: any) => ({
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
