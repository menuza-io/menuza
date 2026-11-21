import { requireUserId } from '@repo/auth'
import { parseMenuChannels } from '@repo/common/menu-channels'
import { getLocalizedMenuValue, MenuInputSchema } from '@repo/common/menu-types'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	db,
	eq,
	ne,
	asc,
	desc,
	and,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationLocation,
} from '@repo/database'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { MenuForm } from '#app/components/menu/menu-form.tsx'
import { MenuScheduleCard } from '#app/components/menu/menu-schedule-card.tsx'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import {
	handleMenuScheduleAction,
	loadMenuScheduleCardData,
} from '#app/utils/menu/menu-schedules.server.ts'
import {
	narrowOverrideChannels,
	parseChannelsFormData,
} from '#app/utils/menu/menu-write-columns.ts'
import {
	assertCategoryIdsInOrganization,
	assertLocationIdsInOrganization,
	assertMenuInOrganization,
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

	await requireMenuRead(request, organization.id)

	const menuId = params.menuId
	if (!menuId) {
		throw new Response('Menu not found', { status: 404 })
	}

	const menu = await db.query.OrganizationMenu.findFirst({
		where: and(
			eq(OrganizationMenu.id, menuId),
			eq(OrganizationMenu.organizationId, organization.id),
		),
		with: {
			categoryAssignments: {
				orderBy: [asc(OrganizationMenuCategoryAssignment.position)],
			},
		},
	})

	if (!menu) {
		throw new Response('Menu not found', { status: 404 })
	}

	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const defaultLocale = localesConfig.defaultLocale
	const supportedLocales = localesConfig.locales

	const allCategories = await db.query.OrganizationMenuCategory.findMany({
		where: eq(OrganizationMenuCategory.organizationId, organization.id),
		orderBy: [asc(OrganizationMenuCategory.position)],
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
				eq(OrganizationMenuLocationOverride.entityType, 'menu'),
				eq(OrganizationMenuLocationOverride.entityId, menu.id),
			),
		})

	const locationOverrides: Record<string, any> = {}
	for (const ov of existingOverrides) {
		locationOverrides[ov.locationId] = {
			locationId: ov.locationId,
			isEnabled: ov.isEnabled ?? true,
			availabilityStatus: ov.availabilityStatus,
			channels: ov.channels ? parseMenuChannels(ov.channels) : null,
		}
	}

	const [{ pendingSchedule, timezone: scheduleTimezone }, otherMenuRows] =
		await Promise.all([
			loadMenuScheduleCardData(organization.id, menu.id),
			db
				.select({
					id: OrganizationMenu.id,
					displayName: OrganizationMenu.displayName,
					internalName: OrganizationMenu.internalName,
				})
				.from(OrganizationMenu)
				.where(
					and(
						eq(OrganizationMenu.organizationId, organization.id),
						ne(OrganizationMenu.id, menu.id),
						ne(OrganizationMenu.menuType, 'drop'),
					),
				)
				.orderBy(asc(OrganizationMenu.position)),
		])

	const otherMenus = otherMenuRows.map((m) => ({
		id: m.id,
		name:
			getLocalizedMenuValue(m.displayName, defaultLocale, defaultLocale) ||
			m.internalName ||
			'Untitled',
	}))

	return {
		organization,
		defaultLocale,
		supportedLocales,
		pendingSchedule,
		scheduleTimezone,
		otherMenus,
		menu: {
			id: menu.id,
			displayName: menu.displayName,
			internalName: menu.internalName ?? '',
			menuType: menu.menuType as 'online_pos_kiosk' | 'catering',
			nutritionalInfo: menu.nutritionalInfo,
			specialInstructions: menu.specialInstructions,
			availabilityStatus: menu.availabilityStatus as
				'available' | 'unavailable_until_tomorrow' | 'unavailable',
			availabilityHours: menu.availabilityHours ?? '',
			channels: parseMenuChannels(menu.channels),
			assignedCategoryIds: menu.categoryAssignments.map((ca) => ca.categoryId),
			locationOverrides,
		},
		allCategories: allCategories.map((c) => ({
			id: c.id,
			displayName: c.displayName,
			internalName: c.internalName,
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

	const menuId = params.menuId
	if (!menuId) {
		throw new Response('Menu not found', { status: 404 })
	}

	await assertMenuInOrganization(organization.id, menuId)

	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent === 'schedule-menu' || intent === 'cancel-menu-schedule') {
		return handleMenuScheduleAction({
			request,
			organizationId: organization.id,
			menuId,
			formData,
		})
	}
	const rawData: Record<string, unknown> = {}

	for (const [key, value] of formData.entries()) {
		if (key === 'assignedCategoryIds') {
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
		} else if (key === 'nutritionalInfo' || key === 'specialInstructions') {
			rawData[key] = value === 'true'
		} else {
			rawData[key] = value
		}
	}

	const channelsParsed = parseChannelsFormData(formData)
	if (!channelsParsed.ok) {
		return Response.json(
			{ error: { channels: ['Invalid channels'] } },
			{ status: 400 },
		)
	}

	const parsed = MenuInputSchema.safeParse(rawData)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.flatten().fieldErrors },
			{ status: 400 },
		)
	}

	const data = parsed.data
	const rawOverrides =
		rawData.locationOverrides &&
		typeof rawData.locationOverrides === 'object' &&
		!Array.isArray(rawData.locationOverrides)
			? (rawData.locationOverrides as Record<string, { channels?: unknown }>)
			: undefined

	await db.transaction(async (tx) => {
		await assertCategoryIdsInOrganization(
			organization.id,
			data.assignedCategoryIds,
			tx,
		)
		await assertLocationIdsInOrganization(
			organization.id,
			Object.values(data.locationOverrides ?? {})
				.map((entry) => entry.locationId)
				.filter((id): id is string => typeof id === 'string'),
			tx,
		)

		let effectiveBaseChannels = channelsParsed.channels
		if (!channelsParsed.provided) {
			const [currentMenu] = await tx
				.select({ channels: OrganizationMenu.channels })
				.from(OrganizationMenu)
				.where(
					and(
						eq(OrganizationMenu.id, menuId),
						eq(OrganizationMenu.organizationId, organization.id),
					),
				)
			effectiveBaseChannels = parseMenuChannels(currentMenu?.channels)
		}

		// Update Menu
		await tx
			.update(OrganizationMenu)
			.set({
				displayName: data.displayName,
				internalName: data.internalName || null,
				menuType: data.menuType,
				nutritionalInfo: data.nutritionalInfo,
				specialInstructions: data.specialInstructions,
				availabilityStatus: data.availabilityStatus,
				unavailableUntil:
					(data.availabilityStatus === 'unavailable_until' ||
						data.availabilityStatus === 'unavailable_until_tomorrow') &&
					data.unavailableUntil
						? data.unavailableUntil
						: null,
				availabilityHours: data.availabilityHours || null,
				...(channelsParsed.provided
					? { channels: channelsParsed.serialized }
					: {}),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenu.id, menuId),
					eq(OrganizationMenu.organizationId, organization.id),
				),
			)

		// Replace category assignments
		await tx
			.delete(OrganizationMenuCategoryAssignment)
			.where(eq(OrganizationMenuCategoryAssignment.menuId, menuId))

		if (data.assignedCategoryIds.length > 0) {
			await tx.insert(OrganizationMenuCategoryAssignment).values(
				data.assignedCategoryIds.map((categoryId, index) => ({
					menuId,
					categoryId,
					position: index,
				})),
			)
		}

		// Replace location overrides
		await tx
			.delete(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.organizationId, organization.id),
					eq(OrganizationMenuLocationOverride.entityType, 'menu'),
					eq(OrganizationMenuLocationOverride.entityId, menuId),
				),
			)

		const overrideEntries = Object.values(data.locationOverrides ?? {})
		if (overrideEntries.length > 0) {
			await tx.insert(OrganizationMenuLocationOverride).values(
				overrideEntries.map((entry) => ({
					organizationId: organization.id,
					locationId: entry.locationId,
					entityType: 'menu',
					entityId: menuId,
					isEnabled: entry.isEnabled,
					availabilityStatus: entry.availabilityStatus,
					channels: narrowOverrideChannels(
						effectiveBaseChannels,
						rawOverrides?.[entry.locationId]?.channels,
					),
				})),
			)
		}
	})

	await purgeOrganizationSiteCache(organization.id, organization.slug)

	return redirect(`/${organization.slug}/menu/menus`)
}

export default function EditMenuRoute() {
	const {
		organization,
		defaultLocale,
		supportedLocales,
		menu,
		allCategories,
		allLocations,
		pendingSchedule,
		scheduleTimezone,
		otherMenus,
	} = useLoaderData<typeof loader>()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	return (
		<div className="-mx-4 -mt-2 flex flex-1 flex-col md:-mx-2">
			<MenuForm
				pageTitle="Edit Menu"
				initialData={menu}
				orgSlug={organization.slug}
				defaultLocale={defaultLocale}
				supportedLocales={supportedLocales}
				allCategories={allCategories}
				allLocations={allLocations}
				isSubmitting={isSubmitting}
			/>
			<div className="mx-auto w-full max-w-6xl px-4 pb-8 md:px-6 lg:px-8">
				<MenuScheduleCard
					menuId={menu.id}
					pendingSchedule={pendingSchedule}
					otherMenus={otherMenus}
					timezone={scheduleTimezone}
				/>
			</div>
		</div>
	)
}
