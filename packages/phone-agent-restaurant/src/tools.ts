import { z } from 'zod'
import {
	defineVerticalTool,
	LINK_HANDOFF_TTL_HOURS,
	type PhoneAgentSettings,
	type VerticalContext,
	type VerticalTool,
} from '@repo/phone-agent'
import { type RestaurantVerticalData } from './data.ts'
import {
	type AgentMenu,
	type AgentMenuCategory,
	buildCartLine,
	describeMenuItem,
	HandoffCartSchema,
	type HandoffCartItem,
	listMenuCategories,
	resolveMenuItem,
	searchMenuItems,
	suggestUpsells,
	summarizeCart,
} from './menu.ts'
import { type RestaurantSettings } from './settings.ts'

/** What the restaurant tools remember during one call. */
export type RestaurantCallState = {
	cart: HandoffCartItem[]
	upsellOffered: boolean
}

export function createRestaurantCallState(): RestaurantCallState {
	return { cart: [], upsellOffered: false }
}

export const FULFILLMENT_MODES = ['pickup', 'delivery'] as const
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number]

/** The data an order link carries: the cart and the caller's choice, if any. */
export const RestaurantHandoffPayloadSchema = z.object({
	cart: HandoffCartSchema,
	fulfillmentMode: z.enum(FULFILLMENT_MODES).nullable(),
})
export type RestaurantHandoffPayload = z.infer<
	typeof RestaurantHandoffPayloadSchema
>

/** The Sites menu page, for one location when it is known. */
export function restaurantMenuPath(locationId: string | null) {
	const params = new URLSearchParams()
	if (locationId) params.set('location', locationId)
	return params.size ? `/menu?${params}` : '/menu'
}

/**
 * Items the restaurant doesn't take by phone. Excluding a category also
 * excludes its subcategories.
 */
export function phoneExcludedItemIds(
	menus: AgentMenu[],
	excludedCategoryIds: readonly string[],
) {
	const ids = new Set<string>()
	if (!excludedCategoryIds.length) return ids
	const excluded = new Set(excludedCategoryIds)
	const visit = (category: AgentMenuCategory, inherited: boolean) => {
		const off = inherited || excluded.has(category.id)
		if (off) for (const item of category.items) ids.add(item.id)
		for (const sub of category.subcategories ?? []) visit(sub, off)
	}
	for (const menu of menus) {
		for (const category of menu.categories) visit(category, false)
	}
	return ids
}

/**
 * Orders can only be built when the store is open and online ordering
 * isn't paused, unless links are allowed after hours.
 */
export function canTakeOrders(input: {
	isOpen: boolean
	orderingOpen: boolean
	settings: Pick<PhoneAgentSettings, 'afterHoursMode'>
}) {
	if (input.isOpen) return input.orderingOpen !== false
	return input.settings.afterHoursMode === 'answer_and_link'
}

type Tool = VerticalTool<
	RestaurantVerticalData,
	RestaurantSettings,
	RestaurantCallState
>

function tool<TParams extends z.AnyZodObject>(
	definition: Parameters<
		typeof defineVerticalTool<
			TParams,
			RestaurantVerticalData,
			RestaurantSettings,
			RestaurantCallState
		>
	>[0],
): Tool {
	return defineVerticalTool(definition)
}

const searchMenu = tool({
	name: 'search_menu',
	description:
		'Search the menu by dish name, ingredient, or category. Use this before saying an item is not available.',
	parameters: z.object({
		query: z.string().describe('What the caller asked for, in their words'),
	}),
	execute: ({ query }, { data, formatPrice }) => {
		const results = searchMenuItems(data.menus, query, 5)
		if (!results.length) {
			return {
				results: [],
				note: 'Nothing matched. Ask the caller to describe it differently.',
			}
		}
		return {
			results: results.map((entry) => describeMenuItem(entry, formatPrice)),
		}
	},
})

const getMenuItem = tool({
	name: 'get_menu_item',
	description:
		'Get full details for one menu item: sizes, required choices, add-ons, allergens. A choice can have its own follow-up choices listed under it.',
	parameters: z.object({
		item: z.string().describe('Item id from search_menu, or the item name'),
	}),
	execute: ({ item }, { data, formatPrice }) => {
		const resolution = resolveMenuItem(data.menus, item)
		if (resolution.status === 'found') {
			return describeMenuItem(resolution.entry, formatPrice)
		}
		if (resolution.status === 'ambiguous') {
			return {
				candidates: resolution.candidates.map((entry) => ({
					id: entry.item.id,
					name: entry.item.displayName,
				})),
				note: 'Ask which one they mean.',
			}
		}
		return { error: `"${item}" is not on the menu.` }
	},
})

const listCategories = tool({
	name: 'list_menu_categories',
	description: 'List the menu categories, for callers who ask what you have.',
	execute: (ignoredArgs, { data }) => ({
		categories: listMenuCategories(data.menus),
	}),
})

const getOrder = tool({
	name: 'get_order',
	description: 'Get the current order with line ids, prices, and the subtotal.',
	execute: (ignoredArgs, { state, formatPrice }) =>
		state.cart.length
			? summarizeCart(state.cart, formatPrice)
			: { lines: [], note: 'The order is empty.' },
})

function addToOrder(notByPhone: ReadonlySet<string>) {
	return tool({
		name: 'add_to_order',
		description:
			'Add an item to the order. Use ids from search_menu or get_menu_item. Include every required choice, including follow-up choices nested under a chosen option. A size said with the item name, like "large pepperoni", is understood.',
		parameters: z.object({
			item: z.string().describe('Item id (preferred) or exact item name'),
			variantId: z
				.string()
				.optional()
				.describe('Size or variation id, required when the item has sizes'),
			optionIds: z
				.array(z.string())
				.optional()
				.describe(
					'Ids of chosen options and add-ons, including nested choices',
				),
			quantity: z.number().int().min(1).max(99).optional(),
			instructions: z
				.string()
				.optional()
				.describe('Special requests for this item, such as "no onions"'),
		}),
		execute: (input, { data, state, settings, isOpen, formatPrice }) => {
			if (
				!canTakeOrders({ isOpen, orderingOpen: data.orderingOpen, settings })
			) {
				return {
					error: "The store is closed and isn't taking orders right now.",
				}
			}
			const result = buildCartLine(data.menus, input, () => crypto.randomUUID())
			if (!result.ok) {
				return result.candidates
					? { error: result.error, candidates: result.candidates }
					: { error: result.error }
			}
			if (notByPhone.has(result.line.itemId)) {
				return {
					error: `${result.line.name} can't be ordered by phone. Offer to text the order link so they can order it online.`,
				}
			}
			state.cart.push(result.line)
			return {
				added: summarizeCart([result.line], formatPrice).lines[0],
				order: summarizeCart(state.cart, formatPrice),
			}
		},
	})
}

const updateOrderLine = tool({
	name: 'update_order_line',
	description:
		'Change the quantity of an order line, or remove it with quantity 0.',
	parameters: z.object({
		lineId: z.string().describe('Line id from get_order'),
		quantity: z.number().int().min(0).max(99),
	}),
	execute: ({ lineId, quantity }, { state, formatPrice }) => {
		const index = state.cart.findIndex((line) => line.id === lineId)
		if (index === -1) {
			return { error: 'That line is not in the order. Call get_order first.' }
		}
		if (quantity === 0) state.cart.splice(index, 1)
		else state.cart[index] = { ...state.cart[index]!, quantity }
		return summarizeCart(state.cart, formatPrice)
	},
})

const suggestAddOns = tool({
	name: 'suggest_add_ons',
	description:
		'Get up to three add-ons the restaurant wants you to suggest. Use once per call.',
	execute: (ignoredArgs, { data, state, formatPrice }) => {
		if (state.upsellOffered) {
			return {
				note: 'You already suggested an add-on on this call. Do not suggest another.',
			}
		}
		state.upsellOffered = true
		return {
			suggestions: suggestUpsells(
				data.menus,
				state.cart.map((line) => line.itemId),
				3,
			).map((entry) => describeMenuItem(entry, formatPrice)),
		}
	},
})

const sendOrderLink = tool({
	name: 'send_order_link',
	description:
		'Text the caller a link to review and pay for the order. Only after they agree to get a text.',
	parameters: z.object({
		phone: z
			.string()
			.optional()
			.describe('Number to text if not the one they are calling from'),
		fulfillment: z.enum(FULFILLMENT_MODES).optional(),
	}),
	rejectDuplicates: true,
	blockedDuringTransfer: true,
	execute: async (
		{ phone, fulfillment },
		{ config, data, state, services },
	) => {
		if (!state.cart.length) {
			return { error: 'The order is empty. Take the order first.' }
		}
		const payload: RestaurantHandoffPayload = {
			cart: state.cart,
			fulfillmentMode: fulfillment ?? null,
		}
		const result = await services.sendLink({
			path: restaurantMenuPath(config.scopeId ?? data.location.id),
			payload,
			phone: phone ?? null,
		})
		if (result.ok) {
			return result.shownOnScreen
				? {
						sent: true,
						note: 'Test call: the link is shown on screen instead of texted.',
					}
				: {
						sent: true,
						note: `Link texted. It expires in ${LINK_HANDOFF_TTL_HOURS} hours.`,
					}
		}
		switch (result.reason) {
			case 'invalid_phone':
				return {
					error: `That is not a valid US phone number. Tell the caller: "${result.explanation}" Then ask for another number or suggest ordering on the website.`,
				}
			case 'no_number':
				return {
					error:
						'There is no number to text. Ask the caller for a mobile number.',
				}
			case 'text_limit':
				return {
					error: `No more texts can be sent on this call. Tell the caller: "${result.explanation}" Suggest ordering on the website instead.`,
				}
			case 'transfer_in_progress':
				return { error: result.explanation }
			default:
				return {
					error: `The text was not sent. Tell the caller: "${result.explanation}" Then suggest ordering on the website instead.`,
				}
		}
	},
})

/** The menu, order, and order link tools offered on this call. */
export function restaurantTools(
	context: Pick<
		VerticalContext<RestaurantVerticalData, RestaurantSettings>,
		'data' | 'verticalSettings'
	>,
): Tool[] {
	const { data, verticalSettings } = context
	const notByPhone = phoneExcludedItemIds(
		data.menus,
		verticalSettings.ordering.excludedCategoryIds,
	)
	return [
		searchMenu,
		getMenuItem,
		listCategories,
		getOrder,
		addToOrder(notByPhone),
		updateOrderLine,
		...(verticalSettings.upsellsEnabled ? [suggestAddOns] : []),
		sendOrderLink,
	]
}
