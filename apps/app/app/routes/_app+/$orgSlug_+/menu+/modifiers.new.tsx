import { requireUserId } from '@repo/auth'
import { ModifierGroupInputSchema } from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	and,
	asc,
	desc,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationLocation,
	OrganizationMenuLocationOverride,
	OrganizationMenuOptionNestedModifierGroupAssignment,
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
	assertItemIdsInOrganization,
	assertLocationIdsInOrganization,
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

	return {
		organization,
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

	const { options, assignedItemIds, selectionType, availabilityStatus, name } =
		data
	const internalName = data.internalName || null
	const minSelections =
		selectionType === 'single'
			? Math.min(Math.max(data.minSelections, 0), 1)
			: data.minSelections
	const maxSelections =
		selectionType === 'single' ? 1 : (data.maxSelections ?? null)
	const unavailableUntil =
		(availabilityStatus === 'unavailable_until' ||
			availabilityStatus === 'unavailable_until_tomorrow') &&
		data.unavailableUntil
			? data.unavailableUntil
			: null
	const overrideEntries = Object.values(data.locationOverrides ?? {})

	await assertItemIdsInOrganization(organization.id, assignedItemIds)
	await assertLocationIdsInOrganization(
		organization.id,
		overrideEntries
			.map((entry) => entry.locationId)
			.filter((id): id is string => typeof id === 'string'),
	)

	await db.transaction(async (tx) => {
		// Create Group
		const [newGroup] = await tx
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: organization.id,
				name,
				internalName,
				selectionType,
				minSelections,
				maxSelections,
				availabilityStatus,
				unavailableUntil,
			})
			.returning()

		if (!newGroup) {
			throw new Error('Failed to create modifier group')
		}

		// Create or link reusable menu options, then assign them to this group.
		// OrganizationMenuOption is the single source of truth used by both the
		// Options page and modifier groups.
		if (options.length > 0) {
			const isPizzaGroup = selectionType === 'pizza'

			for (const [i, opt] of options.entries()) {
				const optionPrice = opt.price || 0
				const priceWhole = isPizzaGroup ? optionPrice : (opt.priceWhole ?? null)
				const priceLeft = isPizzaGroup ? (opt.priceLeft ?? null) : null
				const priceRight = isPizzaGroup ? (opt.priceRight ?? null) : null
				let targetOptionId = opt.id
				if (targetOptionId) {
					const [existing] = await tx
						.select({ id: OrganizationMenuOption.id })
						.from(OrganizationMenuOption)
						.where(
							and(
								eq(OrganizationMenuOption.id, targetOptionId),
								eq(OrganizationMenuOption.organizationId, organization.id),
							),
						)
						.limit(1)
					if (!existing) targetOptionId = undefined
				}
				const nestedIds = opt.nestedModifierGroupIds ?? []
				if (!targetOptionId) {
					const [created] = await tx
						.insert(OrganizationMenuOption)
						.values({
							organizationId: organization.id,
							displayName: opt.displayName,
							internalName: opt.internalName || null,
							price: optionPrice,
							priceWhole,
							priceLeft,
							priceRight,
							isGlutenFree: opt.isGlutenFree ?? false,
							isVegetarian: opt.isVegetarian ?? false,
							isAlcohol: opt.isAlcohol ?? false,
							isTopping: isPizzaGroup || (opt.isTopping ?? false),
							nestedModifierGroupIds: JSON.stringify(nestedIds),
							position: i,
						})
						.returning()
					targetOptionId = created?.id
				} else {
					await tx
						.update(OrganizationMenuOption)
						.set({
							displayName: opt.displayName,
							internalName: opt.internalName || null,
							price: optionPrice,
							priceWhole,
							priceLeft,
							priceRight,
							isGlutenFree: opt.isGlutenFree ?? false,
							isVegetarian: opt.isVegetarian ?? false,
							isAlcohol: opt.isAlcohol ?? false,
							isTopping: isPizzaGroup || (opt.isTopping ?? false),
							nestedModifierGroupIds: JSON.stringify(nestedIds),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(OrganizationMenuOption.id, targetOptionId),
								eq(OrganizationMenuOption.organizationId, organization.id),
							),
						)
				}
				if (targetOptionId) {
					await tx
						.insert(OrganizationMenuModifierGroupOptionAssignment)
						.values({
							modifierGroupId: newGroup.id,
							optionId: targetOptionId,
							isDefault: opt.isDefault ?? false,
							position: i,
						})
				}
			}
		}

		// Insert Item Assignments
		if (assignedItemIds.length > 0) {
			await tx.insert(OrganizationMenuItemModifierGroupAssignment).values(
				assignedItemIds.map((itemId, index) => ({
					itemId,
					modifierGroupId: newGroup.id,
					position: index,
				})),
			)
		}

		// Insert Location Overrides
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'modifier_group',
					entityId: newGroup.id,
					isEnabled: entry.isEnabled,
					price: entry.price,
					availabilityStatus: entry.availabilityStatus,
				})),
			)
		}
	})

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
		allItems,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ModifierForm
				pageTitle="Create Modifier Group"
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
