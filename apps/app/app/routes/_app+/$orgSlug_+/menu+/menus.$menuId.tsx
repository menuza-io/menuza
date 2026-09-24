import { requireUserId } from '@repo/auth'
import { MenuInputSchema } from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	and,
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
import {
	assertCategoryIdsInOrganization,
	assertLocationIdsInOrganization,
	assertMenuInOrganization,
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

	const menuId = params.menuId
	if (!menuId) {
		throw new Response('Menu not found', { status: 404 })
	}

	const menu = await db.query.OrganizationMenu.findFirst({
		where: and(
			eq(OrganizationMenu.id, menuId),
			eq(OrganizationMenu.organizationId, organization.id),
		),
		with: {
			categoryAssignments: {
				orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
			},
		},
	})

	if (!menu) {
		throw new Response('Menu not found', { status: 404 })
	}

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

	// Load existing overrides
	const existingOverrides =
		await db.query.OrganizationMenuLocationOverride.findMany({
			where: and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'menu'),
				eq(OrganizationMenuLocationOverride.entityId, menu.id),
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

	return {
		organization,
		defaultLocale,
		supportedLocales,
		menu: {
			id: menu.id,
			displayName: menu.displayName,
			internalName: menu.internalName ?? '',
			menuType: menu.menuType as 'online_pos_kiosk' | 'catering',
			nutritionalInfo: menu.nutritionalInfo,
			specialInstructions: menu.specialInstructions,
			availabilityStatus: menu.availabilityStatus as
				'available' | 'unavailable_until_tomorrow' | 'unavailable',
			availabilityHours: menu.availabilityHours ?? '',
			assignedCategoryIds: menu.categoryAssignments.map((ca) => ca.categoryId),
			locationOverrides,
		},
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

	const menuId = params.menuId
	if (!menuId) {
		throw new Response('Menu not found', { status: 404 })
	}

	await assertMenuInOrganization(organization.id, menuId)

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (key === 'assignedCategoryIds') {
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
		} else if (key === 'nutritionalInfo' || key === 'specialInstructions') {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const parsed = MenuInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data

	await assertCategoryIdsInOrganization(
		organization.id,
		data.assignedCategoryIds,
	)
	await assertLocationIdsInOrganization(
		organization.id,
		Object.values(data.locationOverrides ?? {})
			.map((entry) => entry.locationId)
			.filter((id): id is string => typeof id === 'string'),
	)

	await db.transaction(async (tx) => {
		// Update Menu
		await tx
			.update(OrganizationMenu)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				menuType: data.menuType,
				nutritionalInfo: data.nutritionalInfo,
				specialInstructions: data.specialInstructions,
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				availabilityHours: data.availabilityHours || null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organization.id),
				),
			)

		// Replace category assignments
		await tx
			.delete(OrganizationMenuCategoryAssignment)
			.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))

		if (data.assignedCategoryIds.length > 0) {
			await tx.insert(OrganizationMenuCategoryAssignment).values(
				data.assignedCategoryIds.map((categoryId, index) => ({
					menuId,
					categoryId,
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
					eq(OrganizationMenuLocationOverride.entityType, 'menu'),
					eq(OrganizationMenuLocationOverride.entityId, menuId),
				),
			)

		const overrideEntries = Object.values(data.locationOverrides ?? {})
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'menu',
					entityId: menuId,
					isEnabled: entry.isEnabled,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/menus`)
}

export default function EditMenuRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		menu,
		allCategories,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<MenuForm
				pageTitle="Edit Menu"
				initialData={menu}
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
