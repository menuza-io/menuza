import { isSoldOn } from '@repo/common/menu-channels'
import {
	fixedOverridePrice,
	parseMenuPricingRules,
	resolveMenuItemPrice,
	resolveMenuOptionPrice,
} from '@repo/common/menu-pricing'
import {
	type AgentMenu,
	type AgentMenuCategory,
	type AgentModifierGroup,
} from './menu.ts'

/**
 * The menu as the phone agent quotes it at one location (#412, #388): every
 * price resolved with `@repo/common/menu-pricing` (the location's fixed
 * prices, the pricing rules, and the order type), so the agent says what the
 * order will cost. Prices are pickup prices; a dish or option whose delivery
 * price differs carries `deliveryPrice`. Returns copies.
 */
export function priceAgentMenus(
	menus: AgentMenu[],
	options: {
		locationId: string
		overrides?: Array<{
			entityId: string
			price?: number | null
			channels?: string[] | string | null
		}>
		pricingRules?: unknown
		now?: Date
	},
): AgentMenu[] {
	const rules = parseMenuPricingRules(options.pricingRules)
	const overrideEntryOf = (id: string) =>
		options.overrides?.find((entry) => entry.entityId === id)
	const overrideOf = (id: string) =>
		fixedOverridePrice(overrideEntryOf(id)?.price)
	const context = (orderType: 'pickup' | 'delivery') => ({
		orderType,
		locationId: options.locationId,
		rules,
		now: options.now,
	})
	const categoriesOf = new Map<string, string[]>()
	const index = (category: AgentMenuCategory) => {
		for (const item of category.items) {
			const list = categoriesOf.get(item.id) ?? []
			if (!list.includes(category.id)) list.push(category.id)
			categoriesOf.set(item.id, list)
		}
		category.subcategories?.forEach(index)
	}
	for (const menu of menus) menu.categories.forEach(index)

	const groups = (list: AgentModifierGroup[]): AgentModifierGroup[] =>
		list.map((group) => ({
			...group,
			options: group.options.map((option) => {
				const overridePrice = overrideOf(option.id)
				const pickup = resolveMenuOptionPrice(option, context('pickup'), {
					overridePrice,
				})
				const delivery = resolveMenuOptionPrice(option, context('delivery'), {
					overridePrice,
				})
				return {
					...option,
					price: pickup,
					...(delivery !== pickup ? { deliveryPrice: delivery } : {}),
					...(option.nestedModifierGroups
						? { nestedModifierGroups: groups(option.nestedModifierGroups) }
						: {}),
				}
			}),
		}))

	const category = (entry: AgentMenuCategory): AgentMenuCategory => ({
		...entry,
		items: entry.items
			.filter((item) =>
				isSoldOn('web', { item, override: overrideEntryOf(item.id) }),
			)
			.map((item) => {
				const scope = { ...item, categoryIds: categoriesOf.get(item.id) ?? [] }
				const overridePrice = overrideOf(item.id)
				const variants = item.variations.variants.map((variant) => ({
					...variant,
					price: resolveMenuItemPrice(scope, context('pickup'), {
						variantPrice: variant.price,
						overridePrice,
					}),
				}))
				const pickup = resolveMenuItemPrice(scope, context('pickup'), {
					overridePrice,
				})
				const delivery = resolveMenuItemPrice(scope, context('delivery'), {
					overridePrice,
				})
				const { deliveryPrice: _old, ...rest } = item
				return {
					...rest,
					variations: { ...item.variations, variants },
					price: variants.length
						? Math.min(...variants.map((variant) => variant.price))
						: pickup,
					...(!variants.length && delivery !== pickup
						? { deliveryPrice: delivery }
						: {}),
					modifierGroups: groups(item.modifierGroups),
				}
			}),
		subcategories: entry.subcategories
			?.filter((sub) =>
				isSoldOn('web', { category: sub, override: overrideEntryOf(sub.id) }),
			)
			.map(category),
	})

	return menus
		.filter((menu) =>
			isSoldOn('web', { menu, override: overrideEntryOf(menu.id) }),
		)
		.map((menu) => ({
			...menu,
			categories: menu.categories
				.filter((cat) =>
					isSoldOn('web', { category: cat, override: overrideEntryOf(cat.id) }),
				)
				.map(category),
		}))
}
