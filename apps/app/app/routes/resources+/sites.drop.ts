import { getUserId } from '@repo/auth'
import { type LocationAddress } from '@repo/common/location-types'
import {
	generatePickupSlots,
	parseMenuItemImageKeys,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
	OrganizationMediaAsset,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationDrop,
	OrganizationDropPickupWindow,
} from '@repo/database'
import { getClientIp } from '@repo/security'
import { type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	PUBLIC_SITE_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	getCachedSiteData,
	getSiteKvKey,
	setCachedSiteData,
} from '#app/utils/sites/kv-cache.server.ts'

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback
	try {
		return JSON.parse(raw) as T
	} catch {
		return fallback
	}
}
export async function loader({ request }: LoaderFunctionArgs) {
	const ip = getClientIp(request)
	const rateLimitCheck = await checkRateLimit(
		{ type: 'ip', value: ip },
		PUBLIC_SITE_RATE_LIMIT,
	)
	if (!rateLimitCheck.allowed) {
		return createRateLimitResponse(rateLimitCheck.resetAt)
	}

	const url = new URL(request.url)
	const orgSlug = url.searchParams.get('slug')?.trim().toLowerCase() || null
	const customHost =
		url.searchParams.get('host')?.trim().toLowerCase().split(':')[0] || null
	const dropSlug = url.searchParams.get('drop')?.trim().toLowerCase() || null

	if (!dropSlug || (!orgSlug && !customHost)) {
		return Response.json(
			{ error: 'Missing required parameters' },
			{ status: 400 },
		)
	}

	// Preview protection: only authenticated admin or authorized preview requests can view draft drops or bypass KV cache
	const wantsPreview = url.searchParams.get('preview') === 'true'
	const authUser = wantsPreview
		? await getUserId(request).catch(() => null)
		: null
	const isPreview = Boolean(authUser)

	// 1. Resolve organization
	const org = await db.query.Organization.findFirst({
		where: and(
			orgSlug
				? eq(Organization.slug, orgSlug)
				: and(
						eq(Organization.customDomain, customHost!),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
			eq(Organization.active, true),
			eq(Organization.sitePublished, true),
		),
		columns: {
			id: true,
			name: true,
			slug: true,
			dataRegion: true,
		},
	})

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const cacheKey = getSiteKvKey('page', org.id, `drop-${dropSlug}`)

	if (!isPreview) {
		const cached = await getCachedSiteData(cacheKey)
		if (cached) {
			return Response.json(cached, {
				headers: {
					'Cache-Control': 'public, max-age=15, stale-while-revalidate=60',
				},
			})
		}
	}

	// 2. Resolve Drop
	const drop = await db.query.OrganizationDrop.findFirst({
		where: and(
			eq(OrganizationDrop.organizationId, org.id),
			eq(OrganizationDrop.slug, dropSlug),
		),
		with: {
			pickupWindows: {
				with: {
					location: true,
				},
				orderBy: [
					asc(OrganizationDropPickupWindow.date),
					asc(OrganizationDropPickupWindow.startTime),
				],
			},
			inventoryOverrides: true,
		},
	})

	if (!drop) {
		return Response.json({ error: 'Drop not found' }, { status: 404 })
	}

	if (drop.status === 'draft' && !isPreview) {
		return Response.json({ error: 'Drop not published' }, { status: 404 })
	}

	// 3. Resolve Media Asset URLs
	const mediaAssets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			updatedAt: OrganizationMediaAsset.updatedAt,
		})
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.organizationId, org.id))

	const mediaMap = new Map<string, string>()
	for (const m of mediaAssets) {
		const mediaUrl = `/resources/images?mediaId=${encodeURIComponent(m.id)}&v=${m.updatedAt.getTime()}`
		mediaMap.set(m.id, mediaUrl)
		mediaMap.set(m.objectKey, mediaUrl)
	}

	// 4. Fetch Drop Menu Categories & Items
	const categoryAssignments = await db
		.select()
		.from(OrganizationMenuCategoryAssignment)
		.where(eq(OrganizationMenuCategoryAssignment.menuId, drop.menuId))
		.orderBy(asc(OrganizationMenuCategoryAssignment.position))

	const categoryIds = categoryAssignments.map((ca) => ca.categoryId)

	const categories = categoryIds.length
		? await db.query.OrganizationMenuCategory.findMany({
				where: and(
					eq(OrganizationMenuCategory.organizationId, org.id),
					inArray(OrganizationMenuCategory.id, categoryIds),
				),
				orderBy: [asc(OrganizationMenuCategory.position)],
			})
		: []

	const dropCategories = categories.filter((c) => categoryIds.includes(c.id))

	// Fetch items in these categories (scoped strictly to drop category IDs!)
	const relevantItemAssignments = categoryIds.length
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

	const itemIds = relevantItemAssignments.map((ia) => ia.itemId)

	const items = itemIds.length
		? await db.query.OrganizationMenuItem.findMany({
				where: and(
					eq(OrganizationMenuItem.organizationId, org.id),
					inArray(OrganizationMenuItem.id, itemIds),
				),
				orderBy: [asc(OrganizationMenuItem.position)],
				with: {
					modifierGroupAssignments: {
						orderBy: [
							asc(OrganizationMenuItemModifierGroupAssignment.position),
						],
						with: {
							modifierGroup: {
								with: {
									optionAssignments: {
										orderBy: [
											asc(
												OrganizationMenuModifierGroupOptionAssignment.position,
											),
										],
										with: {
											option: true,
										},
									},
								},
							},
						},
					},
				},
			})
		: []

	const itemsMap = new Map(items.map((i) => [i.id, i]))

	// Map categories with items
	const formattedCategories = dropCategories.map((cat) => {
		const assignedItems = relevantItemAssignments
			.filter((ia) => ia.categoryId === cat.id)
			.map((ia) => itemsMap.get(ia.itemId))
			.filter(Boolean)

		return {
			id: cat.id,
			displayName: cat.displayName,
			internalName: cat.internalName,
			description: cat.description,
			items: assignedItems.map((item) => {
				const imageKeys = parseMenuItemImageKeys(
					item?.imageKeys,
					item?.imageKey,
				)
				return {
					id: item!.id,
					displayName: item!.displayName,
					internalName: item!.internalName,
					description: item!.description,
					price: item!.price,
					imageKey: item!.imageKey,
					imageUrl: item!.imageKey
						? (mediaMap.get(item!.imageKey) ?? null)
						: null,
					imageKeys,
					imageUrls: imageKeys
						.map((k) => mediaMap.get(k))
						.filter(Boolean) as string[],
					variations: parseMenuVariations(JSON.stringify(item!.variations)),
					modifierGroups: item!.modifierGroupAssignments.map((mga) => ({
						id: mga.modifierGroup.id,
						name: mga.modifierGroup.name,
						selectionType: mga.modifierGroup.selectionType,
						minSelections: mga.modifierGroup.minSelections,
						maxSelections: mga.modifierGroup.maxSelections,
						options: mga.modifierGroup.optionAssignments.map((oa) => ({
							id: oa.option.id,
							displayName: oa.option.displayName,
							description: oa.option.description,
							price: oa.option.price,
							imageKey: oa.option.imageKey,
							imageUrl: oa.option.imageKey
								? (mediaMap.get(oa.option.imageKey) ?? null)
								: null,
						})),
					})),
				}
			}),
		}
	})

	// Format pickup windows with generated slots
	const formattedWindows = drop.pickupWindows.map((pw) => {
		const slots = generatePickupSlots(
			pw.startTime,
			pw.endTime,
			pw.slotIntervalMinutes,
		)
		return {
			id: pw.id,
			locationId: pw.locationId,
			location: pw.location
				? {
						id: pw.location.id,
						name: pw.location.name,
						phone: pw.location.phone,
						address: safeJsonParse<LocationAddress | null>(
							pw.location.address,
							null,
						),
						timezone: pw.location.timezone,
					}
				: null,
			date: pw.date,
			startTime: pw.startTime,
			endTime: pw.endTime,
			slotIntervalMinutes: pw.slotIntervalMinutes,
			maxOrdersPerSlot: pw.maxOrdersPerSlot,
			orderLeadTimeMinutes: pw.orderLeadTimeMinutes,
			slots,
		}
	})

	const payload = {
		organization: {
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency: org.dataRegion === 'ksa' ? 'SAR' : 'USD',
		},
		drop: {
			id: drop.id,
			title: drop.title,
			slug: drop.slug,
			description: drop.description,
			coverImageKey: drop.coverImageKey,
			coverImageUrl: drop.coverImageKey
				? (mediaMap.get(drop.coverImageKey) ?? drop.coverImageUrl)
				: drop.coverImageUrl,
			status: drop.status,
			ordersOpenAt: drop.ordersOpenAt ? drop.ordersOpenAt.toISOString() : null,
			ordersCloseAt: drop.ordersCloseAt
				? drop.ordersCloseAt.toISOString()
				: null,
			visibility: drop.visibility,
			checkoutHoldMinutes: drop.checkoutHoldMinutes,
			showOrdersOpenTime: drop.showOrdersOpenTime,
			showMenuPreview: drop.showMenuPreview,
			showInventoryRemaining: drop.showInventoryRemaining,
			includeGiftCard: drop.includeGiftCard,
		},
		pickupWindows: formattedWindows,
		inventoryOverrides: drop.inventoryOverrides,
		categories: formattedCategories,
	}

	if (!isPreview) {
		await setCachedSiteData(cacheKey, payload, 30)
	}

	return Response.json(payload, {
		headers: {
			'Cache-Control': isPreview
				? 'no-cache, no-store'
				: 'public, max-age=15, stale-while-revalidate=60',
		},
	})
}
