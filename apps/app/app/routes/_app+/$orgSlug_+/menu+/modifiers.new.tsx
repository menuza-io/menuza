import { requireUserId } from '@repo/auth'
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
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { ModifierForm } from '#app/components/menu/modifier-form.tsx'
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
	const name = String(formData.get('name') || '')
	const internalName = String(formData.get('internalName') || '') || null
	const selectionType = String(formData.get('selectionType') || 'single')
	const maxSelectionsStr = String(formData.get('maxSelections') || '')
	const submittedMinSelections =
		parseInt(String(formData.get('minSelections') || '0'), 10) || 0
	const minSelections =
		selectionType === 'single'
			? Math.min(Math.max(submittedMinSelections, 0), 1)
			: submittedMinSelections
	const maxSelections =
		selectionType === 'single'
			? 1
			: maxSelectionsStr
				? parseInt(maxSelectionsStr, 10)
				: null
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

	const optionsRaw = String(formData.get('options') || '[]')
	let options: any[] = []
	try {
		options = JSON.parse(optionsRaw) as any[]
	} catch {}

	const assignedItemIdsRaw = String(formData.get('assignedItemIds') || '[]')
	let assignedItemIds: string[] = []
	try {
		assignedItemIds = JSON.parse(assignedItemIdsRaw) as string[]
	} catch {}

	const locationOverridesRaw = String(formData.get('locationOverrides') || '{}')
	let locationOverrides: Record<string, any> = {}
	try {
		locationOverrides = JSON.parse(locationOverridesRaw) as Record<string, any>
	} catch {}

	// Create Group
	const [newGroup] = await db
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

		for (let i = 0; i < options.length; i++) {
			const opt = options[i]
			const optionPrice = opt.price || 0
			const priceWhole = isPizzaGroup ? optionPrice : (opt.priceWhole ?? null)
			const priceLeft = isPizzaGroup ? (opt.priceLeft ?? null) : null
			const priceRight = isPizzaGroup ? (opt.priceRight ?? null) : null
			let targetOptionId = opt.id
			if (targetOptionId) {
				const [existing] = await db
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
			if (!targetOptionId) {
				const [created] = await db
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
						position: i,
					})
					.returning()
				targetOptionId = created?.id
			} else {
				await db
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
				await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
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
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values(
			assignedItemIds.map((itemId, index) => ({
				itemId,
				modifierGroupId: newGroup.id,
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
				entityType: 'modifier_group',
				entityId: newGroup.id,
				isEnabled: entry.isEnabled,
				price: entry.price,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/modifiers`)
}

export default function CreateModifierGroupRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		availableOptions,
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
