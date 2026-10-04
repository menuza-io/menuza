import { requireUserId } from '@repo/auth'
import { DropInputSchema } from '@repo/common/menu-types'
import {
	db,
	eq,
	inArray,
	asc,
	desc,
	OrganizationLocation,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
} from 'react-router'
import { DropForm } from '#app/components/menu/drop-wizard/drop-form.tsx'
import { saveDrop } from '#app/utils/menu/drops.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const locations = await db.query.OrganizationLocation.findMany({
		where: eq(OrganizationLocation.organizationId, organization.id),
		orderBy: [
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		],
	})

	const categories = await db.query.OrganizationMenuCategory.findMany({
		where: eq(OrganizationMenuCategory.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuCategory.position)],
	})

	const categoryIds = categories.map((c) => c.id)
	const itemAssignments = categoryIds.length
		? await db
				.select()
				.from(OrganizationMenuItemCategoryAssignment)
				.where(
					inArray(
						OrganizationMenuItemCategoryAssignment.categoryId,
						categoryIds,
					),
				)
				.orderBy(asc(OrganizationMenuItemCategoryAssignment.position))
		: []

	const items = await db.query.OrganizationMenuItem.findMany({
		where: eq(OrganizationMenuItem.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuItem.position)],
	})

	const itemsMap = new Map(items.map((i) => [i.id, i]))

	const formattedCategories = categories.map((cat) => {
		const assigned = itemAssignments
			.filter((ia) => ia.categoryId === cat.id)
			.map((ia) => itemsMap.get(ia.itemId))
			.filter(Boolean)

		return {
			id: cat.id,
			displayName: cat.displayName,
			items: assigned.map((item) => ({
				id: item!.id,
				displayName: item!.displayName,
				price: item!.price,
				imageKey: item!.imageKey,
			})),
		}
	})

	return {
		orgSlug: organization.slug,
		locations: locations.map((l) => ({
			id: l.id,
			name: l.name,
			timezone: l.timezone ?? undefined,
		})),
		availableCategories: formattedCategories,
		availableItems: items.map((i) => ({
			id: i.id,
			displayName: i.displayName,
			price: i.price,
			imageKey: i.imageKey,
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
			key === 'pickupWindows' ||
			key === 'assignedCategoryIds' ||
			key === 'inventoryOverrides' ||
			key === 'reminders'
		) {
			try {
				rawData[key] = JSON.parse(value as string)
			} catch {
				rawData[key] = []
			}
		} else if (
			key === 'showOrdersOpenTime' ||
			key === 'showMenuPreview' ||
			key === 'showInventoryRemaining' ||
			key === 'includeGiftCard'
		) {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const parsed = DropInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const assignedCategoryIds = Array.isArray(rawData.assignedCategoryIds)
		? (rawData.assignedCategoryIds as string[])
		: []

	const dropId = await saveDrop(organization.id, {
		...parsed.data,
		assignedCategoryIds,
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/drops/${dropId}`)
}

export default function DropNewRoute() {
	const { orgSlug, locations, availableCategories, availableItems } =
		useLoaderData<typeof loader>()

	return (
		<DropForm
			orgSlug={orgSlug}
			locations={locations}
			availableCategories={availableCategories}
			availableItems={availableItems}
			isEdit={false}
		/>
	)
}
