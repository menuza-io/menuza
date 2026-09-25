import { requireUserId } from '@repo/auth'
import { MenuOptionInputSchema } from '@repo/common/menu-types'
import {
	db,
	eq,
	and,
	inArray,
	asc,
	OrganizationMenuOption,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuModifierGroup,
	OrganizationLocation,
	OrganizationMenuLocationOverride,
	OrganizationMenuOptionNestedModifierGroupAssignment,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { OptionForm } from '#app/components/menu/option-form.tsx'
import {
	assertLocationIdsInOrganization,
	assertModifierGroupIdsInOrganization,
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

	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const supportedLocales = organization.siteLocales
		? (JSON.parse(organization.siteLocales) as string[])
		: ['en']

	// Fetch active modifier groups
	const modifierGroups = await db
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

	return {
		orgSlug: organization.slug,
		modifierGroups,
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
		supportedLocales,
		defaultLocale,
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
			key === 'allergens' ||
			key === 'modifierGroupIds' ||
			key === 'nestedModifierGroupIds' ||
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
	await assertModifierGroupIdsInOrganization(
		organization.id,
		data.nestedModifierGroupIds ?? [],
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

	let createdOptionId: string | undefined

	await db.transaction(async (tx) => {
		// 1. Insert into OrganizationMenuOption
		const [createdOption] = await tx
			.insert(OrganizationMenuOption)
			.values({
				organizationId: organization.id,
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
				nestedModifierGroupIds: JSON.stringify(
					data.nestedModifierGroupIds ?? [],
				),
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				position: data.position,
			})
			.returning()

		if (!createdOption) {
			return
		}

		createdOptionId = createdOption.id

		// 2. Insert modifier group assignments
		if (data.modifierGroupIds && data.modifierGroupIds.length > 0) {
			const assignmentRows = data.modifierGroupIds.map((groupId, idx) => ({
				modifierGroupId: groupId,
				optionId: createdOption.id,
				position: idx,
			}))

			await tx
				.insert(OrganizationMenuModifierGroupOptionAssignment)
				.values(assignmentRows)
		}

		// 3. Insert nested modifier group assignments
		if (data.nestedModifierGroupIds && data.nestedModifierGroupIds.length > 0) {
			await tx
				.insert(OrganizationMenuOptionNestedModifierGroupAssignment)
				.values(
					data.nestedModifierGroupIds.map((groupId, idx) => ({
						optionId: createdOption.id,
						modifierGroupId: groupId,
						position: idx,
					})),
				)
		}

		// 3. Insert location overrides
		if (data.locationOverrides) {
			const overrideRows = Object.entries(data.locationOverrides).map(
				([locId, override]) => ({
					organizationId: organization.id,
					locationId: locId,
					entityType: 'modifier_option',
					entityId: createdOption.id,
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

	if (!createdOptionId) {
		return Response.json(
			{ error: 'Failed to create menu option' },
			{ status: 500 },
		)
	}

	// Purge site KV cache
	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/options`)
}

export default function NewOptionRoute() {
	const {
		orgSlug,
		modifierGroups,
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
				availableModifierGroups={modifierGroups}
				locations={locations}
				supportedLocales={supportedLocales}
				defaultLocale={defaultLocale}
				isSubmitting={isSubmitting}
				pageTitle="Create Option"
				actionError={actionData?.error}
			/>
		</div>
	)
}
