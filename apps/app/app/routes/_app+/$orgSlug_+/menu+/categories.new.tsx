import { requireUserId } from '@repo/auth'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
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
		where: eq(OrganizationMenuCategory.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuCategory.position)],
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
		allCategories: allCategories.map((c) => ({
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

	// Create Category
	const [newCat] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId: organization.id,
			displayName,
			internalName,
			description,
			availabilityStatus,
			unavailableUntil,
			availabilityHours,
			excludeFromOverride,
			upsellCategoryIds: JSON.stringify(upsellCategoryIds),
		})
		.returning()

	if (!newCat) {
		throw new Error('Failed to create category')
	}

	// Insert Item Assignments
	if (assignedItemIds.length > 0) {
		await db.insert(OrganizationMenuItemCategoryAssignment).values(
			assignedItemIds.map((itemId, index) => ({
				categoryId: newCat.id,
				itemId,
				position: index,
			})),
		)
	}

	// Insert Menu Assignments
	if (assignedMenuIds.length > 0) {
		await db.insert(OrganizationMenuCategoryAssignment).values(
			assignedMenuIds.map((menuId, index) => ({
				menuId,
				categoryId: newCat.id,
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
				entityType: 'category',
				entityId: newCat.id,
				isEnabled: entry.isEnabled,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

	return redirect(`/${organization.slug}/menu/categories`)
}

export default function CreateCategoryRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
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
				pageTitle="Create Category"
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
