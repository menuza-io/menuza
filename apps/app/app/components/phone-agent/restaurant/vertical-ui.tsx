import { msg } from '@lingui/macro'
import {
	includeRestaurantRule,
	restaurantSettingsOf,
} from '@repo/phone-agent-restaurant'
import { type PhoneAgentVerticalUi } from '../vertical-ui-types.ts'
import { OrderHandoffDetails } from './order-handoff-details.tsx'
import { PhoneOrderingSection } from './phone-ordering-section.tsx'

/** Restaurant copy and sections for the phone agent pages. */
export const restaurantVerticalUi: PhoneAgentVerticalUi = {
	purposeLabels: {
		reservation: msg`Reservation`,
		ordering: msg`Ordering`,
		menu_information: msg`Menu info`,
		business_information: msg`Store info`,
	},
	requestTypeLabels: {
		reservation: msg`Reservation`,
		catering: msg`Catering`,
	},
	ruleCategoryLabels: {
		menu_sizing: msg`Menu & sizing`,
		upsells_addons: msg`Upsells & add-ons`,
		order_flow: msg`Order flow`,
		delivery: msg`Delivery`,
		special_occasions: msg`Special occasions`,
	},
	ruleCategoryDescriptions: {
		menu_sizing: msg`Sizes, portions, and how to describe your dishes.`,
		upsells_addons: msg`What to suggest alongside an order, and when.`,
		order_flow: msg`The steps to follow while taking an order.`,
		delivery: msg`Delivery areas, fees, and pickup alternatives.`,
		special_occasions: msg`Birthdays, large groups, catering, and holidays.`,
	},
	faqCategoryLabels: {
		location: msg`Location`,
		menu: msg`Menu`,
		ordering: msg`Ordering`,
		reservations: msg`Reservations`,
	},
	scope: {
		label: msg`Location`,
		all: msg`All locations`,
		unknown: msg`Unknown location`,
		missing: msg`Add an active location to your restaurant first.`,
	},
	ruleExamples: [
		{
			category: 'menu_sizing',
			title: msg`Pizza sizes`,
			description: msg`Our pizzas come in 10, 14, and 18 inch. Always ask which size.`,
		},
		{
			category: 'upsells_addons',
			title: msg`Offer garlic knots`,
			description: msg`When someone orders a pizza, offer garlic knots once.`,
		},
		{
			category: 'escalation',
			title: msg`Catering goes to the manager`,
			description: msg`For orders over 20 people, take a message for the catering manager.`,
		},
		{
			category: 'delivery',
			title: msg`Delivery radius`,
			description: msg`We only deliver within 5 miles. Offer pickup otherwise.`,
		},
	],
	includeRule: (rule, verticalSettings) =>
		includeRestaurantRule(
			rule,
			restaurantSettingsOf({ vertical: verticalSettings }),
		),
	ruleCategoryNotice: (category, verticalSettings) =>
		category === 'upsells_addons' &&
		!restaurantSettingsOf({ vertical: verticalSettings }).upsellsEnabled
			? msg`Add-on suggestions are off in Advanced, so the agent skips these rules.`
			: null,
	phraseCopy: {
		calling_disabled: {
			hint: msg`Played before passing the call to your restaurant line while the assistant is paused.`,
		},
		text_link_sent: {
			label: msg`Ordering link sent`,
			hint: msg`Played after the ordering link is texted.`,
		},
		text_link_blocked: {
			hint: msg`Played when the ordering link can't be texted to the caller.`,
		},
	},
	SettingsSection: PhoneOrderingSection,
	handoffsTitle: msg`Order links`,
	HandoffDetails: OrderHandoffDetails,
}
