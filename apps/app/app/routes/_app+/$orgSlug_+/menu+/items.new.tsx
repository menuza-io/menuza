import { requireUserId } from '@repo/auth'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
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
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})

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

	return {
		organization,
		defaultLocale,
		supportedLocales,
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
	})

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

	// Create Item
	const [newItem] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: organization.id,
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
		})
		.returning()

	if (!newItem) {
		throw new Error('Failed to create item')
	}

	// Insert Category Assignments
	if (assignedCategoryIds.length > 0) {
		await db.insert(OrganizationMenuItemCategoryAssignment).values(
			assignedCategoryIds.map((categoryId, index) => ({
				categoryId,
				itemId: newItem.id,
				position: index,
			})),
		)
	}

	// Insert Modifier Group Assignments
	if (assignedModifierGroupIds.length > 0) {
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values(
			assignedModifierGroupIds.map((modifierGroupId, index) => ({
				itemId: newItem.id,
				modifierGroupId,
				position: index,
			})),
		)
	}

	// Insert Location Overrides
	const overrideEntries = Object.values(locationOverrides)
	if (overrideEntries.length > 0) {
		await db.insert(OrganizationMenuLocationOverride).values(
			overrideEntries.map((entry: any) => ({
				organizationId: organization.id,
				locationId: entry.locationId,
				entityType: 'item',
				entityId: newItem.id,
				isEnabled: entry.isEnabled,
				price: entry.price,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

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
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
