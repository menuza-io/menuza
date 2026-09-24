import { requireUserId } from '@repo/auth'
import { MenuOptionInputSchema } from '@repo/common/menu-types'
import {
	db,
	eq,
	or,
	and,
	inArray,
	asc,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuModifierGroup,
	OrganizationLocation,
	OrganizationMenuLocationOverride,
	OrganizationMediaAsset,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { type LocationOverrideState } from '#app/components/menu/location-overrides-card.tsx'
import { OptionForm } from '#app/components/menu/option-form.tsx'
import {
	assertLocationIdsInOrganization,
	assertModifierGroupIdsInOrganization,
	assertOptionIdsInOrganization,
} from '#app/utils/menu/ownership.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})

	const { optionId } = params
	if (!optionId) {
		throw new Response('Not Found', { status: 404 })
	}

	const [option] = await db
		.select()
		.from(OrganizationMenuOption)
		.where(
			and(
				eq(OrganizationMenuOption.id, optionId),
				eq(OrganizationMenuOption.organizationId, organization.id),
			),
		)
		.limit(1)

	if (!option) {
		throw new Response('Not Found', { status: 404 })
	}

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const supportedLocales = organization.siteLocales
		? (JSON.parse(organization.siteLocales) as string[])
		: ['en']

	// Fetch media asset URL if imageKey exists
	let imageUrl: string | null = null
	if (option.imageKey) {
		const [media] = await db
			.select({
				id: OrganizationMediaAsset.id,
				updatedAt: OrganizationMediaAsset.updatedAt,
			})
			.from(OrganizationMediaAsset)
			.where(
				or(
					eq(OrganizationMediaAsset.id, option.imageKey),
					eq(OrganizationMediaAsset.objectKey, option.imageKey),
				),
			)
			.limit(1)
		imageUrl = media
			? `/resources/images?mediaId=${encodeURIComponent(media.id)}&v=${media.updatedAt.getTime()}`
			: null
	}

	// Fetch assigned modifier group IDs
	const assignments = await db
		.select({
			groupId: OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
		})
		.from(OrganizationMenuModifierGroupOptionAssignment)
		.where(
			eq(OrganizationMenuModifierGroupOptionAssignment.optionId, option.id),
		)

	const modifierGroupIds = assignments.map((a) => a.groupId)

	// Fetch location overrides
	const overrides = await db
		.select()
		.from(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.entityType, 'modifier_option'),
				eq(OrganizationMenuLocationOverride.entityId, option.id),
			),
		)

	const locationOverridesMap: Record<string, LocationOverrideState> = {}
	for (const ov of overrides) {
		locationOverridesMap[ov.locationId] = {
			locationId: ov.locationId,
			isEnabled: ov.isEnabled ?? true,
			price: ov.price,
			availabilityStatus: ov.availabilityStatus,
		}
	}

	// Fetch all active modifier groups for this organization
	const availableModifierGroups = await db
		.select({
			id: OrganizationMenuModifierGroup.id,
			name: OrganizationMenuModifierGroup.name,
			internalName: OrganizationMenuModifierGroup.internalName,
			selectionType: OrganizationMenuModifierGroup.selectionType,
		})
		.from(OrganizationMenuModifierGroup)
		.where(eq(OrganizationMenuModifierGroup.organizationId, organization.id))
		.orderBy(asc(OrganizationMenuModifierGroup.position))

	// Fetch locations
	const locations = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			slug: OrganizationLocation.slug,
			isDefault: OrganizationLocation.isDefault,
			isActive: OrganizationLocation.isActive,
			timezone: OrganizationLocation.timezone,
			storeHours: OrganizationLocation.storeHours,
			onlineHours: OrganizationLocation.onlineHours,
			specialHours: OrganizationLocation.specialHours,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(OrganizationLocation.isDefault, OrganizationLocation.name)

	let parsedAllergens: string[] = []
	try {
		if (option.allergens) {
			parsedAllergens = JSON.parse(option.allergens) as string[]
		}
	} catch {}

	return {
		orgSlug: organization.slug,
		defaultLocale,
		supportedLocales,
		availableModifierGroups,
		locations: locations.map((loc) => ({
			id: loc.id,
			name: loc.name,
			slug: loc.slug,
			isDefault: Boolean(loc.isDefault),
			isActive: Boolean(loc.isActive),
			timezone: loc.timezone ?? 'America/New_York',
			storeHours: loc.storeHours,
			onlineHours: loc.onlineHours,
			specialHours: loc.specialHours,
		})),
		initialData: {
			displayName: option.displayName,
			internalName: option.internalName ?? '',
			description: option.description ?? '',
			price: option.price,
			priceWhole: option.priceWhole,
			priceLeft: option.priceLeft,
			priceRight: option.priceRight,
			calories: option.calories,
			minSelections: option.minSelections,
			maxSelections: option.maxSelections,
			isAlcohol: Boolean(option.isAlcohol),
			isGlutenFree: Boolean(option.isGlutenFree),
			isVegetarian: Boolean(option.isVegetarian),
			isTopping: Boolean(option.isTopping),
			allergens: parsedAllergens,
			applySalesTax: Boolean(option.applySalesTax),
			availabilityStatus: option.availabilityStatus,
			unavailableUntil: option.unavailableUntil
				? option.unavailableUntil.toISOString()
				: null,
			imageKey: option.imageKey,
			imageUrl,
			modifierGroupIds,
			locationOverrides: locationOverridesMap,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})

	const { optionId } = params
	if (!optionId) {
		throw new Response('Not Found', { status: 404 })
	}

	await assertOptionIdsInOrganization(organization.id, [optionId])

	const formData = await request.formData()
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (
			key === 'allergens' ||
			key === 'modifierGroupIds' ||
			key === 'locationOverrides'
		) {
			try {
				rawData[key] = JSON.parse(value as string)
			} catch {
				rawData[key] = []
			}
		} else if (
			key === 'isAlcohol' ||
			key === 'isGlutenFree' ||
			key === 'isVegetarian' ||
			key === 'isTopping' ||
			key === 'applySalesTax'
		) {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const parsed = MenuOptionInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data

	await assertModifierGroupIdsInOrganization(
		organization.id,
		data.modifierGroupIds ?? [],
	)
	await assertLocationIdsInOrganization(
		organization.id,
		Object.keys(data.locationOverrides ?? {}),
	)

	// Automatically determine isTopping based on assigned modifier groups
	let isTopping = data.isTopping
	if (data.modifierGroupIds && data.modifierGroupIds.length > 0) {
		const pizzaGroups = await db
			.select({ id: OrganizationMenuModifierGroup.id })
			.from(OrganizationMenuModifierGroup)
			.where(
				and(
					inArray(OrganizationMenuModifierGroup.id, data.modifierGroupIds),
					eq(OrganizationMenuModifierGroup.selectionType, 'pizza'),
				),
			)
		isTopping = pizzaGroups.length > 0
	}

	await db.transaction(async (tx) => {
		// 1. Update OrganizationMenuOption
		await tx
			.update(OrganizationMenuOption)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				description: data.description || null,
				imageKey: data.imageKey || null,
				price: data.price,
				priceWhole: isTopping ? data.price : null,
				priceLeft: isTopping ? (data.priceLeft ?? null) : null,
				priceRight: isTopping ? (data.priceRight ?? null) : null,
				calories: data.calories ?? null,
				minSelections: data.minSelections,
				maxSelections: data.maxSelections ?? null,
				isAlcohol: data.isAlcohol,
				isGlutenFree: data.isGlutenFree,
				isVegetarian: data.isVegetarian,
				isTopping,
				allergens: JSON.stringify(data.allergens),
				applySalesTax: data.applySalesTax,
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenuOption.id, optionId),
					eq(OrganizationMenuOption.organizationId, organization.id),
				),
			)

		// 2. Re-sync modifier group assignments
		await tx
			.delete(OrganizationMenuModifierGroupOptionAssignment)
			.where(
				eq(OrganizationMenuModifierGroupOptionAssignment.optionId, optionId),
			)

		if (data.modifierGroupIds && data.modifierGroupIds.length > 0) {
			const assignmentRows = data.modifierGroupIds.map((groupId, idx) => ({
				modifierGroupId: groupId,
				optionId,
				position: idx,
			}))

			await tx
				.insert(OrganizationMenuModifierGroupOptionAssignment)
				.values(assignmentRows)
		}

		// 3. Re-sync location overrides
		await tx
			.delete(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.entityType, 'modifier_option'),
					eq(OrganizationMenuLocationOverride.entityId, optionId),
				),
			)

		if (data.locationOverrides) {
			const overrideRows = Object.entries(data.locationOverrides).map(
				([locId, override]) => ({
					organizationId: organization.id,
					locationId: locId,
					entityType: 'modifier_option',
					entityId: optionId,
					isEnabled: override.isEnabled ?? null,
					price: override.price ?? null,
					availabilityStatus: override.availabilityStatus ?? null,
				}),
			)

			if (overrideRows.length > 0) {
				await tx.insert(OrganizationMenuLocationOverride).values(overrideRows)
			}
		}
	})

	// Purge site KV cache
	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/options`)
}

export default function EditOptionRoute() {
	const {
		orgSlug,
		initialData,
		availableModifierGroups,
		locations,
		supportedLocales,
		defaultLocale,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const actionData = useActionData<{ error?: Record<string, string[]> }>()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<OptionForm
				orgSlug={orgSlug}
				initialData={initialData}
				availableModifierGroups={availableModifierGroups}
				locations={locations}
				supportedLocales={supportedLocales}
				defaultLocale={defaultLocale}
				isSubmitting={isSubmitting}
				pageTitle="Edit Option"
				actionError={actionData?.error}
			/>
		</div>
	)
}
