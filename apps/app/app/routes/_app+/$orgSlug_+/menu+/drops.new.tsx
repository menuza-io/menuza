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
	eq,
	asc,
	desc,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategoryAssignment,
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
		siteDefaultLocale: true,
		siteLocales: true,
	})
	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)

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
		.filter((menu) => menu.menuType !== 'drop')
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

	return {
		orgSlug: organization.slug,
		locations: locations.map((l) => ({
			id: l.id,
			name: l.name,
			timezone: l.timezone ?? undefined,
		})),
		availableMenus: formattedMenus,
		currency: getLocationCurrency(locations[0]?.address),
		defaultLocale: localesConfig.defaultLocale,
		supportedLocales: localesConfig.locales,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent !== 'draft' && intent !== 'publish') {
		return Response.json(
			{ errors: { intent: ['Choose Save as draft or Publish.'] } },
			{ status: 400 },
		)
	}
	const rawData: Record<string, unknown> = {}

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
		const errors = getDropPublicationErrors(parsed.data)
		if (Object.keys(errors).length > 0) {
			return Response.json({ errors }, { status: 400 })
		}
	}

	const dropId = await saveDrop(organization.id, parsed.data)

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/drops/${dropId}`)
}

export default function NewDropRoute() {
	const data = useLoaderData<typeof loader>()

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<DropForm
				pageTitle="Create Drop"
				orgSlug={data.orgSlug}
				locations={data.locations}
				availableMenus={data.availableMenus}
				currency={data.currency}
				defaultLocale={data.defaultLocale}
				supportedLocales={data.supportedLocales}
			/>
		</div>
	)
}
