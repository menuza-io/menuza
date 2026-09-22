import { requireUserId } from '@repo/auth'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	and,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenu,
	OrganizationLocation,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { CategoryForm } from '#app/components/menu/category-form.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})

	const categoryId = params.categoryId
	if (!categoryId) {
		throw new Response('Category not found', { status: 404 })
	}

	const category = await db.query.OrganizationMenuCategory.findFirst({
		where: and(
			eq(OrganizationMenuCategory.id, categoryId),
			eq(OrganizationMenuCategory.organizationId, organization.id),
		),
		with: {
			itemAssignments: {
				orderBy: [asc(OrganizationMenuItemCategoryAssignment.position)],
			},
			menuAssignments: {
				orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
			},
		},
	})

	if (!category) {
		throw new Response('Category not found', { status: 404 })
	}

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = localesConfig.defaultLocale
	const supportedLocales = localesConfig.locales

	const allItems = await db.query.OrganizationMenuItem.findMany({
		where: eq(OrganizationMenuItem.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuItem.position)],
	})

	const allMenus = await db.query.OrganizationMenu.findMany({
		where: eq(OrganizationMenu.organizationId, organization.id),
		orderBy: [asc(OrganizationMenu.position)],
	})

	const allCategories = await db.query.OrganizationMenuCategory.findMany({
		where: and(
			eq(OrganizationMenuCategory.organizationId, organization.id),
			// Exclude self from upsell list
		),
		orderBy: [asc(OrganizationMenuCategory.position)],
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
				eq(OrganizationMenuLocationOverride.entityType, 'category'),
				eq(OrganizationMenuLocationOverride.entityId, category.id),
			),
		})

	const locationOverrides: Record<string, any> = {}
	for (const ov of existingOverrides) {
		locationOverrides[ov.locationId] = {
			locationId: ov.locationId,
			isEnabled: ov.isEnabled ?? true,
			availabilityStatus: ov.availabilityStatus,
		}
	}

	let upsellCategoryIds: string[] = []
	try {
		if (category.upsellCategoryIds) {
			upsellCategoryIds = JSON.parse(category.upsellCategoryIds) as string[]
		}
	} catch {}

	return {
		organization,
		defaultLocale,
		supportedLocales,
		category: {
			id: category.id,
			displayName: category.displayName,
			internalName: category.internalName ?? '',
			description: category.description ?? '',
			availabilityStatus: category.availabilityStatus as
				'available' | 'unavailable_until_tomorrow' | 'unavailable',
			availabilityHours: category.availabilityHours ?? '',
			excludeFromOverride: category.excludeFromOverride,
			assignedItemIds: category.itemAssignments.map((ia) => ia.itemId),
			assignedMenuIds: category.menuAssignments.map((ma) => ma.menuId),
			upsellCategoryIds,
			locationOverrides,
		},
		allItems: allItems.map((i) => ({
			id: i.id,
			displayName: i.displayName,
			internalName: i.internalName,
			price: i.price,
		})),
		allMenus: allMenus.map((m) => ({
			id: m.id,
			displayName: m.displayName,
		})),
		allCategories: allCategories
			.filter((c) => c.id !== category.id)
			.map((c) => ({
				id: c.id,
				displayName: c.displayName,
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

	const categoryId = params.categoryId
	if (!categoryId) {
		throw new Response('Category not found', { status: 404 })
	}

	const formData = await request.formData()
	const displayName = String(formData.get('displayName') || '')
	const internalName = String(formData.get('internalName') || '') || null
	const description = String(formData.get('description') || '') || null
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
	const availabilityHours =
		String(formData.get('availabilityHours') || '') || null
	const excludeFromOverride = formData.get('excludeFromOverride') === 'true'

	const assignedItemIdsRaw = String(formData.get('assignedItemIds') || '[]')
	let assignedItemIds: string[] = []
	try {
		assignedItemIds = JSON.parse(assignedItemIdsRaw) as string[]
	} catch {}

	const assignedMenuIdsRaw = String(formData.get('assignedMenuIds') || '[]')
	let assignedMenuIds: string[] = []
	try {
		assignedMenuIds = JSON.parse(assignedMenuIdsRaw) as string[]
	} catch {}

	const upsellCategoryIdsRaw = String(formData.get('upsellCategoryIds') || '[]')
	let upsellCategoryIds: string[] = []
	try {
		upsellCategoryIds = JSON.parse(upsellCategoryIdsRaw) as string[]
	} catch {}

	const locationOverridesRaw = String(formData.get('locationOverrides') || '{}')
	let locationOverrides: Record<string, any> = {}
	try {
		locationOverrides = JSON.parse(locationOverridesRaw) as Record<string, any>
	} catch {}

	// Update Category
	await db
		.update(OrganizationMenuCategory)
		.set({
			displayName,
			internalName,
			description,
			availabilityStatus,
			unavailableUntil,
			availabilityHours,
			excludeFromOverride,
			upsellCategoryIds: JSON.stringify(upsellCategoryIds),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(OrganizationMenuCategory.id, categoryId),
				eq(OrganizationMenuCategory.organizationId, organization.id),
			),
		)

	// Replace item assignments
	await db
		.delete(OrganizationMenuItemCategoryAssignment)
		.where(eq(OrganizationMenuItemCategoryAssignment.categoryId, categoryId))

	if (assignedItemIds.length > 0) {
		await db.insert(OrganizationMenuItemCategoryAssignment).values(
			assignedItemIds.map((itemId, index) => ({
				categoryId,
				itemId,
				position: index,
			})),
		)
	}

	// Replace menu assignments
	await db
		.delete(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.categoryId, categoryId))

	if (assignedMenuIds.length > 0) {
		await db.insert(OrganizationMenuCategoryAssignment).values(
			assignedMenuIds.map((menuId, index) => ({
				menuId,
				categoryId,
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
				eq(OrganizationMenuLocationOverride.entityType, 'category'),
				eq(OrganizationMenuLocationOverride.entityId, categoryId),
			),
		)

	const overrideEntries = Object.values(locationOverrides)
	if (overrideEntries.length > 0) {
		await db.insert(OrganizationMenuLocationOverride).values(
			overrideEntries.map((entry: any) => ({
				organizationId: organization.id,
				locationId: entry.locationId,
				entityType: 'category',
				entityId: categoryId,
				isEnabled: entry.isEnabled,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

	return redirect(`/${organization.slug}/menu/categories`)
}

export default function EditCategoryRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		category,
		allItems,
		allMenus,
		allCategories,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<CategoryForm
				pageTitle="Edit Category"
				initialData={category}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allItems={allItems}
				allMenus={allMenus}
				allCategories={allCategories}
				allLocations={allLocations}
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
