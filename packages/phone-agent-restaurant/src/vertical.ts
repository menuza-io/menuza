import {
	type CallPurpose,
	type PhoneAgentVertical,
	type PurposeSignals,
} from '@repo/phone-agent'
import {
	parseRestaurantData,
	RESTAURANT_VERTICAL_ID,
	type RestaurantVerticalData,
} from './data.ts'
import {
	RESTAURANT_CALL_PURPOSES,
	RESTAURANT_CALL_REQUEST_TYPES,
	RESTAURANT_FAQ_CATEGORIES,
	RESTAURANT_FAQ_QUESTIONS,
	RESTAURANT_NOTIFICATION_HEADLINES,
	RESTAURANT_OUTCOME_SUMMARIES,
	RESTAURANT_PHRASE_DEFAULTS,
	RESTAURANT_TRAINING_RULE_CATEGORIES,
} from './definitions.ts'
import { createRestaurantFlowGraph } from './flow.ts'
import {
	describeRestaurantLocation,
	restaurantAvailability,
} from './location.ts'
import { cartSubtotal, flattenMenuItems } from './menu.ts'
import { restaurantPrompt } from './prompt.ts'
import {
	DEFAULT_RESTAURANT_SETTINGS,
	RESTAURANT_DEFAULT_CALL_TAGS,
	type RestaurantSettings,
	RestaurantSettingsSchema,
} from './settings.ts'
import {
	createRestaurantCallState,
	type RestaurantCallState,
	RestaurantHandoffPayloadSchema,
	restaurantMenuPath,
	restaurantTools,
} from './tools.ts'

const CHOICE_PURPOSES: Array<[RegExp, CallPurpose]> = [
	[/reserv|book|table/i, 'reservation'],
	[/order|link|pickup|deliver/i, 'ordering'],
	[/hour|location|address|direction|open/i, 'business_information'],
	[/menu|dish|special/i, 'menu_information'],
]

/** Purpose suggested by a phone menu option label. */
export function inferRestaurantPurpose(text: string): CallPurpose | null {
	return CHOICE_PURPOSES.find(([pattern]) => pattern.test(text))?.[1] ?? null
}

/**
 * Ordering beats menu questions because most orders start with menu
 * questions.
 */
export function classifyRestaurantPurpose(
	signals: PurposeSignals<RestaurantCallState | undefined>,
): CallPurpose | null {
	if (signals.requests.includes('reservation')) return 'reservation'
	if ((signals.state?.cart.length ?? 0) > 0 || signals.linkSent) {
		return 'ordering'
	}
	if (signals.toolsUsed.has('search_menu')) return 'menu_information'
	return null
}

export const restaurantVertical: PhoneAgentVertical<
	RestaurantVerticalData,
	RestaurantSettings,
	RestaurantCallState
> = {
	id: RESTAURANT_VERTICAL_ID,
	label: 'Restaurant',
	scope: { label: 'Location', pluralLabel: 'Locations' },

	callPurposes: RESTAURANT_CALL_PURPOSES,
	callRequestTypes: RESTAURANT_CALL_REQUEST_TYPES,
	trainingRuleCategories: RESTAURANT_TRAINING_RULE_CATEGORIES,
	faqCategories: RESTAURANT_FAQ_CATEGORIES,
	faqQuestions: RESTAURANT_FAQ_QUESTIONS,
	phraseDefaults: RESTAURANT_PHRASE_DEFAULTS,
	notificationHeadlines: RESTAURANT_NOTIFICATION_HEADLINES,
	outcomeSummaries: RESTAURANT_OUTCOME_SUMMARIES,

	settings: {
		schema: RestaurantSettingsSchema,
		defaults: DEFAULT_RESTAURANT_SETTINGS,
	},
	defaultSettings: { tags: RESTAURANT_DEFAULT_CALL_TAGS },
	data: { parse: parseRestaurantData },

	defaultFlow: createRestaurantFlowGraph,
	links: {
		websitePath: restaurantMenuPath,
		websiteMessage: '{business}: order online here: {url}',
		handoffMessage:
			"{business}: here's your order from our call. Review it, pay, and choose pickup or delivery: {url}",
		handoffPayload: RestaurantHandoffPayloadSchema,
	},

	scopeName: ({ data }) => data.location.name,
	businessDetails: ({ data, now, formatPrice }) =>
		describeRestaurantLocation(data.location, now, formatPrice),
	// `{restaurant}` was the business placeholder before verticals existed,
	// and saved messages may still use it.
	messageVariables: ({ config, data }) => ({
		restaurant: config.business.name,
		location: data.location.name,
	}),
	keyterms: ({ data }) =>
		flattenMenuItems(data.menus).map((entry) => entry.item.displayName),
	prompt: ({ data, settings, verticalSettings, isOpen }) =>
		restaurantPrompt({
			verticalSettings,
			afterHoursMode: settings.afterHoursMode,
			isOpen,
			orderingOpen: data.orderingOpen,
		}),
	tools: restaurantTools,
	createCallState: createRestaurantCallState,
	currentAvailability(config, now) {
		const data = parseRestaurantData(config.vertical.data)
		const availability = restaurantAvailability(data.location, now)
		return {
			availability: {
				isOpen: availability.isOpen,
				nextOpen: availability.nextOpen,
			},
			data: { ...data, orderingOpen: availability.orderingOpen },
		}
	},

	classifyPurpose: classifyRestaurantPurpose,
	inferPurpose: inferRestaurantPurpose,
	summarizeCall({ state, formatPrice }) {
		if (!state?.cart.length) return []
		const count = state.cart.reduce((sum, line) => sum + line.quantity, 0)
		return [
			`Order: ${count} item${count === 1 ? '' : 's'}, ${formatPrice(cartSubtotal(state.cart))} before tax.`,
		]
	},
}
