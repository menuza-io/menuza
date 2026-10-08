import { describe, expect, it, vi } from 'vitest'
import {
	buildAgentInstructions,
	callPurposeIds,
	callRequestTypeIds,
	classifyCallPurpose,
	createVerticalContext,
	defaultFlowFor,
	defaultSettingsFor,
	faqCategoryIds,
	fillMessage,
	formatStaffNotification,
	linkMessageFor,
	messageVariablesFor,
	outcomeSummary,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentSettings,
	promptContextFor,
	type PurposeSignals,
	resolvePhrase,
	type SendLinkResult,
	trainingRuleCategoryIds,
	type TrainingRule,
	validateFlowGraph,
	verticalKeyterms,
	type VerticalToolContext,
	websitePathFor,
} from '@repo/phone-agent'
import {
	restaurantConfigParts,
	restaurantDataOf,
	type RestaurantVerticalData,
} from './data.ts'
import { type AgentLocation } from './location.ts'
import { type AgentMenu } from './menu.ts'
import { type RestaurantSettings } from './settings.ts'
import { createRestaurantCallState, type RestaurantCallState } from './tools.ts'
import { restaurantVertical } from './vertical.ts'

const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
]
const hours = (start: string, end: string) =>
	WEEKDAYS.map((day) => ({ day, isOpen: true, slots: [{ start, end }] }))

const location: AgentLocation = {
	id: 'loc_1',
	name: 'Downtown',
	phone: '+15551234567',
	timezone: 'America/New_York',
	taxRate: 0,
	address: { formattedAddress: '1 Main St' },
	storeHours: hours('09:00', '17:00'),
	onlineHours: hours('11:00', '16:00'),
	specialHours: [],
	prepTime: 20,
	fulfillmentOptions: {
		pickup: true,
		delivery: false,
		dineIn: false,
		curbside: false,
	},
	deliveryConfig: {
		estimatedDeliveryTimeMin: 30,
		estimatedDeliveryTimeMax: 45,
	},
	deliveryZones: [],
}

const item = (id: string, displayName: string, price: number) => ({
	id,
	displayName,
	description: null,
	price,
	variations: { groups: [], variants: [] },
	isGlutenFree: false,
	isVegetarian: true,
	allergens: [],
	isPopular: false,
	isUpsell: id === 'garlic_bread',
	availabilityStatus: 'available',
	modifierGroups: [],
})

const menus = [
	{
		id: 'main',
		displayName: 'Main',
		availabilityStatus: 'available',
		categories: [
			{
				id: 'pizza',
				displayName: 'Pizzas',
				description: null,
				upsellCategoryIds: [],
				availabilityStatus: 'available',
				items: [item('margherita', 'Margherita Pizza', 12)],
			},
			{
				id: 'sides',
				displayName: 'Sides',
				description: null,
				upsellCategoryIds: [],
				availabilityStatus: 'available',
				items: [item('garlic_bread', 'Garlic Bread', 5)],
			},
		],
	},
] as unknown as AgentMenu[]

// Wednesday 2025-01-15 in New York (UTC-5).
const at = (time: string) => new Date(`2025-01-15T${time}:00-05:00`)

function configAt(
	time: string,
	vertical: Partial<RestaurantSettings> = {},
	settings: Partial<PhoneAgentSettings> = {},
	rules: TrainingRule[] = [],
): PhoneAgentRuntimeConfig {
	const defaults = defaultSettingsFor(restaurantVertical)
	return {
		organization: {
			id: 'org',
			name: 'Luigi’s',
			slug: 'luigis',
			currency: 'USD',
		},
		...restaurantConfigParts({
			businessName: 'Luigi’s',
			location,
			menus,
			now: at(time),
		}),
		settings: {
			...defaults,
			...settings,
			vertical: { ...defaults.vertical, ...vertical },
		},
		flow: { versionId: null, graph: defaultFlowFor(restaurantVertical) },
		rules,
		fallbackPhone: null,
		callsUrl: null,
		agentLines: [],
	}
}

function contextAt(...args: Parameters<typeof configAt>) {
	return createVerticalContext(restaurantVertical, configAt(...args), {
		now: at(args[0]),
	})
}

function promptAt(...args: Parameters<typeof configAt>) {
	return buildAgentInstructions(
		promptContextFor(restaurantVertical, contextAt(...args)),
	)
}

function toolContext(
	time: string,
	overrides: Partial<
		VerticalToolContext<
			RestaurantVerticalData,
			RestaurantSettings,
			RestaurantCallState
		>
	> = {},
) {
	const sendLink = vi.fn(async (): Promise<SendLinkResult> => ({
		ok: true,
		url: 'https://luigis.example/menu',
		shownOnScreen: false,
	}))
	return {
		sendLink,
		context: {
			...contextAt(time),
			state: createRestaurantCallState(),
			channel: 'phone' as const,
			callerPhone: '+15550000000',
			services: { sendLink },
			...overrides,
		},
	}
}

function toolNamed(
	context: ReturnType<typeof contextAt>,
	name: string,
): NonNullable<
	ReturnType<NonNullable<typeof restaurantVertical.tools>>[number]
> {
	const found = restaurantVertical.tools!(context).find(
		(tool) => tool.name === name,
	)
	if (!found) throw new Error(`No ${name} tool`)
	return found
}

describe('restaurant definitions', () => {
	it('keeps the original ids and their sequence', () => {
		expect(callPurposeIds(restaurantVertical)).toEqual([
			'reservation',
			'ordering',
			'menu_information',
			'business_information',
			'other',
		])
		expect(callRequestTypeIds(restaurantVertical)).toEqual([
			'reservation',
			'callback',
			'catering',
			'complaint',
		])
		expect(trainingRuleCategoryIds(restaurantVertical)).toEqual([
			'menu_sizing',
			'upsells_addons',
			'order_flow',
			'escalation',
			'delivery',
			'special_occasions',
			'error_handling',
		])
		expect(faqCategoryIds(restaurantVertical)).toEqual([
			'location',
			'general',
			'menu',
			'ordering',
			'reservations',
			'policies',
			'custom',
		])
	})

	it('defaults upsells and order read-backs on', () => {
		expect(defaultSettingsFor(restaurantVertical).vertical).toEqual({
			upsellsEnabled: true,
			ordering: {
				excludedCategoryIds: [],
				readBackSummary: true,
				readBackTotal: true,
				quoteReadyTime: true,
			},
		})
	})
})

describe('restaurant config', () => {
	it('scopes the config to the location', () => {
		const config = configAt('12:00')
		expect(config.scopeId).toBe('loc_1')
		expect(config.business).toMatchObject({
			name: 'Luigi’s',
			phone: '+15551234567',
			address: '1 Main St',
		})
		expect(restaurantDataOf(config).orderingOpen).toBe(true)
		expect(() =>
			restaurantDataOf({ vertical: { id: 'general', data: {} } }),
		).toThrow(/restaurant config/)
	})
})

describe('restaurant prompt', () => {
	it('speaks about the store, the menu, and order links', () => {
		const prompt = promptAt('12:00')
		expect(prompt).toContain(
			'You are Assistant, the AI phone assistant for Luigi’s (Downtown).',
		)
		expect(prompt).toContain(
			'Never ask for card numbers, passwords, or payment details. Payment happens only through the order link.',
		)
		expect(prompt).toContain(
			'at the restaurant. The store is open for orders right now.',
		)
		expect(prompt).toContain('Store details:\nAddress: 1 Main St')
		expect(prompt).toContain('Typical pickup wait: about 20 minutes')
		expect(prompt).toContain('call send_order_link')
		expect(prompt).toContain(
			'Store questions: answer using the store details, the common questions below, and get_business_info.',
		)
		expect(prompt).not.toContain('Business questions:')
		expect(prompt).toContain('suggest_add_ons')
	})

	it('says when online ordering is paused while the store is open', () => {
		expect(promptAt('10:00')).toContain(
			'The store is open, but online ordering is paused right now',
		)
		expect(promptAt('12:00')).not.toContain('online ordering is paused')
	})

	it('uses the restaurant after-hours lines', () => {
		expect(promptAt('20:00', {}, { afterHoursMode: 'answer_only' })).toContain(
			"The store is closed: answer questions, but don't take orders.",
		)
		expect(promptAt('20:00', {}, { afterHoursMode: 'take_message' })).toContain(
			'offer to take a message.',
		)
		expect(
			promptAt('20:00', {}, { afterHoursMode: 'answer_and_link' }),
		).not.toContain('The store is closed:')
	})

	it('follows the read-back settings', () => {
		const ordering = {
			excludedCategoryIds: [],
			readBackSummary: false,
			readBackTotal: true,
			quoteReadyTime: false,
		}
		const prompt = promptAt('12:00', { ordering })
		expect(prompt).toContain('use get_order and say the subtotal.')
		expect(prompt).not.toContain('read back the whole order')
		expect(prompt).not.toContain('Mention the typical pickup wait')
	})

	it('titles the rules for the restaurant and drops upsell rules when upsells are off', () => {
		const rules: TrainingRule[] = [
			{
				id: 'drinks',
				category: 'upsells_addons',
				title: 'Drinks',
				description: 'Offer a drink.',
				priority: 'medium',
				isActive: true,
			},
			{
				id: 'sizes',
				category: 'menu_sizing',
				title: 'Sizes',
				description: 'A large feeds two.',
				priority: 'medium',
				isActive: true,
			},
		]
		const on = promptAt('12:00', {}, {}, rules)
		expect(on).toContain('Restaurant rules. Follow these;')
		expect(on.indexOf('Menu and sizing:')).toBeLessThan(
			on.indexOf('Upsells and add-ons:'),
		)
		const off = promptAt('12:00', { upsellsEnabled: false }, {}, rules)
		expect(off).not.toContain('Offer a drink.')
		expect(off).not.toContain('suggest_add_ons')
		expect(off).toContain('A large feeds two.')
	})
})

describe('restaurant tools', () => {
	it('offers suggest_add_ons only while upsells are on', () => {
		const names = (vertical: Partial<RestaurantSettings>) =>
			restaurantVertical.tools!(contextAt('12:00', vertical)).map(
				(tool) => tool.name,
			)
		expect(names({})).toEqual([
			'search_menu',
			'get_menu_item',
			'list_menu_categories',
			'get_order',
			'add_to_order',
			'update_order_line',
			'suggest_add_ons',
			'send_order_link',
		])
		expect(names({ upsellsEnabled: false })).not.toContain('suggest_add_ons')
	})

	it('builds the order and texts it as a link handoff', async () => {
		const { context, sendLink } = toolContext('12:00')
		const add = toolNamed(context, 'add_to_order')
		const added = add.execute({ item: 'margherita', quantity: 2 }, context)
		expect(added).toMatchObject({
			added: { text: '2 × Margherita Pizza', total: '$24.00' },
		})
		expect(context.state.cart).toHaveLength(1)

		const send = toolNamed(context, 'send_order_link')
		expect(send.rejectDuplicates).toBe(true)
		expect(send.blockedDuringTransfer).toBe(true)
		await expect(
			send.execute({ fulfillment: 'pickup' }, context),
		).resolves.toEqual({
			sent: true,
			note: 'Link texted. It expires in 24 hours.',
		})
		expect(sendLink).toHaveBeenCalledWith({
			path: '/menu?location=loc_1',
			payload: { cart: context.state.cart, fulfillmentMode: 'pickup' },
			phone: null,
		})
	})

	it('refuses orders while online ordering is paused', () => {
		const { context } = toolContext('10:00')
		const add = toolNamed(context, 'add_to_order')
		expect(add.execute({ item: 'margherita' }, context)).toEqual({
			error: "The store is closed and isn't taking orders right now.",
		})
	})

	it('turns link failures into what to tell the caller', async () => {
		const { context, sendLink } = toolContext('12:00')
		context.state.cart.push({
			id: 'line',
			itemId: 'margherita',
			name: 'Margherita Pizza',
			quantity: 1,
			unitPrice: 12,
			variantId: null,
			options: [],
			instructions: null,
		} as unknown as RestaurantCallState['cart'][number])
		sendLink.mockResolvedValueOnce({
			ok: false,
			reason: 'text_limit',
			explanation: 'We can only send two texts per call.',
		})
		const send = toolNamed(context, 'send_order_link')
		await expect(send.execute({}, context)).resolves.toEqual({
			error:
				'No more texts can be sent on this call. Tell the caller: "We can only send two texts per call." Suggest ordering on the website instead.',
		})
	})

	it('needs an order before sending the link', async () => {
		const { context, sendLink } = toolContext('12:00')
		const send = toolNamed(context, 'send_order_link')
		await expect(send.execute({}, context)).resolves.toEqual({
			error: 'The order is empty. Take the order first.',
		})
		expect(sendLink).not.toHaveBeenCalled()
	})
})

describe('restaurant call labels', () => {
	const signals = (
		overrides: Partial<PurposeSignals<RestaurantCallState>> = {},
	): PurposeSignals<RestaurantCallState> => ({
		declaredPurpose: null,
		requests: [],
		toolsUsed: new Set(),
		linkSent: false,
		menuChoices: [],
		state: createRestaurantCallState(),
		...overrides,
	})

	it('classifies calls the way the voice worker did', () => {
		expect(
			classifyCallPurpose(
				restaurantVertical,
				signals({ requests: ['reservation'], linkSent: true }),
			),
		).toBe('reservation')
		expect(
			classifyCallPurpose(restaurantVertical, signals({ linkSent: true })),
		).toBe('ordering')
		expect(
			classifyCallPurpose(
				restaurantVertical,
				signals({ toolsUsed: new Set(['search_menu', 'get_business_info']) }),
			),
		).toBe('menu_information')
		expect(
			classifyCallPurpose(
				restaurantVertical,
				signals({ toolsUsed: new Set(['get_business_info']) }),
			),
		).toBe('business_information')
		expect(
			classifyCallPurpose(
				restaurantVertical,
				signals({ menuChoices: ['Book a table'] }),
			),
		).toBe('reservation')
		expect(
			classifyCallPurpose(
				restaurantVertical,
				signals({ menuChoices: ['Hours and location'] }),
			),
		).toBe('business_information')
		expect(classifyCallPurpose(restaurantVertical, signals())).toBe('other')
	})

	it('summarizes the order and names link events for the restaurant', () => {
		const state = createRestaurantCallState()
		state.cart.push({
			quantity: 2,
			unitPrice: 6,
			options: [],
		} as unknown as RestaurantCallState['cart'][number])
		expect(
			restaurantVertical.summarizeCall!({
				state,
				formatPrice: (value) => `$${value.toFixed(2)}`,
			}),
		).toEqual(['Order: 2 items, $12.00 before tax.'])
		expect(
			outcomeSummary('link_sent', restaurantVertical.outcomeSummaries),
		).toBe('Order link sent.')
		expect(
			formatStaffNotification({
				businessName: 'Luigi’s',
				events: ['link_sent'],
				callerPhone: null,
				summary: null,
				tags: [],
				callUrl: null,
				headlines: restaurantVertical.notificationHeadlines,
			}),
		).toBe('Luigi’s: Order link sent\nCaller ID hidden')
	})
})

describe('restaurant phone menu and messages', () => {
	it('starts organizations on a valid ordering menu', () => {
		const flow = defaultFlowFor(restaurantVertical)
		expect(validateFlowGraph(flow)).toEqual([])
		expect(JSON.stringify(flow)).toContain('online ordering link')
	})

	it('fills business, location, and the older restaurant placeholder', () => {
		const variables = messageVariablesFor(
			restaurantVertical,
			contextAt('12:00'),
		)
		expect(fillMessage('{business} {location} {restaurant}', variables)).toBe(
			'Luigi’s Downtown Luigi’s',
		)
	})

	it('words texts and spoken lines for ordering', () => {
		expect(websitePathFor(restaurantVertical, 'loc_1')).toBe(
			'/menu?location=loc_1',
		)
		expect(
			linkMessageFor(restaurantVertical, 'website', {
				business: 'Luigi’s',
				url: 'https://x.test',
			}),
		).toBe('Luigi’s: order online here: https://x.test')
		expect(
			resolvePhrase(
				'text_link_sent',
				'en',
				[],
				restaurantVertical.phraseDefaults,
			),
		).toBe('We just sent you a text with a link to order online.')
	})

	it('adds menu item names to the speech terms', () => {
		expect(verticalKeyterms(restaurantVertical, contextAt('12:00'))).toEqual([
			'Margherita Pizza',
			'Garlic Bread',
		])
	})
})
