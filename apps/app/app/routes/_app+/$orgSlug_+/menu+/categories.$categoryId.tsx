import { requireUserId } from '@repo/auth'
import { MenuCategoryInputSchema } from '@repo/common/menu-types'
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
import {
	assertCategoryIdsInOrganization,
	assertCategoryInOrganization,
	assertItemIdsInOrganization,
	assertLocationIdsInOrganization,
	assertMenuInOrganization,
	assertValidParentCategoryInOrganization,
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
			parentId: category.parentId ?? null,
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
		allCategories: allCategories.map((c) => ({
			id: c.id,
			displayName: c.displayName,
			parentId: c.parentId ?? null,
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

	await assertCategoryInOrganization(organization.id, categoryId)

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (
			key === 'assignedItemIds' ||
			key === 'assignedMenuIds' ||
			key === 'upsellCategoryIds'
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
		} else if (key === 'excludeFromOverride') {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const parsed = MenuCategoryInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data

	if (data.parentId) {
		await assertValidParentCategoryInOrganization(
			organization.id,
			categoryId,
			data.parentId,
		)
	}
	await assertCategoryIdsInOrganization(organization.id, data.upsellCategoryIds)
	await assertItemIdsInOrganization(organization.id, data.assignedItemIds)
	for (const menuId of data.assignedMenuIds) {
		await assertMenuInOrganization(organization.id, menuId)
	}
	await assertLocationIdsInOrganization(
		organization.id,
		Object.values(data.locationOverrides ?? {})
			.map((entry) => entry.locationId)
			.filter((id): id is string => typeof id === 'string'),
	)

	await db.transaction(async (tx) => {
		// Update Category
		await tx
			.update(OrganizationMenuCategory)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				description: data.description || null,
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				availabilityHours: data.availabilityHours || null,
				excludeFromOverride: data.excludeFromOverride,
				upsellCategoryIds: JSON.stringify(data.upsellCategoryIds),
				parentId: data.parentId || null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenuCategory.id, categoryId),
					eq(OrganizationMenuCategory.organizationId, organization.id),
				),
			)

		// Replace item assignments
		await tx
			.delete(OrganizationMenuItemCategoryAssignment)
			.where(eq(OrganizationMenuItemCategoryAssignment.categoryId, categoryId))

		if (data.assignedItemIds.length > 0) {
			await tx.insert(OrganizationMenuItemCategoryAssignment).values(
				data.assignedItemIds.map((itemId, index) => ({
					categoryId,
					itemId,
					position: index,
				})),
			)
		}

		// Replace menu assignments
		await tx
			.delete(OrganizationMenuCategoryAssignment)
			.where(eq(OrganizationMenuCategoryAssignment.categoryId, categoryId))

		if (data.assignedMenuIds.length > 0) {
			await tx.insert(OrganizationMenuCategoryAssignment).values(
				data.assignedMenuIds.map((menuId, index) => ({
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
					eq(OrganizationMenuLocationOverride.entityType, 'category'),
					eq(OrganizationMenuLocationOverride.entityId, categoryId),
				),
			)

		const overrideEntries = Object.values(data.locationOverrides ?? {})
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'category',
					entityId: categoryId,
					isEnabled: entry.isEnabled,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

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
				categoryId={category.id}
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
