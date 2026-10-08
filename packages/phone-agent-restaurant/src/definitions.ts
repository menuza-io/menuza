import {
	type CallOutcome,
	type FaqBankQuestion,
	type NotificationEvent,
	type PhraseDefaultOverrides,
	type VerticalDefinition,
} from '@repo/phone-agent'

export const RESTAURANT_CALL_PURPOSES: readonly VerticalDefinition[] = [
	{ id: 'reservation', label: 'Reservation' },
	{ id: 'ordering', label: 'Ordering' },
	{ id: 'menu_information', label: 'Menu info' },
]

/** Lists the base `callback` and `complaint` too, to keep this sequence. */
export const RESTAURANT_CALL_REQUEST_TYPES: readonly VerticalDefinition[] = [
	{
		id: 'reservation',
		label: 'Reservation',
		summaryLabel: 'reservation request',
	},
	{ id: 'callback', label: 'Callback', summaryLabel: 'callback request' },
	{ id: 'catering', label: 'Catering', summaryLabel: 'catering request' },
	{ id: 'complaint', label: 'Complaint', summaryLabel: 'complaint' },
]

/** Labels double as the prompt headings for each category's rules. */
export const RESTAURANT_TRAINING_RULE_CATEGORIES: readonly VerticalDefinition[] =
	[
		{
			id: 'menu_sizing',
			label: 'Menu and sizing',
			description: 'Sizes, portions, and how to describe your dishes.',
		},
		{
			id: 'upsells_addons',
			label: 'Upsells and add-ons',
			description: 'What to suggest alongside an order, and when.',
		},
		{
			id: 'order_flow',
			label: 'Order flow',
			description: 'The steps to follow while taking an order.',
		},
		{
			id: 'escalation',
			label: 'Escalation',
			description: 'When to transfer a call or take a message for staff.',
		},
		{
			id: 'delivery',
			label: 'Delivery',
			description: 'Delivery areas, fees, and pickup alternatives.',
		},
		{
			id: 'special_occasions',
			label: 'Special occasions',
			description: 'Birthdays, large groups, catering, and holidays.',
		},
		{
			id: 'error_handling',
			label: 'Error handling',
			description: "What to do when the agent mishears or can't help.",
		},
	]

/** Base `general` is listed to keep it second; `policies` and `custom` follow. */
export const RESTAURANT_FAQ_CATEGORIES: readonly VerticalDefinition[] = [
	{ id: 'location', label: 'Location' },
	{ id: 'general', label: 'General' },
	{ id: 'menu', label: 'Menu' },
	{ id: 'ordering', label: 'Ordering' },
	{ id: 'reservations', label: 'Reservations' },
]

/**
 * Questions restaurants commonly get by phone. Owners answer the ones that
 * apply; unanswered questions are left out of the prompt. Every base FAQ id
 * is listed here, so this is the whole restaurant bank in sequence.
 */
export const RESTAURANT_FAQ_QUESTIONS: readonly FaqBankQuestion[] = [
	{
		id: 'cross_streets',
		category: 'location',
		question: 'What are your cross streets or nearby landmarks?',
	},
	{
		id: 'parking',
		category: 'location',
		question: 'Where is the closest parking?',
	},
	{
		id: 'transit',
		category: 'location',
		question: 'What public transportation is nearby?',
	},
	{ id: 'valet', category: 'location', question: 'Do you have valet parking?' },
	{
		id: 'high_chairs',
		category: 'general',
		question: 'Do you have high chairs or booster seats?',
	},
	{
		id: 'wheelchair',
		category: 'general',
		question: 'Are you wheelchair accessible?',
	},
	{ id: 'dogs', category: 'general', question: 'Can I bring my dog?' },
	{
		id: 'outdoor_seating',
		category: 'general',
		question: 'Do you have outdoor seating?',
	},
	{ id: 'wifi', category: 'general', question: 'Do you have Wi-Fi?' },
	{
		id: 'restrooms',
		category: 'general',
		question: 'Do you have public restrooms?',
	},
	{
		id: 'tvs',
		category: 'general',
		question: 'Do you show sports or have TVs?',
	},
	{
		id: 'live_music',
		category: 'general',
		question: 'Do you have live music or events?',
	},
	{
		id: 'dress_code',
		category: 'general',
		question: 'Do you have a dress code?',
	},
	{ id: 'hiring', category: 'general', question: 'Are you hiring?' },
	{
		id: 'happy_hour',
		category: 'general',
		question: 'Do you have a happy hour?',
	},
	{ id: 'catering', category: 'general', question: 'Do you offer catering?' },
	{
		id: 'recommendations',
		category: 'menu',
		question: 'What do you recommend? What are your most popular dishes?',
	},
	{ id: 'kids_menu', category: 'menu', question: "Do you have a kids' menu?" },
	{
		id: 'gluten_free',
		category: 'menu',
		question: 'Do you have gluten-free options?',
	},
	{ id: 'vegan', category: 'menu', question: 'Do you have vegan options?' },
	{
		id: 'vegetarian',
		category: 'menu',
		question: 'Do you have vegetarian options?',
	},
	{ id: 'halal', category: 'menu', question: 'Is your food halal?' },
	{
		id: 'nut_allergy',
		category: 'menu',
		question: 'How do you handle nut and other food allergies?',
	},
	{
		id: 'spice_level',
		category: 'menu',
		question: 'Can you make dishes more or less spicy?',
	},
	{
		id: 'alcohol',
		category: 'menu',
		question: 'Do you serve alcohol? Is there a full bar?',
	},
	{
		id: 'corkage',
		category: 'menu',
		question: 'Can I bring my own wine? Is there a corkage fee?',
	},
	{
		id: 'cake',
		category: 'menu',
		question: 'Can I bring a cake for a celebration?',
	},
	{
		id: 'kitchen_close',
		category: 'menu',
		question: 'When does the kitchen close?',
	},
	{
		id: 'pickup_wait',
		category: 'ordering',
		question: 'How long does a pickup order usually take?',
	},
	{
		id: 'delivery_apps',
		category: 'ordering',
		question: 'Are you on delivery apps like DoorDash or Uber Eats?',
	},
	{
		id: 'large_orders',
		category: 'ordering',
		question: 'How much notice do you need for a large order?',
	},
	{
		id: 'order_ahead',
		category: 'ordering',
		question: 'Can I order ahead for a later time?',
	},
	{
		id: 'reservations_accepted',
		category: 'reservations',
		question: 'Do you take reservations, or is it walk-in only?',
	},
	{
		id: 'reservation_advance',
		category: 'reservations',
		question: 'How far in advance can I book?',
	},
	{
		id: 'waitlist',
		category: 'reservations',
		question: 'Can I join a waitlist?',
	},
	{
		id: 'large_party',
		category: 'reservations',
		question: 'Can you host a large party or private event?',
	},
	{
		id: 'gift_cards',
		category: 'policies',
		question: 'Do you sell gift cards?',
	},
	{
		id: 'payment_methods',
		category: 'policies',
		question: 'What forms of payment do you accept?',
	},
	{
		id: 'gratuity',
		category: 'policies',
		question: 'Do you add an automatic gratuity or service charge?',
	},
	{
		id: 'split_checks',
		category: 'policies',
		question: 'Can we split the check?',
	},
	{
		id: 'refunds',
		category: 'policies',
		question: 'What is your policy if something is wrong with my order?',
	},
]

export const RESTAURANT_PHRASE_DEFAULTS: PhraseDefaultOverrides = {
	text_link_sent: {
		label: 'Ordering link sent',
		description: 'Played after the ordering link is texted.',
		defaults: {
			en: 'We just sent you a text with a link to order online.',
			es: 'Le acabamos de enviar un mensaje de texto con un enlace para ordenar en línea.',
			ar: 'أرسلنا لك للتو رسالة نصية تحتوي على رابط للطلب عبر الإنترنت.',
		},
	},
	text_link_blocked: {
		description:
			'Played when the ordering link cannot be texted to the caller, for example when their number is hidden or the text limit is reached.',
		defaults: {
			en: "Sorry, I can't text you the link right now. You can order on our website instead.",
			es: 'Lo siento, no puedo enviarle el enlace por mensaje de texto en este momento. Puede ordenar en nuestro sitio web.',
			ar: 'عذرًا، لا يمكنني إرسال الرابط إليك برسالة نصية الآن. يمكنك الطلب من موقعنا الإلكتروني بدلًا من ذلك.',
		},
	},
	calling_disabled: {
		description:
			'Played before passing the call to the restaurant when the assistant is paused.',
	},
}

export const RESTAURANT_NOTIFICATION_HEADLINES: Partial<
	Record<NotificationEvent, string>
> = { link_sent: 'Order link sent' }

export const RESTAURANT_OUTCOME_SUMMARIES: Partial<
	Record<CallOutcome, string>
> = { link_sent: 'Order link sent.' }
