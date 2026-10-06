import { requireUserId } from '@repo/auth'
import { getLocationCurrency } from '@repo/common/location-currency'
import {
	DropInputSchema,
	getDropPublicationErrors,
	hasDropDefaultTitle,
} from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	and,
	eq,
	asc,
	desc,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItemCategoryAssignment,
	OrganizationDrop,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
} from 'react-router'
import { DropForm } from '#app/components/menu/drop-wizard/drop-form.tsx'
import { getDropWithDetails, saveDrop } from '#app/utils/menu/drops.server.ts'
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

	const dropId = params.dropId
	if (!dropId) {
		throw new Response('Drop not found', { status: 404 })
	}

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

	const menus = await db.query.OrganizationMenu.findMany({
		where: eq(OrganizationMenu.organizationId, organization.id),
		orderBy: [asc(OrganizationMenu.position), asc(OrganizationMenu.createdAt)],
		with: {
			categoryAssignments: {
				orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
				with: {
					category: {
						with: {
							itemAssignments: {
								orderBy: [asc(OrganizationMenuItemCategoryAssignment.position)],
								with: {
									item: true,
								},
							},
						},
					},
				},
			},
		},
	})

	const formattedMenus = menus
		.filter((menu) => menu.menuType !== 'drop' || menu.id === drop.menuId)
		.map((menu) => ({
			id: menu.id,
			displayName: menu.displayName,
			internalName: menu.internalName,
			availabilityStatus: menu.availabilityStatus,
			categories: menu.categoryAssignments.map((ca) => ({
				id: ca.category.id,
				displayName: ca.category.displayName,
				internalName: ca.category.internalName,
				items: ca.category.itemAssignments.map((ia) => ({
					id: ia.item.id,
					displayName: ia.item.displayName,
					price: ia.item.price,
					imageKey: ia.item.imageKey,
					imageUrl: ia.item.imageUrl,
				})),
			})),
		}))

	const initialData = {
		id: drop.id,
		title: drop.title,
		slug: drop.slug,
		description: drop.description,
		status: drop.status as any,
		menuId: drop.menuId,
		ordersOpenAt: drop.ordersOpenAt ? new Date(drop.ordersOpenAt) : null,
		ordersCloseAt: drop.ordersCloseAt ? new Date(drop.ordersCloseAt) : null,
		visibility: drop.visibility as 'public' | 'unlisted',
		checkoutHoldMinutes: drop.checkoutHoldMinutes,
		showOrdersOpenTime: drop.showOrdersOpenTime,
		showMenuPreview: drop.showMenuPreview,
		showInventoryRemaining: drop.showInventoryRemaining,
		includeGiftCard: drop.includeGiftCard,
		coverImageKey: drop.coverImageKey,
		coverImageUrl: drop.coverImageUrl,
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
		reminders: drop.reminders.map((r) => ({
			id: r.id,
			title: r.title,
			message: r.message,
			triggerType: r.triggerType as any,
			scheduledAt: new Date(r.scheduledAt),
			status: r.status as any,
		})),
	}

	return {
		orgSlug: organization.slug,
		locations: locations.map((l) => ({
			id: l.id,
			name: l.name,
			timezone: l.timezone ?? undefined,
		})),
		availableMenus: formattedMenus,
		initialData,
		currency: getLocationCurrency(locations[0]?.address),
		defaultLocale: localesConfig.defaultLocale,
		supportedLocales: localesConfig.locales,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})
	const dropId = params.dropId
	if (!dropId) {
		throw new Response('Drop not found', { status: 404 })
	}

	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent !== 'draft' && intent !== 'publish') {
		return Response.json(
			{ errors: { intent: ['Choose Unpublish or Publish.'] } },
			{ status: 400 },
		)
	}
	const rawData: Record<string, unknown> = {
		id: dropId,
	}

	for (const [key, value] of formData.entries()) {
		if (
			key === 'pickupWindows' ||
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
		} else if (value === '' || value === 'null') {
			rawData[key] = null
		} else {
			rawData[key] = value
		}
	}
	rawData.status = intent === 'draft' ? 'draft' : 'scheduled'

	const parsed = DropInputSchema.safeParse(rawData)

	if (!parsed.success) {
		return Response.json(
			{ errors: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}
	if (
		!hasDropDefaultTitle(
			parsed.data.title,
			organization.siteDefaultLocale ?? 'en',
		)
	) {
		return Response.json(
			{ errors: { title: ['Add a drop name in the default site language.'] } },
			{ status: 400 },
		)
	}

	if (intent === 'publish') {
		const existing = await db.query.OrganizationDrop.findFirst({
			where: and(
				eq(OrganizationDrop.id, dropId),
				eq(OrganizationDrop.organizationId, organization.id),
			),
			columns: { status: true },
		})
		if (!existing) {
			throw new Response('Drop not found', { status: 404 })
		}
		const isPublished =
			existing.status === 'scheduled' || existing.status === 'live'
		const errors = getDropPublicationErrors(parsed.data, new Date(), {
			requireFutureClose: !isPublished,
		})
		if (Object.keys(errors).length > 0) {
			return Response.json({ errors }, { status: 400 })
		}
	}

	await saveDrop(organization.id, {
		...parsed.data,
		id: dropId,
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/drops/${dropId}`)
}

export default function EditDropRoute() {
	const data = useLoaderData<typeof loader>()
	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<DropForm
				pageTitle="Edit Drop"
				orgSlug={data.orgSlug}
				locations={data.locations}
				availableMenus={data.availableMenus}
				initialData={data.initialData}
				isEdit
				currency={data.currency}
				defaultLocale={data.defaultLocale}
				supportedLocales={data.supportedLocales}
			/>
		</div>
	)
}
