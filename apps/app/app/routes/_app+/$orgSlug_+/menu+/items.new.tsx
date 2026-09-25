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
	assertCategoryIdsInOrganization,
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
		// Create Item
		const [newItem] = await tx
			.insert(OrganizationMenuItem)
			.values({
				organizationId: organization.id,
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
					price: entry.price,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

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
