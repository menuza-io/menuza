import {
	type AfterHoursMode,
	type TrainingRule,
	type VerticalPromptContributions,
} from '@repo/phone-agent'
import { type RestaurantSettings } from './settings.ts'

export const RESTAURANT_RULES_TITLE = 'Restaurant rules'

function orderGuidance(ordering: RestaurantSettings['ordering']) {
	const readBack = [
		ordering.readBackSummary ? 'read back the whole order' : '',
		ordering.readBackTotal ? 'say the subtotal' : '',
	].filter(Boolean)
	return `Orders: add items with add_to_order using ids from the menu tools. Ask for every required choice, such as size, before adding. If a tool says an item is ambiguous or not found, ask the caller instead of guessing. Some menu sections can't be ordered by phone; the tools will say so. Briefly confirm each item.${
		readBack.length
			? ` When the caller is done, use get_order and ${readBack.join(' and ')}.`
			: ''
	}${
		ordering.quoteReadyTime
			? ' Mention the typical pickup wait from the store details.'
			: ''
	}`
}

function afterHours(mode: AfterHoursMode) {
	switch (mode) {
		case 'answer_only':
			return "The store is closed: answer questions, but don't take orders. Tell the caller when the store opens."
		case 'take_message':
			return "The store is closed: don't take orders. Tell the caller when the store opens and offer to take a message."
		default:
			return ''
	}
}

/** Upsell rules only apply while upsells are on. */
export function includeRestaurantRule(
	rule: Pick<TrainingRule, 'category'>,
	settings: Pick<RestaurantSettings, 'upsellsEnabled'>,
) {
	return settings.upsellsEnabled || rule.category !== 'upsells_addons'
}

/** What the restaurant adds to the AI assistant's system prompt. */
export function restaurantPrompt(input: {
	verticalSettings: RestaurantSettings
	afterHoursMode: AfterHoursMode
	isOpen: boolean
	/** Online ordering can be paused while the store is open. */
	orderingOpen: boolean
}): VerticalPromptContributions {
	const { verticalSettings } = input
	return {
		paymentNote: 'Payment happens only through the order link.',
		status: ({ localTime, isOpen, nextOpen }) =>
			`It is ${localTime} at the restaurant. The store is ${isOpen ? 'open' : 'closed'} for orders right now.${
				!isOpen && nextOpen ? ` ${nextOpen}.` : ''
			}`,
		detailsHeading: 'Store details',
		tasks: [
			'Menu questions: answer using the menu tools only. Search before saying something is not available. Mention sizes and prices when relevant. Never guess ingredients or allergens; if the menu does not say, tell the caller you are not sure.',
			orderGuidance(verticalSettings.ordering),
			"Order link: you can't take payment by phone. Once the order is confirmed, ask permission to text a link to the number they're calling from, then call send_order_link. They review, pay, and choose pickup or delivery from that link.",
			'Store questions: answer using the store details, the common questions below, and get_business_info. Never make up hours, fees, policies, or delivery areas.',
			'Reservations: collect the party size, date, time, and a name, then save it with record_request. Make clear it is a request and the team will confirm it.',
		],
		businessQuestions: null,
		sections: [
			input.isOpen && !input.orderingOpen
				? "The store is open, but online ordering is paused right now: don't take orders or send order links."
				: '',
			verticalSettings.upsellsEnabled
				? 'Once per order, you may suggest one add-on from suggest_add_ons if it fits naturally. Accept "no" right away.'
				: '',
		].filter(Boolean),
		afterHours: afterHours(input.afterHoursMode),
		rulesTitle: RESTAURANT_RULES_TITLE,
		includeRule: (rule) => includeRestaurantRule(rule, verticalSettings),
	}
}
