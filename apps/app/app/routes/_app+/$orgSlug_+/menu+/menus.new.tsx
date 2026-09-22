import { requireUserId } from '@repo/auth'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationLocation,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { MenuForm } from '#app/components/menu/menu-form.tsx'
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
		allCategories: allCategories.map((c) => ({
			id: c.id,
			displayName: c.displayName,
			internalName: c.internalName,
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
	const menuType = String(formData.get('menuType') || 'online_pos_kiosk')
	const nutritionalInfo = formData.get('nutritionalInfo') === 'true'
	const specialInstructions = formData.get('specialInstructions') === 'true'
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

	const assignedCategoryIdsRaw = String(
		formData.get('assignedCategoryIds') || '[]',
	)
	let assignedCategoryIds: string[] = []
	try {
		assignedCategoryIds = JSON.parse(assignedCategoryIdsRaw) as string[]
	} catch {}

	const locationOverridesRaw = String(formData.get('locationOverrides') || '{}')
	let locationOverrides: Record<string, any> = {}
	try {
		locationOverrides = JSON.parse(locationOverridesRaw) as Record<string, any>
	} catch {}

	// Create Menu
	const [newMenu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: organization.id,
			displayName,
			internalName,
			menuType,
			nutritionalInfo,
			specialInstructions,
			availabilityStatus,
			unavailableUntil,
			availabilityHours,
		})
		.returning()

	if (!newMenu) {
		throw new Error('Failed to create menu')
	}

	// Insert Category Assignments
	if (assignedCategoryIds.length > 0) {
		await db.insert(OrganizationMenuCategoryAssignment).values(
			assignedCategoryIds.map((categoryId, index) => ({
				menuId: newMenu.id,
				categoryId,
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
				entityType: 'menu',
				entityId: newMenu.id,
				isEnabled: entry.isEnabled,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

	return redirect(`/${organization.slug}/menu/menus`)
}

export default function CreateMenuRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		allCategories,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<MenuForm
				pageTitle="Create Menu"
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allCategories={allCategories}
				allLocations={allLocations}
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
