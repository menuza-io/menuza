import {
	PRICING_ROUNDING_MAX_MINOR,
	PRICING_ROUNDING_MODES,
	PRICING_RULE_MAX_BP,
	PRICING_RULE_MIN_BP,
	type MenuPricingRule,
	type PricingRounding,
} from '@repo/common/menu-pricing'
import { parseMenuVariations } from '@repo/common/menu-types'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuPricingRule,
} from '@repo/database'
import { z } from 'zod'
import { asciiNumberText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	assertCategoryIdsInOrganization,
	assertLocationIdsInOrganization,
} from './ownership.server.ts'
import {
	publishPricingRules,
	type MenuStructure,
	type PreviewDish,
	type PricingRuleDraft,
	type PricingRuleRow,
} from './pricing-rules.ts'

export async function loadPricingRuleRows(
	organizationId: string,
): Promise<PricingRuleRow[]> {
	return db
		.select({
			id: OrganizationMenuPricingRule.id,
			name: OrganizationMenuPricingRule.name,
			percentBp: OrganizationMenuPricingRule.percentBp,
			menuIds: OrganizationMenuPricingRule.menuIds,
			categoryIds: OrganizationMenuPricingRule.categoryIds,
			locationIds: OrganizationMenuPricingRule.locationIds,
			roundingMode: OrganizationMenuPricingRule.roundingMode,
			roundingValue: OrganizationMenuPricingRule.roundingValue,
			excludeMinPrice: OrganizationMenuPricingRule.excludeMinPrice,
			excludeMaxPrice: OrganizationMenuPricingRule.excludeMaxPrice,
			startsAt: OrganizationMenuPricingRule.startsAt,
			endedAt: OrganizationMenuPricingRule.endedAt,
			createdAt: OrganizationMenuPricingRule.createdAt,
		})
		.from(OrganizationMenuPricingRule)
		.where(eq(OrganizationMenuPricingRule.organizationId, organizationId))
		.orderBy(asc(OrganizationMenuPricingRule.createdAt))
}

/** Menu-to-category and category-to-subcategory links of an organization. */
export async function loadMenuStructure(
	organizationId: string,
): Promise<MenuStructure> {
	const [assignments, categories] = await Promise.all([
		db
			.select({
				menuId: OrganizationMenuCategoryAssignment.menuId,
				categoryId: OrganizationMenuCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuCategoryAssignment)
			.innerJoin(
				OrganizationMenu,
				eq(OrganizationMenu.id, OrganizationMenuCategoryAssignment.menuId),
			)
			.where(eq(OrganizationMenu.organizationId, organizationId)),
		db
			.select({
				id: OrganizationMenuCategory.id,
				parentId: OrganizationMenuCategory.parentId,
			})
			.from(OrganizationMenuCategory)
			.where(and(eq(OrganizationMenuCategory.organizationId, organizationId))),
	])
	const menuCategoryIds = new Map<string, string[]>()
	for (const row of assignments) {
		const list = menuCategoryIds.get(row.menuId) ?? []
		list.push(row.categoryId)
		menuCategoryIds.set(row.menuId, list)
	}
	const childCategoryIds = new Map<string, string[]>()
	for (const row of categories) {
		if (!row.parentId) continue
		const list = childCategoryIds.get(row.parentId) ?? []
		list.push(row.id)
		childCategoryIds.set(row.parentId, list)
	}
	return { menuCategoryIds, childCategoryIds }
}

/** The organization's live rules as the menu payload publishes them. */
export async function loadPublishedPricingRules(
	organizationId: string,
	now: Date = new Date(),
): Promise<MenuPricingRule[]> {
	const rows = await loadPricingRuleRows(organizationId)
	if (rows.length === 0) return []
	return publishPricingRules(rows, await loadMenuStructure(organizationId), now)
}

// ---------------------------------------------------------------------------
// The Pricing rules page (#388): form, preview, create, end.
// ---------------------------------------------------------------------------

export const PRICING_RULES_MAX = 50
export const PREVIEW_ROWS_MAX = 300

const idList = z.array(z.string().min(1).max(64)).max(500).default([])

export const PricingRuleBodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.enum(['preview', 'create']),
		name: z.string().trim().max(80).default(''),
		percent: z.string().trim().max(12),
		menuIds: idList,
		categoryIds: idList,
		locationIds: idList,
		roundingMode: z.enum(PRICING_ROUNDING_MODES).default('none'),
		roundingDecimals: z.union([z.literal(0), z.literal(1)]).default(0),
		roundingAmount: z.string().trim().max(16).default(''),
		excludeMin: z.string().trim().max(16).default(''),
		excludeMax: z.string().trim().max(16).default(''),
	}),
	z.object({ intent: z.literal('end'), ruleId: z.string().min(1).max(64) }),
])

export type PricingRuleFormError =
	| 'name_required'
	| 'percent_invalid'
	| 'rounding_invalid'
	| 'range_invalid'
	| 'too_many_rules'

/** The percentage typed in the form as basis points ("8.5" is 850), or null. */
export function percentToBp(text: string): number | null {
	const ascii = asciiNumberText(text).replace(/^\+/, '').replace(/%$/, '')
	if (!/^-?\d{1,4}(?:\.\d{1,2})?$/.test(ascii)) return null
	const bp = Math.round(Number(ascii) * 100)
	if (bp === 0 || bp < PRICING_RULE_MIN_BP || bp > PRICING_RULE_MAX_BP)
		return null
	return bp
}

/** A typed price in the menu's units (two decimals), or null when blank; undefined when bad. */
function moneyText(text: string): number | null | undefined {
	if (!text) return null
	const minor = parseMoneyToMinor(text, { max: 99_999_999 })
	return minor === null ? undefined : minor / 100
}

export function draftFromBody(
	body: Extract<
		z.infer<typeof PricingRuleBodySchema>,
		{ intent: 'preview' | 'create' }
	>,
):
	| { ok: true; draft: PricingRuleDraft }
	| { ok: false; error: PricingRuleFormError } {
	const percentBp = percentToBp(body.percent)
	if (percentBp === null) return { ok: false, error: 'percent_invalid' }
	let rounding: PricingRounding = { mode: 'none' }
	if (body.roundingMode === 'decimals') {
		rounding = { mode: 'decimals', decimals: body.roundingDecimals }
	} else if (body.roundingMode === 'amount') {
		const amountMinor = parseMoneyToMinor(body.roundingAmount, {
			min: 1,
			max: PRICING_ROUNDING_MAX_MINOR,
		})
		if (amountMinor === null) return { ok: false, error: 'rounding_invalid' }
		rounding = { mode: 'amount', amountMinor }
	}
	const excludeMinPrice = moneyText(body.excludeMin)
	const excludeMaxPrice = moneyText(body.excludeMax)
	if (excludeMinPrice === undefined || excludeMaxPrice === undefined)
		return { ok: false, error: 'range_invalid' }
	if (
		excludeMinPrice !== null &&
		excludeMaxPrice !== null &&
		excludeMinPrice > excludeMaxPrice
	)
		return { ok: false, error: 'range_invalid' }
	return {
		ok: true,
		draft: {
			percentBp,
			menuIds: [...new Set(body.menuIds)],
			categoryIds: [...new Set(body.categoryIds)],
			locationIds: [...new Set(body.locationIds)],
			rounding,
			excludeMinPrice,
			excludeMaxPrice,
		},
	}
}

/** 404 when a submitted menu, category or location is not the organization's. */
export async function assertDraftInOrganization(
	organizationId: string,
	draft: PricingRuleDraft,
) {
	await assertCategoryIdsInOrganization(organizationId, draft.categoryIds)
	await assertLocationIdsInOrganization(organizationId, draft.locationIds)
	if (draft.menuIds.length > 0) {
		const rows = await db
			.select({ id: OrganizationMenu.id })
			.from(OrganizationMenu)
			.where(
				and(
					eq(OrganizationMenu.organizationId, organizationId),
					inArray(OrganizationMenu.id, draft.menuIds),
				),
			)
		if (rows.length !== draft.menuIds.length)
			throw new Response('Menu not found', { status: 404 })
	}
}

/** Dishes, locations, menu structure and fixed prices for a preview. */
export async function loadPreviewInput(organizationId: string) {
	const [items, links, locations, overrides, structure] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				price: OrganizationMenuItem.price,
				orderTypePrices: OrganizationMenuItem.orderTypePrices,
				variations: OrganizationMenuItem.variations,
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuItem.position)),
		db
			.select({
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
				categoryId: OrganizationMenuItemCategoryAssignment.categoryId,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			),
		db
			.select({
				locationId: OrganizationMenuLocationOverride.locationId,
				entityId: OrganizationMenuLocationOverride.entityId,
				entityType: OrganizationMenuLocationOverride.entityType,
				price: OrganizationMenuLocationOverride.price,
			})
			.from(OrganizationMenuLocationOverride)
			.where(
				eq(OrganizationMenuLocationOverride.organizationId, organizationId),
			),
		loadMenuStructure(organizationId),
	])
	const categoriesOf = new Map<string, string[]>()
	for (const link of links) {
		const list = categoriesOf.get(link.itemId) ?? []
		list.push(link.categoryId)
		categoriesOf.set(link.itemId, list)
	}
	const overrideMap = new Map<string, Map<string, number>>()
	for (const row of overrides) {
		if (row.entityType !== 'item' || row.price == null) continue
		const map = overrideMap.get(row.locationId) ?? new Map<string, number>()
		map.set(row.entityId, row.price)
		overrideMap.set(row.locationId, map)
	}
	const dishes: PreviewDish[] = items
		.filter((item) => item.availabilityStatus !== 'hidden')
		.map((item) => {
			const variants = parseMenuVariations(item.variations).variants
			return {
				id: item.id,
				name: item.displayName,
				price: item.price,
				orderTypePrices: item.orderTypePrices,
				categoryIds: categoriesOf.get(item.id) ?? [],
				...(variants.length
					? { variantPrices: variants.map((variant) => variant.price) }
					: {}),
			}
		})
	return {
		dishes,
		locationIds: locations.map((location) => location.id),
		structure,
		overrides: overrideMap,
	}
}
