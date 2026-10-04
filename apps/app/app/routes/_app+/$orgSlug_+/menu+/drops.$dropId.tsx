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
import {
	assertDropInOrganization,
	getDropWithDetails,
	saveDrop,
} from '#app/utils/menu/drops.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const dropId = params.dropId
	if (!dropId) {
		throw new Response('Drop not found', { status: 404 })
	}

	await assertDropInOrganization(organization.id, dropId)

	const drop = await getDropWithDetails(organization.id, dropId)
	if (!drop) {
		throw new Response('Drop not found', { status: 404 })
	}

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

	const assignedCategoryIds =
		drop.menu?.categoryAssignments.map((ca) => ca.categoryId) || []

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
		initialData: {
			id: drop.id,
			title: drop.title,
			slug: drop.slug,
			description: drop.description,
			coverImageKey: drop.coverImageKey,
			coverImageUrl: drop.coverImageUrl,
			status: drop.status as any,
			ordersOpenAt: drop.ordersOpenAt,
			ordersCloseAt: drop.ordersCloseAt,
			visibility: drop.visibility as any,
			checkoutHoldMinutes: drop.checkoutHoldMinutes,
			showOrdersOpenTime: drop.showOrdersOpenTime,
			showMenuPreview: drop.showMenuPreview,
			showInventoryRemaining: drop.showInventoryRemaining,
			includeGiftCard: drop.includeGiftCard,
			pickupWindows: drop.pickupWindows.map((pw) => ({
				id: pw.id,
				locationId: pw.locationId,
				date: pw.date,
				startTime: pw.startTime,
				endTime: pw.endTime,
				slotIntervalMinutes: pw.slotIntervalMinutes,
				maxOrdersPerSlot: pw.maxOrdersPerSlot,
				orderLeadTimeMinutes: pw.orderLeadTimeMinutes,
			})),
			inventoryOverrides: drop.inventoryOverrides.map((inv) => ({
				id: inv.id,
				entityType: inv.entityType as any,
				entityId: inv.entityId,
				inventory: inv.inventory,
				maxPerOrder: inv.maxPerOrder,
				maxPerPickupSlot: inv.maxPerPickupSlot,
			})),
			reminders: drop.reminders.map((rem) => ({
				id: rem.id,
				title: rem.title,
				message: rem.message,
				triggerType: rem.triggerType as any,
				scheduledAt: rem.scheduledAt,
				status: rem.status as any,
			})),
			assignedCategoryIds,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const dropId = params.dropId
	if (!dropId) {
		throw new Response('Drop not found', { status: 404 })
	}

	await assertDropInOrganization(organization.id, dropId)

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

	const parsed = DropInputSchema.safeParse({ ...rawData, id: dropId })
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const assignedCategoryIds = Array.isArray(rawData.assignedCategoryIds)
		? (rawData.assignedCategoryIds as string[])
		: []

	await saveDrop(organization.id, {
		...parsed.data,
		id: dropId,
		assignedCategoryIds,
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/drops`)
}

export default function DropEditRoute() {
	const {
		orgSlug,
		locations,
		availableCategories,
		availableItems,
		initialData,
	} = useLoaderData<typeof loader>()

	return (
		<DropForm
			orgSlug={orgSlug}
			locations={locations}
			availableCategories={availableCategories}
			availableItems={availableItems}
			initialData={initialData as any}
			isEdit={true}
		/>
	)
}
