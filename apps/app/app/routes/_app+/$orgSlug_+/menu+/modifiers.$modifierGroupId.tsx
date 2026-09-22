import { requireUserId } from '@repo/auth'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	asc,
	desc,
	and,
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

	const modifierGroupId = params.modifierGroupId
	if (!modifierGroupId) {
		throw new Response('Modifier Group not found', { status: 404 })
	}

	const group = await db.query.OrganizationMenuModifierGroup.findFirst({
		where: and(
			eq(OrganizationMenuModifierGroup.id, modifierGroupId),
			eq(OrganizationMenuModifierGroup.organizationId, organization.id),
		),
		with: {
			itemAssignments: {
				orderBy: [asc(OrganizationMenuItemModifierGroupAssignment.position)],
			},
		},
	})

	if (!group) {
		throw new Response('Modifier Group not found', { status: 404 })
	}

	const groupOptions = await db
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
			isDefault: OrganizationMenuModifierGroupOptionAssignment.isDefault,
		})
		.from(OrganizationMenuModifierGroupOptionAssignment)
		.innerJoin(
			OrganizationMenuOption,
			eq(
				OrganizationMenuModifierGroupOptionAssignment.optionId,
				OrganizationMenuOption.id,
			),
		)
		.where(
			eq(
				OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				group.id,
			),
		)
		.orderBy(asc(OrganizationMenuModifierGroupOptionAssignment.position))

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

	// Load existing overrides
	const existingOverrides =
		await db.query.OrganizationMenuLocationOverride.findMany({
			where: and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'modifier_group'),
				eq(OrganizationMenuLocationOverride.entityId, group.id),
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
		group: {
			id: group.id,
			name: group.name,
			internalName: group.internalName ?? '',
			selectionType: group.selectionType as
				'single' | 'multiple' | 'quantity' | 'pizza',
			minSelections: group.minSelections,
			maxSelections: group.maxSelections,
			availabilityStatus: group.availabilityStatus as
				'available' | 'unavailable_until_tomorrow' | 'unavailable',
			options: groupOptions.map((opt) => ({
				id: opt.id,
				displayName: opt.displayName,
				internalName: opt.internalName ?? '',
				price: opt.price,
				priceWhole: opt.priceWhole,
				priceLeft: opt.priceLeft,
				priceRight: opt.priceRight,
				isGlutenFree: opt.isGlutenFree,
				isVegetarian: opt.isVegetarian,
				isAlcohol: opt.isAlcohol,
				isTopping: opt.isTopping,
				isDefault: opt.isDefault,
			})),
			assignedItemIds: group.itemAssignments.map((ia) => ia.itemId),
			locationOverrides,
		},
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

	const modifierGroupId = params.modifierGroupId
	if (!modifierGroupId) {
		throw new Response('Modifier Group not found', { status: 404 })
	}

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

	// Update Group
	await db
		.update(OrganizationMenuModifierGroup)
		.set({
			name,
			internalName,
			selectionType,
			minSelections,
			maxSelections,
			availabilityStatus,
			unavailableUntil,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(OrganizationMenuModifierGroup.id, modifierGroupId),
				eq(OrganizationMenuModifierGroup.organizationId, organization.id),
			),
		)

	// Re-sync reusable options and their assignments. Do not write the retired
	// group-local option table: the Options page and this editor share these rows.
	await db
		.delete(OrganizationMenuModifierGroupOptionAssignment)
		.where(
			eq(
				OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
				modifierGroupId,
			),
		)

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
					modifierGroupId,
					optionId: targetOptionId,
					isDefault: opt.isDefault ?? false,
					position: i,
				})
			}
		}
	}

	// Replace Item Assignments
	await db
		.delete(OrganizationMenuItemModifierGroupAssignment)
		.where(
			eq(
				OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
				modifierGroupId,
			),
		)

	if (assignedItemIds.length > 0) {
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values(
			assignedItemIds.map((itemId, index) => ({
				itemId,
				modifierGroupId,
				position: index,
			})),
		)
	}

	// Replace Location Overrides
	await db
		.delete(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
				eq(OrganizationMenuLocationOverride.entityType, 'modifier_group'),
				eq(OrganizationMenuLocationOverride.entityId, modifierGroupId),
			),
		)

	const overrideEntries = Object.values(locationOverrides)
	if (overrideEntries.length > 0) {
		await db.insert(OrganizationMenuLocationOverride).values(
			overrideEntries.map((entry: any) => ({
				organizationId: organization.id,
				locationId: entry.locationId,
				entityType: 'modifier_group',
				entityId: modifierGroupId,
				isEnabled: entry.isEnabled,
				price: entry.price,
				availabilityStatus: entry.availabilityStatus,
			})),
		)
	}

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/modifiers`)
}

export default function EditModifierGroupRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		availableOptions,
		group,
		allItems,
		allLocations,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<ModifierForm
				pageTitle="Edit Modifier Group"
				initialData={group}
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
