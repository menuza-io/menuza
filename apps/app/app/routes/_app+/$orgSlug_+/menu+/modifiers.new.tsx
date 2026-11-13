import { requireUserId } from '@repo/auth'
import { ModifierGroupInputSchema } from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuItem,
	OrganizationLocation,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { ModifierForm } from '#app/components/menu/modifier-form.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { modifierGraphErrorResponse } from '#app/utils/menu/modifier-graph.server.ts'
import { createModifierGroup } from '#app/utils/menu/modifier-groups.server.ts'
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

	await requireMenuRead(request, organization.id)

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = localesConfig.defaultLocale
	const supportedLocales = localesConfig.locales

	const allModifierGroups =
		await db.query.OrganizationMenuModifierGroup.findMany({
			where: eq(OrganizationMenuModifierGroup.organizationId, organization.id),
			orderBy: [asc(OrganizationMenuModifierGroup.name)],
		})

	const allItems = await db.query.OrganizationMenuItem.findMany({
		where: eq(OrganizationMenuItem.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuItem.position)],
	})

	const allLocations = await db.query.OrganizationLocation.findMany({
		where: eq(OrganizationLocation.organizationId, organization.id),
		orderBy: [
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		],
	})

	const availableOptions = await db
		.select({
			id: OrganizationMenuOption.id,
			displayName: OrganizationMenuOption.displayName,
			internalName: OrganizationMenuOption.internalName,
			price: OrganizationMenuOption.price,
			priceWhole: OrganizationMenuOption.priceWhole,
			priceLeft: OrganizationMenuOption.priceLeft,
			priceRight: OrganizationMenuOption.priceRight,
			isGlutenFree: OrganizationMenuOption.isGlutenFree,
			isVegetarian: OrganizationMenuOption.isVegetarian,
			isAlcohol: OrganizationMenuOption.isAlcohol,
			isTopping: OrganizationMenuOption.isTopping,
			imageKey: OrganizationMenuOption.imageKey,
		})
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, organization.id))
		.orderBy(asc(OrganizationMenuOption.position))

	const parentOptionsQuery = await db.query.OrganizationMenuOption.findMany({
		where: eq(OrganizationMenuOption.organizationId, organization.id),
		with: {
			modifierGroupAssignments: {
				with: {
					modifierGroup: true,
				},
			},
		},
		orderBy: [asc(OrganizationMenuOption.displayName)],
	})

	const availableParentOptions = parentOptionsQuery.map((opt) => ({
		id: opt.id,
		displayName: opt.displayName,
		internalName: opt.internalName,
		groupName: opt.modifierGroupAssignments[0]?.modifierGroup?.name ?? null,
		groupInternalName:
			opt.modifierGroupAssignments[0]?.modifierGroup?.internalName ?? null,
	}))

	return {
		organization,
		initialParentOptionIds: [] as string[],
		availableParentOptions,
		defaultLocale,
		supportedLocales,
		availableOptions,
		allItems: allItems.map((i) => ({
			id: i.id,
			displayName: i.displayName,
			internalName: i.internalName,
			price: i.price,
		})),
		availableModifierGroups: allModifierGroups.map((g) => ({
			id: g.id,
			name: g.name,
			internalName: g.internalName,
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

	await requireMenuWrite(request, organization.id)

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (key === 'options' || key === 'assignedItemIds') {
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
		} else {
			rawData[key] = value
		}
	}

	const parsed = ModifierGroupInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data

	const result = await createModifierGroup(organization.id, data)
	if (!result.ok) return modifierGraphErrorResponse(result.failure)

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/modifiers`)
}

export default function CreateModifierGroupRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		availableOptions,
		availableModifierGroups,
		initialParentOptionIds,
		availableParentOptions,
		allItems,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ModifierForm
				pageTitle="Create Modifier Group"
				availableModifierGroups={availableModifierGroups}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				availableOptions={availableOptions}
				allItems={allItems}
				allLocations={allLocations}
				isSubmitting={isSubmitting}
			/>
		</div>
	)
}
