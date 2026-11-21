import { createId } from '@paralleldrive/cuid2'
import { AuditAction, auditService } from '@repo/audit'
import { MenuVariationsSchema } from '@repo/common/menu-types'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	MenuImport,
	Organization,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import { checkModifierGraphChange } from '#app/utils/menu/modifier-graph.server.ts'
import { createMenuSnapshot } from '#app/utils/menu/snapshot.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	type LocalizedImportText,
	type MenuImportDraft,
	menuImportDraftSchema,
	type MenuImportDraftSize,
	type MenuImportMissingExistingAction,
	normalizeMatchName,
	pickDraftText,
	serializeLocalizedTextForOrg,
} from './schema.ts'

type BatchStatement = Parameters<typeof db.batch>[0][number]

export type ApplyMenuImportInput = {
	importId: string
	organizationId: string
	organizationSlug: string
	userId: string
	draft: MenuImportDraft
	publishNow?: boolean
	missingExistingAction?: MenuImportMissingExistingAction
	request?: Request
}

export type ApplyMenuImportResult =
	| {
			ok: true
			alreadyApplied: boolean
			snapshotId: string | null
			createdMenus: number
			updatedMenus: number
			createdCategories: number
			updatedCategories: number
			createdItems: number
			updatedItems: number
			createdModifierGroups: number
			createdOptions: number
			markedUnavailable: number
	  }
	| {
			ok: false
			status: number
			error:
				| 'not_found'
				| 'import_in_progress'
				| 'invalid_state'
				| 'invalid_draft'
				| 'apply_failed'
			message?: string
	  }

function addNameKeys(
	map: Map<string, string>,
	id: string,
	rawLocalized: string | null | undefined,
	defaultLocale: string,
) {
	if (!rawLocalized) return
	const parsed = parseLocalizedString(rawLocalized, defaultLocale)
	for (const value of Object.values(parsed)) {
		if (!value) continue
		const key = normalizeMatchName(value)
		if (key && !map.has(key)) map.set(key, id)
	}
	const rawKey = normalizeMatchName(rawLocalized)
	if (rawKey && !map.has(rawKey)) map.set(rawKey, id)
}

function findMatchByLocalizedName(
	map: ReadonlyMap<string, string>,
	text: LocalizedImportText,
): string | null {
	if (text.en) {
		const id = map.get(normalizeMatchName(text.en))
		if (id) return id
	}
	if (text.ar) {
		const id = map.get(normalizeMatchName(text.ar))
		if (id) return id
	}
	return null
}

function variationLabel(
	text: LocalizedImportText,
	orgLocales: readonly string[],
	defaultLocale: string,
): string {
	const serialized = serializeLocalizedTextForOrg(
		text,
		orgLocales,
		defaultLocale,
		true,
	)
	if (serialized && serialized.length <= 80) return serialized
	return (pickDraftText(text, defaultLocale) || 'Option').slice(0, 80)
}

function buildVariationsJson(
	sizes: readonly MenuImportDraftSize[],
	orgLocales: readonly string[],
	defaultLocale: string,
): string | null {
	if (sizes.length === 0) return null
	const seenNames = new Set<string>()
	const dedupedSizes: MenuImportDraftSize[] = []
	for (const size of sizes) {
		const label = variationLabel(size.name, orgLocales, defaultLocale)
		const norm = label.toLocaleLowerCase()
		if (seenNames.has(norm)) continue
		seenNames.add(norm)
		dedupedSizes.push(size)
	}
	if (dedupedSizes.length === 0) return null

	const groupId = createId()
	const values = dedupedSizes.map((size) => ({
		id: createId(),
		name: variationLabel(size.name, orgLocales, defaultLocale),
	}))
	const variants = dedupedSizes.map((size, idx) => ({
		id: createId(),
		valueIds: [values[idx]!.id],
		price: size.price,
		imageKey: null,
		excludeFromDiscounts: false,
		availabilityStatus: 'available' as const,
		unavailableUntil: null,
	}))

	const candidate = {
		groups: [
			{
				id: groupId,
				name: variationLabel(
					{ en: 'Size', ar: 'الحجم' },
					orgLocales,
					defaultLocale,
				),
				values,
			},
		],
		variants,
	}

	const parsed = MenuVariationsSchema.safeParse(candidate)
	if (!parsed.success) return null
	return JSON.stringify(parsed.data)
}

/**
 * Applies a reviewed menu import draft atomically and idempotently (#73):
 * 1. Atomically claims the `MenuImport` row (`ready -> applying`, or returns
 *    idempotently when already `applied`).
 * 2. Takes a `before_import` menu snapshot first.
 * 3. Validates modifier changes with `checkModifierGraphChange`.
 * 4. Matches existing menus, categories, dishes, modifier groups, and options
 *    by explicit `matchExistingItemId` or exact localized name so applying the
 *    same import twice or re-importing creates no duplicates.
 * 5. Never writes `allergens`, `calorieMin`, `calorieMax`, `calories`,
 *    `dietaryTags`, or images.
 * 6. Creates menus & dishes unavailable by default unless `publishNow` is true.
 * 7. Purges the organization site cache and logs an audit entry.
 */
export async function applyMenuImport(
	input: ApplyMenuImportInput,
): Promise<ApplyMenuImportResult> {
	const parsedDraft = menuImportDraftSchema.safeParse(input.draft)
	if (!parsedDraft.success) {
		return {
			ok: false,
			status: 400,
			error: 'invalid_draft',
			message: 'Menu import draft failed validation',
		}
	}
	const draft = parsedDraft.data
	const publishNow = Boolean(input.publishNow)
	const missingExistingAction: MenuImportMissingExistingAction =
		input.missingExistingAction ?? 'keep'

	const [importRow] = await db
		.select({
			id: MenuImport.id,
			organizationId: MenuImport.organizationId,
			status: MenuImport.status,
		})
		.from(MenuImport)
		.where(
			and(
				eq(MenuImport.id, input.importId),
				eq(MenuImport.organizationId, input.organizationId),
			),
		)
		.limit(1)

	if (!importRow) {
		return { ok: false, status: 404, error: 'not_found' }
	}
	if (importRow.status === 'applied') {
		return {
			ok: true,
			alreadyApplied: true,
			snapshotId: null,
			createdMenus: 0,
			updatedMenus: 0,
			createdCategories: 0,
			updatedCategories: 0,
			createdItems: 0,
			updatedItems: 0,
			createdModifierGroups: 0,
			createdOptions: 0,
			markedUnavailable: 0,
		}
	}

	const claimNow = new Date()
	const claimed = await db
		.update(MenuImport)
		.set({ status: 'applying', updatedAt: claimNow })
		.where(
			and(
				eq(MenuImport.id, input.importId),
				eq(MenuImport.organizationId, input.organizationId),
				eq(MenuImport.status, 'ready'),
			),
		)
		.returning({ id: MenuImport.id })

	if (claimed.length === 0) {
		const [latest] = await db
			.select({ status: MenuImport.status })
			.from(MenuImport)
			.where(
				and(
					eq(MenuImport.id, input.importId),
					eq(MenuImport.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (latest?.status === 'applied') {
			return {
				ok: true,
				alreadyApplied: true,
				snapshotId: null,
				createdMenus: 0,
				updatedMenus: 0,
				createdCategories: 0,
				updatedCategories: 0,
				createdItems: 0,
				updatedItems: 0,
				createdModifierGroups: 0,
				createdOptions: 0,
				markedUnavailable: 0,
			}
		}
		return {
			ok: false,
			status: 409,
			error:
				latest?.status === 'applying' ? 'import_in_progress' : 'invalid_state',
		}
	}

	let committed = false
	try {
		const [orgRow] = await db
			.select({
				id: Organization.id,
				slug: Organization.slug,
				siteLocales: Organization.siteLocales,
				siteDefaultLocale: Organization.siteDefaultLocale,
			})
			.from(Organization)
			.where(eq(Organization.id, input.organizationId))
			.limit(1)

		if (!orgRow) {
			return { ok: false, status: 404, error: 'not_found' }
		}

		const { locales: orgLocales, defaultLocale } = parseSiteLocalesConfig(
			orgRow.siteLocales,
			orgRow.siteDefaultLocale,
		)

		const snapshotId = await createMenuSnapshot({
			organizationId: input.organizationId,
			reason: 'before_import',
			userId: input.userId,
			label: `Menu import ${input.importId}`,
		})

		const [
			existingMenus,
			existingCategories,
			existingMenuCategoryLinks,
			existingItems,
			existingItemCategoryLinks,
			existingModifierGroups,
			existingItemModifierGroupLinks,
			existingOptions,
			existingModifierGroupOptionLinks,
		] = await Promise.all([
			db
				.select({
					id: OrganizationMenu.id,
					displayName: OrganizationMenu.displayName,
					position: OrganizationMenu.position,
					availabilityStatus: OrganizationMenu.availabilityStatus,
				})
				.from(OrganizationMenu)
				.where(eq(OrganizationMenu.organizationId, input.organizationId)),
			db
				.select({
					id: OrganizationMenuCategory.id,
					displayName: OrganizationMenuCategory.displayName,
					position: OrganizationMenuCategory.position,
				})
				.from(OrganizationMenuCategory)
				.where(
					eq(OrganizationMenuCategory.organizationId, input.organizationId),
				),
			db
				.select({
					menuId: OrganizationMenuCategoryAssignment.menuId,
					categoryId: OrganizationMenuCategoryAssignment.categoryId,
				})
				.from(OrganizationMenuCategoryAssignment)
				.innerJoin(
					OrganizationMenu,
					eq(OrganizationMenuCategoryAssignment.menuId, OrganizationMenu.id),
				)
				.where(eq(OrganizationMenu.organizationId, input.organizationId)),
			db
				.select({
					id: OrganizationMenuItem.id,
					displayName: OrganizationMenuItem.displayName,
					position: OrganizationMenuItem.position,
					availabilityStatus: OrganizationMenuItem.availabilityStatus,
				})
				.from(OrganizationMenuItem)
				.where(eq(OrganizationMenuItem.organizationId, input.organizationId)),
			db
				.select({
					categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
					itemId: OrganizationMenuItemCategoryAssignment.itemId,
				})
				.from(OrganizationMenuItemCategoryAssignment)
				.innerJoin(
					OrganizationMenuItem,
					eq(
						OrganizationMenuItemCategoryAssignment.itemId,
						OrganizationMenuItem.id,
					),
				)
				.where(eq(OrganizationMenuItem.organizationId, input.organizationId)),
			db
				.select({
					id: OrganizationMenuModifierGroup.id,
					name: OrganizationMenuModifierGroup.name,
					position: OrganizationMenuModifierGroup.position,
				})
				.from(OrganizationMenuModifierGroup)
				.where(
					eq(
						OrganizationMenuModifierGroup.organizationId,
						input.organizationId,
					),
				),
			db
				.select({
					itemId: OrganizationMenuItemModifierGroupAssignment.itemId,
					modifierGroupId:
						OrganizationMenuItemModifierGroupAssignment.modifierGroupId,
				})
				.from(OrganizationMenuItemModifierGroupAssignment)
				.innerJoin(
					OrganizationMenuItem,
					eq(
						OrganizationMenuItemModifierGroupAssignment.itemId,
						OrganizationMenuItem.id,
					),
				)
				.where(eq(OrganizationMenuItem.organizationId, input.organizationId)),
			db
				.select({
					id: OrganizationMenuOption.id,
					displayName: OrganizationMenuOption.displayName,
					position: OrganizationMenuOption.position,
				})
				.from(OrganizationMenuOption)
				.where(eq(OrganizationMenuOption.organizationId, input.organizationId)),
			db
				.select({
					modifierGroupId:
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
					optionId: OrganizationMenuModifierGroupOptionAssignment.optionId,
				})
				.from(OrganizationMenuModifierGroupOptionAssignment)
				.innerJoin(
					OrganizationMenuModifierGroup,
					eq(
						OrganizationMenuModifierGroupOptionAssignment.modifierGroupId,
						OrganizationMenuModifierGroup.id,
					),
				)
				.where(
					eq(
						OrganizationMenuModifierGroup.organizationId,
						input.organizationId,
					),
				),
		])

		const menuIdByName = new Map<string, string>()
		for (const row of existingMenus) {
			addNameKeys(menuIdByName, row.id, row.displayName, defaultLocale)
		}
		const categoryIdByName = new Map<string, string>()
		for (const row of existingCategories) {
			addNameKeys(categoryIdByName, row.id, row.displayName, defaultLocale)
		}
		const itemById = new Map(existingItems.map((row) => [row.id, row]))
		const itemIdByName = new Map<string, string>()
		for (const row of existingItems) {
			addNameKeys(itemIdByName, row.id, row.displayName, defaultLocale)
		}
		const groupIdByName = new Map<string, string>()
		for (const row of existingModifierGroups) {
			addNameKeys(groupIdByName, row.id, row.name, defaultLocale)
		}
		const optionIdByName = new Map<string, string>()
		for (const row of existingOptions) {
			addNameKeys(optionIdByName, row.id, row.displayName, defaultLocale)
		}

		const menuCatLinks = new Set(
			existingMenuCategoryLinks.map((l) => `${l.menuId}:${l.categoryId}`),
		)
		const catItemLinks = new Set(
			existingItemCategoryLinks.map((l) => `${l.categoryId}:${l.itemId}`),
		)
		const itemGroupLinks = new Set(
			existingItemModifierGroupLinks.map(
				(l) => `${l.itemId}:${l.modifierGroupId}`,
			),
		)
		const groupOptionLinks = new Set(
			existingModifierGroupOptionLinks.map(
				(l) => `${l.modifierGroupId}:${l.optionId}`,
			),
		)
		const existingGroupOptionMap = new Map<string, string[]>()
		for (const link of existingModifierGroupOptionLinks) {
			const list = existingGroupOptionMap.get(link.modifierGroupId) ?? []
			list.push(link.optionId)
			existingGroupOptionMap.set(link.modifierGroupId, list)
		}

		const now = new Date()
		const statements: BatchStatement[] = []
		const touchedMenuIds = new Set<string>()
		const touchedCategoryIds = new Set<string>()
		const touchedItemIds = new Set<string>()
		const touchedGroupIds = new Set<string>()
		const touchedOptionIds = new Set<string>()
		const modifierGraphChanges = new Map<
			string,
			{ id: string; name: string; optionIds: string[] }
		>()

		let nextMenuPos =
			existingMenus.reduce((max, row) => Math.max(max, row.position), -1) + 1
		let nextCategoryPos =
			existingCategories.reduce((max, row) => Math.max(max, row.position), -1) +
			1
		let nextItemPos =
			existingItems.reduce((max, row) => Math.max(max, row.position), -1) + 1
		let nextGroupPos =
			existingModifierGroups.reduce(
				(max, row) => Math.max(max, row.position),
				-1,
			) + 1
		let nextOptionPos =
			existingOptions.reduce((max, row) => Math.max(max, row.position), -1) + 1

		let createdMenus = 0
		let updatedMenus = 0
		let createdCategories = 0
		let updatedCategories = 0
		let createdItems = 0
		let updatedItems = 0
		let createdModifierGroups = 0
		let createdOptions = 0
		let markedUnavailable = 0

		for (const draftMenu of draft.menus) {
			if (!draftMenu.included) continue
			const menuDisplayName = serializeLocalizedTextForOrg(
				draftMenu.name,
				orgLocales,
				defaultLocale,
				true,
			)
			if (!menuDisplayName) continue

			let menuId = findMatchByLocalizedName(menuIdByName, draftMenu.name)
			if (menuId) {
				if (!touchedMenuIds.has(menuId)) {
					touchedMenuIds.add(menuId)
					updatedMenus += 1
					statements.push(
						db
							.update(OrganizationMenu)
							.set({
								displayName: menuDisplayName,
								...(publishNow
									? { availabilityStatus: 'available', unavailableUntil: null }
									: {}),
								updatedAt: now,
							})
							.where(
								and(
									eq(OrganizationMenu.id, menuId),
									eq(OrganizationMenu.organizationId, input.organizationId),
								),
							),
					)
				}
			} else {
				menuId = createId()
				touchedMenuIds.add(menuId)
				addNameKeys(menuIdByName, menuId, menuDisplayName, defaultLocale)
				createdMenus += 1
				statements.push(
					db.insert(OrganizationMenu).values({
						id: menuId,
						organizationId: input.organizationId,
						displayName: menuDisplayName,
						availabilityStatus: publishNow ? 'available' : 'unavailable',
						position: nextMenuPos++,
						createdAt: now,
						updatedAt: now,
					}),
				)
			}

			let catLinkPos = 0
			for (const draftCategory of draftMenu.categories) {
				if (!draftCategory.included) continue
				const catDisplayName = serializeLocalizedTextForOrg(
					draftCategory.name,
					orgLocales,
					defaultLocale,
					true,
				)
				if (!catDisplayName) continue
				const catDescription = serializeLocalizedTextForOrg(
					draftCategory.description,
					orgLocales,
					defaultLocale,
					false,
				)

				let categoryId = findMatchByLocalizedName(
					categoryIdByName,
					draftCategory.name,
				)
				if (categoryId) {
					if (!touchedCategoryIds.has(categoryId)) {
						touchedCategoryIds.add(categoryId)
						updatedCategories += 1
						statements.push(
							db
								.update(OrganizationMenuCategory)
								.set({
									displayName: catDisplayName,
									...(catDescription !== null
										? { description: catDescription }
										: {}),
									updatedAt: now,
								})
								.where(
									and(
										eq(OrganizationMenuCategory.id, categoryId),
										eq(
											OrganizationMenuCategory.organizationId,
											input.organizationId,
										),
									),
								),
						)
					}
				} else {
					categoryId = createId()
					touchedCategoryIds.add(categoryId)
					addNameKeys(
						categoryIdByName,
						categoryId,
						catDisplayName,
						defaultLocale,
					)
					createdCategories += 1
					statements.push(
						db.insert(OrganizationMenuCategory).values({
							id: categoryId,
							organizationId: input.organizationId,
							displayName: catDisplayName,
							description: catDescription,
							availabilityStatus: 'available',
							position: nextCategoryPos++,
							createdAt: now,
							updatedAt: now,
						}),
					)
				}

				const menuCatKey = `${menuId}:${categoryId}`
				if (!menuCatLinks.has(menuCatKey)) {
					menuCatLinks.add(menuCatKey)
					statements.push(
						db.insert(OrganizationMenuCategoryAssignment).values({
							id: createId(),
							menuId,
							categoryId,
							position: catLinkPos++,
							createdAt: now,
						}),
					)
				}

				let itemLinkPos = 0
				for (const draftItem of draftCategory.items) {
					if (!draftItem.included) continue
					const itemDisplayName = serializeLocalizedTextForOrg(
						draftItem.name,
						orgLocales,
						defaultLocale,
						true,
					)
					if (!itemDisplayName) continue
					const itemDescription = serializeLocalizedTextForOrg(
						draftItem.description,
						orgLocales,
						defaultLocale,
						false,
					)
					const variationsJson = buildVariationsJson(
						draftItem.sizes,
						orgLocales,
						defaultLocale,
					)

					let itemId: string | null = null
					if (
						draftItem.matchExistingItemId &&
						itemById.has(draftItem.matchExistingItemId)
					) {
						itemId = draftItem.matchExistingItemId
					} else {
						itemId = findMatchByLocalizedName(itemIdByName, draftItem.name)
					}

					if (itemId) {
						if (!touchedItemIds.has(itemId)) {
							touchedItemIds.add(itemId)
							updatedItems += 1
							// Explicit column allowlist: never writes allergens, calories,
							// dietaryTags, or images from import.
							statements.push(
								db
									.update(OrganizationMenuItem)
									.set({
										displayName: itemDisplayName,
										...(itemDescription !== null
											? { description: itemDescription }
											: {}),
										price: draftItem.price,
										...(variationsJson ? { variations: variationsJson } : {}),
										...(publishNow
											? {
													availabilityStatus: 'available',
													unavailableUntil: null,
												}
											: {}),
										updatedAt: now,
									})
									.where(
										and(
											eq(OrganizationMenuItem.id, itemId),
											eq(
												OrganizationMenuItem.organizationId,
												input.organizationId,
											),
										),
									),
							)
						}
					} else {
						itemId = createId()
						touchedItemIds.add(itemId)
						addNameKeys(itemIdByName, itemId, itemDisplayName, defaultLocale)
						createdItems += 1
						// Explicit column allowlist: allergens & calories stay at table defaults
						// (empty '[]' / null) and are never populated from import.
						statements.push(
							db.insert(OrganizationMenuItem).values({
								id: itemId,
								organizationId: input.organizationId,
								displayName: itemDisplayName,
								description: itemDescription,
								price: draftItem.price,
								variations: variationsJson ?? '{"groups":[],"variants":[]}',
								availabilityStatus: publishNow ? 'available' : 'unavailable',
								position: nextItemPos++,
								createdAt: now,
								updatedAt: now,
							}),
						)
					}

					const catItemKey = `${categoryId}:${itemId}`
					if (!catItemLinks.has(catItemKey)) {
						catItemLinks.add(catItemKey)
						statements.push(
							db.insert(OrganizationMenuItemCategoryAssignment).values({
								id: createId(),
								categoryId,
								itemId,
								position: itemLinkPos++,
								createdAt: now,
							}),
						)
					}

					let groupLinkPos = 0
					for (const draftGroup of draftItem.modifierGroups) {
						if (!draftGroup.included) continue
						const groupName = serializeLocalizedTextForOrg(
							draftGroup.name,
							orgLocales,
							defaultLocale,
							true,
						)
						if (!groupName) continue

						let groupId = findMatchByLocalizedName(
							groupIdByName,
							draftGroup.name,
						)
						if (groupId) {
							if (!touchedGroupIds.has(groupId)) {
								touchedGroupIds.add(groupId)
								statements.push(
									db
										.update(OrganizationMenuModifierGroup)
										.set({
											name: groupName,
											selectionType: draftGroup.selectionType,
											minSelections: draftGroup.minSelections,
											maxSelections: draftGroup.maxSelections,
											updatedAt: now,
										})
										.where(
											and(
												eq(OrganizationMenuModifierGroup.id, groupId),
												eq(
													OrganizationMenuModifierGroup.organizationId,
													input.organizationId,
												),
											),
										),
								)
							}
						} else {
							groupId = createId()
							touchedGroupIds.add(groupId)
							addNameKeys(groupIdByName, groupId, groupName, defaultLocale)
							createdModifierGroups += 1
							statements.push(
								db.insert(OrganizationMenuModifierGroup).values({
									id: groupId,
									organizationId: input.organizationId,
									name: groupName,
									selectionType: draftGroup.selectionType,
									minSelections: draftGroup.minSelections,
									maxSelections: draftGroup.maxSelections,
									availabilityStatus: 'available',
									position: nextGroupPos++,
									createdAt: now,
									updatedAt: now,
								}),
							)
						}

						const itemGroupKey = `${itemId}:${groupId}`
						if (!itemGroupLinks.has(itemGroupKey)) {
							itemGroupLinks.add(itemGroupKey)
							statements.push(
								db.insert(OrganizationMenuItemModifierGroupAssignment).values({
									id: createId(),
									itemId,
									modifierGroupId: groupId,
									position: groupLinkPos++,
									createdAt: now,
								}),
							)
						}

						const optionIdsForGroup = new Set(
							existingGroupOptionMap.get(groupId) ?? [],
						)
						let optionLinkPos = 0
						for (const draftOption of draftGroup.options) {
							if (!draftOption.included) continue
							const optDisplayName = serializeLocalizedTextForOrg(
								draftOption.name,
								orgLocales,
								defaultLocale,
								true,
							)
							if (!optDisplayName) continue

							let optionId = findMatchByLocalizedName(
								optionIdByName,
								draftOption.name,
							)
							if (optionId) {
								if (!touchedOptionIds.has(optionId)) {
									touchedOptionIds.add(optionId)
									statements.push(
										db
											.update(OrganizationMenuOption)
											.set({
												displayName: optDisplayName,
												price: draftOption.price,
												updatedAt: now,
											})
											.where(
												and(
													eq(OrganizationMenuOption.id, optionId),
													eq(
														OrganizationMenuOption.organizationId,
														input.organizationId,
													),
												),
											),
									)
								}
							} else {
								optionId = createId()
								touchedOptionIds.add(optionId)
								addNameKeys(
									optionIdByName,
									optionId,
									optDisplayName,
									defaultLocale,
								)
								createdOptions += 1
								statements.push(
									db.insert(OrganizationMenuOption).values({
										id: optionId,
										organizationId: input.organizationId,
										displayName: optDisplayName,
										price: draftOption.price,
										availabilityStatus: 'available',
										position: nextOptionPos++,
										createdAt: now,
										updatedAt: now,
									}),
								)
							}

							optionIdsForGroup.add(optionId)
							const groupOptKey = `${groupId}:${optionId}`
							if (!groupOptionLinks.has(groupOptKey)) {
								groupOptionLinks.add(groupOptKey)
								statements.push(
									db
										.insert(OrganizationMenuModifierGroupOptionAssignment)
										.values({
											id: createId(),
											modifierGroupId: groupId,
											optionId,
											position: optionLinkPos++,
											createdAt: now,
										}),
								)
							}
						}

						modifierGraphChanges.set(groupId, {
							id: groupId,
							name: groupName,
							optionIds: Array.from(optionIdsForGroup),
						})
					}
				}
			}
		}

		if (modifierGraphChanges.size > 0) {
			const modifierFailure = await checkModifierGraphChange(
				input.organizationId,
				{ groups: Array.from(modifierGraphChanges.values()) },
			)
			if (modifierFailure) {
				return {
					ok: false,
					status: 400,
					error: 'apply_failed',
					message: modifierFailure.message,
				}
			}
		}

		if (missingExistingAction === 'mark_unavailable') {
			for (const existingItem of existingItems) {
				if (touchedItemIds.has(existingItem.id)) continue
				if (existingItem.availabilityStatus === 'unavailable') continue
				markedUnavailable += 1
				statements.push(
					db
						.update(OrganizationMenuItem)
						.set({
							availabilityStatus: 'unavailable',
							unavailableUntil: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(OrganizationMenuItem.id, existingItem.id),
								eq(OrganizationMenuItem.organizationId, input.organizationId),
							),
						),
				)
			}
		}

		statements.push(
			db
				.update(MenuImport)
				.set({
					status: 'applied',
					appliedAt: now,
					error: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(MenuImport.id, input.importId),
						eq(MenuImport.organizationId, input.organizationId),
						eq(MenuImport.status, 'applying'),
					),
				),
		)

		await db.batch(statements as [BatchStatement, ...BatchStatement[]])
		committed = true

		await purgeOrganizationSiteCache(
			input.organizationId,
			input.organizationSlug,
		)

		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId: input.userId,
			organizationId: input.organizationId,
			resourceType: 'menu_import',
			resourceId: input.importId,
			details: `Applied AI menu import ${input.importId}: +${createdMenus} menus, +${createdCategories} categories, +${createdItems} dishes (${updatedItems} updated), publishNow=${publishNow}`,
			request: input.request,
		})

		return {
			ok: true,
			alreadyApplied: false,
			snapshotId,
			createdMenus,
			updatedMenus,
			createdCategories,
			updatedCategories,
			createdItems,
			updatedItems,
			createdModifierGroups,
			createdOptions,
			markedUnavailable,
		}
	} finally {
		if (!committed) {
			await db
				.update(MenuImport)
				.set({ status: 'ready', updatedAt: new Date() })
				.where(
					and(
						eq(MenuImport.id, input.importId),
						eq(MenuImport.organizationId, input.organizationId),
						eq(MenuImport.status, 'applying'),
					),
				)
				.catch(() => {})
		}
	}
}
