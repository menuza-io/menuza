import {
	type PhoneAgentSettings,
	type PhoneAgentVertical,
	resolvePhrase,
} from '@repo/phone-agent'
import {
	type AgentMenu,
	type AgentMenuCategory,
	type AgentMenuItem,
	createRestaurantCallState,
	DEFAULT_ORDERING,
	type RestaurantCallState,
	restaurantDataOf,
	restaurantVertical,
} from '@repo/phone-agent-restaurant'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareCall } from './call-start.ts'
import {
	buildSummary,
	CallState,
	classifyPurpose,
	MAX_TEXTS_PER_CALL,
	resolveOutcome,
} from './call-state.ts'
import { priceFormatter } from './job-metadata.ts'
import { type TextLinkResult } from './services.ts'
import { restaurantTestConfig } from './test-fixtures.restaurant.ts'
import { setupController, setupTools, testConfig } from './test-fixtures.ts'
import { phoneAgentVertical } from './vertical.ts'

const vertical = restaurantVertical as PhoneAgentVertical
const formatPrice = priceFormatter('USD')
const summaryOptions = { vertical, formatPrice }

function item(id: string, displayName: string): AgentMenuItem {
	return {
		id,
		displayName,
		description: null,
		price: 10,
		variations: { groups: [], variants: [] },
		isGlutenFree: false,
		isVegetarian: false,
		allergens: [],
		isPopular: false,
		isUpsell: false,
		availabilityStatus: 'available',
		modifierGroups: [],
	}
}

function category(
	id: string,
	items: AgentMenuItem[],
	subcategories: AgentMenuCategory[] = [],
): AgentMenuCategory {
	return {
		id,
		displayName: id,
		description: null,
		upsellCategoryIds: [],
		availabilityStatus: 'available',
		items,
		subcategories,
	}
}

const MENUS: AgentMenu[] = [
	{
		id: 'menu_1',
		displayName: 'Menu',
		availabilityStatus: 'available',
		categories: [
			category('pizza', [
				item('p1', 'Pepperoni Pizza'),
				item('p2', 'Pepperoni Calzone'),
			]),
			category(
				'catering',
				[item('c1', 'Party Tray')],
				[category('catering_sides', [item('c2', 'Side Platter')])],
			),
		],
	},
]

function restaurantTools({
	settings = {},
	...options
}: {
	settings?: Partial<PhoneAgentSettings>
	handoff?: TextLinkResult
	channel?: 'phone' | 'web_test'
} = {}) {
	const setup = setupTools({
		...options,
		vertical,
		config: restaurantTestConfig(settings, { menus: MENUS }),
	})
	const cart = () => (setup.state.vertical as RestaurantCallState).cart
	return { ...setup, cart }
}

/** A call state as the restaurant tools leave it. */
function restaurantState(now?: number) {
	const state = new CallState(now)
	state.vertical = createRestaurantCallState()
	return state
}

const cartOf = (state: CallState) =>
	(state.vertical as RestaurantCallState).cart

function line(quantity = 1, unitPrice = 10) {
	return {
		id: `line_${Math.random()}`,
		itemId: 'item_1',
		name: 'Margherita',
		basePrice: unitPrice,
		unitPrice,
		quantity,
		options: [],
		instructions: '',
	}
}

it('runs the restaurant vertical in this deployment', () => {
	expect(phoneAgentVertical.id).toBe(restaurantVertical.id)
})

describe('restaurant tools', () => {
	it('adds the restaurant tools to the core tools, with their names', () => {
		const { tools } = restaurantTools()
		expect(Object.keys(tools).sort()).toEqual(
			[
				'end_call',
				'get_business_info',
				'record_request',
				'set_call_purpose',
				'tag_call',
				'add_to_order',
				'get_menu_item',
				'get_order',
				'list_menu_categories',
				'search_menu',
				'send_order_link',
				'suggest_add_ons',
				'update_order_line',
			].sort(),
		)
	})

	it('asks which item when a name fits several', async () => {
		const { run, state } = restaurantTools()
		await expect(run('get_menu_item', { item: 'pepperoni' })).resolves.toEqual({
			candidates: [
				{ id: 'p1', name: 'Pepperoni Pizza' },
				{ id: 'p2', name: 'Pepperoni Calzone' },
			],
			note: 'Ask which one they mean.',
		})
		expect(state.toolsUsed.has('get_menu_item')).toBe(true)
	})

	it('refuses items from categories that are not taken by phone', async () => {
		const { run, cart } = restaurantTools({
			settings: {
				vertical: {
					ordering: { ...DEFAULT_ORDERING, excludedCategoryIds: ['catering'] },
				},
			},
		})
		await expect(run('add_to_order', { item: 'c2' })).resolves.toMatchObject({
			error: expect.stringContaining("can't be ordered by phone"),
		})
		await expect(run('add_to_order', { item: 'p1' })).resolves.toMatchObject({
			added: expect.anything(),
		})
		expect(cart().map((entry) => entry.itemId)).toEqual(['p1'])
	})

	it('returns plain JSON, not the live cart', async () => {
		const { run, cart } = restaurantTools()
		const result = (await run('add_to_order', { item: 'p1' })) as {
			order: { lines: unknown[] }
		}
		cart().length = 0
		expect(result.order.lines).toHaveLength(1)
	})

	it("answers get_business_info with the restaurant's details", async () => {
		const { run, state } = restaurantTools()
		await expect(run('get_business_info')).resolves.toMatchObject({
			openNow: true,
			details: expect.stringContaining('Typical pickup wait'),
		})
		expect(state.toolsUsed.has('get_business_info')).toBe(true)
	})

	it('accepts the restaurant request types and purposes', async () => {
		const { run, state, services } = restaurantTools()
		await expect(
			run('record_request', {
				type: 'reservation',
				details: [{ field: 'party_size', value: '4' }],
			}),
		).resolves.toMatchObject({ saved: true })
		expect(services.createRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'reservation',
				details: { party_size: '4' },
			}),
		)
		expect(state.requests).toEqual(['reservation'])
		await run('set_call_purpose', { purpose: 'ordering' })
		expect(state.declaredPurpose).toBe('ordering')
	})

	it('speaks the restaurant name in fixed lines', async () => {
		const { run, controller } = restaurantTools({
			settings: { languages: ['en', 'ar'] },
		})
		await run('switch_language', { language: 'ar' })
		expect(controller.phrase('hold')).toBe(
			resolvePhrase('hold', 'ar', [], vertical.phraseDefaults).replace(
				'{business}',
				'Luigi',
			),
		)
	})
})

describe('send_order_link', () => {
	function withCart(options: Parameters<typeof restaurantTools>[0] = {}) {
		const setup = restaurantTools(options)
		setup.cart().push({
			id: 'line_1',
			itemId: 'p1',
			name: 'Pepperoni Pizza',
			basePrice: 10,
			unitPrice: 10,
			quantity: 1,
			options: [],
			instructions: '',
		})
		const sendLink = (input: Record<string, unknown> = {}) =>
			setup.run('send_order_link', input)
		return { ...setup, sendLink }
	}

	it('texts the caller the cart through the link handoff and counts the text', async () => {
		const { state, services, sendLink } = withCart()
		await expect(sendLink({ fulfillment: 'pickup' })).resolves.toMatchObject({
			sent: true,
		})
		expect(services.createHandoff).toHaveBeenCalledWith({
			orgId: 'org_1',
			callId: 'call_1',
			scopeId: 'loc_1',
			path: '/menu?location=loc_1',
			payload: {
				cart: [expect.objectContaining({ itemId: 'p1' })],
				fulfillmentMode: 'pickup',
			},
			message: expect.stringContaining('{url}'),
			sendTo: '+15552223333',
		})
		const [body] = services.createHandoff.mock.calls[0] as unknown as [
			{ message: string },
		]
		expect(body.message).toMatch(/^Luigi: /)
		expect(body.message.length).toBeLessThanOrEqual(320)
		expect(state.textsSent).toBe(1)
		expect(state.link).toEqual({ url: 'https://x.test/o', smsSent: true })
		expect(state.toolsUsed.has('send_order_link')).toBe(true)
	})

	it('refuses numbers outside the US before calling tenant-api', async () => {
		const { services, sendLink } = withCart()
		const result = await sendLink({ phone: '+44 7700 900123' })
		expect(result).toMatchObject({
			error: expect.stringContaining('another US mobile number'),
		})
		expect(services.createHandoff).not.toHaveBeenCalled()
	})

	it('stops after the per-call text limit', async () => {
		const { state, services, sendLink } = withCart()
		state.textsSent = MAX_TEXTS_PER_CALL
		const result = await sendLink()
		expect(result).toMatchObject({
			error: expect.stringContaining('as many texts as I can'),
		})
		expect(services.createHandoff).not.toHaveBeenCalled()
	})

	it('explains why tenant-api did not send the text', async () => {
		const { state, sendLink } = withCart({
			handoff: { url: 'u', smsSent: false, smsBlockedReason: 'daily_limit' },
		})
		const result = await sendLink({ phone: '(555) 234-5678' })
		expect(result).toMatchObject({
			error: expect.stringContaining("today's limit"),
		})
		expect(state.textsSent).toBe(0)
	})

	it('shows the link on screen on test calls', async () => {
		const { publishToRoom, sendLink } = withCart({
			channel: 'web_test',
			handoff: { url: 'https://x.test/o', smsSent: false },
		})
		await expect(sendLink()).resolves.toMatchObject({
			sent: true,
			note: expect.stringContaining('shown on screen'),
		})
		expect(publishToRoom).toHaveBeenCalledWith({
			type: 'link',
			url: 'https://x.test/o',
		})
	})

	it('tells the model a text failed when tenant-api is down', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const { services, sendLink } = withCart()
		services.createHandoff.mockRejectedValueOnce(new Error('down'))
		await expect(sendLink()).resolves.toMatchObject({
			error: expect.stringContaining("The text didn't go through."),
		})
		vi.restoreAllMocks()
	})

	it('waits while a transfer is in progress', async () => {
		const { controller, services, sendLink } = withCart()
		vi.spyOn(controller, 'transferInProgress', 'get').mockReturnValue(true)
		await expect(sendLink()).resolves.toMatchObject({
			error: expect.stringContaining('transfer to the team is in progress'),
		})
		expect(services.createHandoff).not.toHaveBeenCalled()
		vi.restoreAllMocks()
	})
})

describe('restaurant calls', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("texts the location's menu link from a text link step", async () => {
		const { controller, session, services, state } = setupController({
			vertical,
			config: restaurantTestConfig,
			configure: (config) => {
				config.flow.graph = {
					nodes: [
						{
							id: 'start',
							type: 'start',
							position: { x: 0, y: 0 },
							data: { label: 'start' },
						},
						{
							id: 'link',
							type: 'text_link',
							position: { x: 0, y: 0 },
							data: { label: 'link' },
						},
						{
							id: 'bye',
							type: 'hang_up',
							position: { x: 0, y: 0 },
							data: { label: 'bye', message: 'Bye.' },
						},
					],
					edges: [
						{ id: 'e1', source: 'start', target: 'link', sourceHandle: null },
						{ id: 'e2', source: 'link', target: 'bye', sourceHandle: null },
					],
				}
			},
		})
		controller.begin()
		await vi.advanceTimersByTimeAsync(0)
		expect(session.said[0]).toBe(
			"You've reached Luigi's automated phone assistant. This call may be recorded.",
		)
		expect(services.sendWebsiteLink).toHaveBeenCalledWith({
			orgId: 'org_1',
			callId: 'call_1',
			scopeId: 'loc_1',
			path: '/menu?location=loc_1',
			message: 'Luigi: order online here: {url}',
			sendTo: '+15552223333',
		})
		expect(session.said.at(-1)).toBe('Bye.')
		expect(state.textsSent).toBe(1)
	})
})

describe('prepareCall for restaurants', () => {
	const NINE_TO_FIVE = [
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({
		day: day as 'monday',
		isOpen: true,
		slots: [{ start: '09:00', end: '17:00' }],
	}))

	function prepare(
		config: ReturnType<typeof restaurantTestConfig>,
		{
			now,
			startCall = vi.fn(async () => ({ callId: 'call_1' })),
		}: { now?: Date; startCall?: () => Promise<{ callId: string }> } = {},
	) {
		return prepareCall({
			lookup: { kind: 'number', calledNumber: '+15550001111' },
			loadConfig: async () => ({ kind: 'config', config, stale: true }),
			startCall,
			channel: 'phone',
			roomName: 'room_1',
			callerPhone: '+15552223333',
			vertical,
			now: now ? () => now : undefined,
		})
	}

	it('recomputes store hours at call time instead of trusting a cached snapshot', async () => {
		const config = restaurantTestConfig()
		restaurantDataOf(config).location.storeHours = NINE_TO_FIVE
		const plan = await prepare(config, {
			// 22:00 in New York, long after closing; the snapshot says open.
			now: new Date('2025-01-15T22:00:00-05:00'),
		})
		expect(plan).toMatchObject({
			kind: 'agent',
			config: {
				availability: { isOpen: false },
				vertical: { data: { orderingOpen: true } },
			},
		})
	})

	it('opens the call log with the location id', async () => {
		const startCall = vi.fn(async () => ({ callId: 'call_1' }))
		await prepare(restaurantTestConfig(), { startCall })
		expect(startCall).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId: 'loc_1' }),
		)
	})

	it('hands the caller to the business when the config is for the general vertical', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const startCall = vi.fn(async () => ({ callId: 'call_1' }))
		const plan = await prepareCall({
			lookup: { kind: 'number', calledNumber: '+15550001111' },
			loadConfig: async () => ({
				kind: 'config',
				config: testConfig(),
				stale: false,
			}),
			startCall,
			channel: 'phone',
			roomName: 'room_1',
			callerPhone: '+15552223333',
			vertical,
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'config_unavailable',
		})
		expect(startCall).not.toHaveBeenCalled()
		vi.restoreAllMocks()
	})
})

describe('restaurant call labels', () => {
	it('prefers the purpose the model declared', () => {
		const state = restaurantState()
		cartOf(state).push(line())
		state.declaredPurpose = 'menu_information'
		expect(classifyPurpose(state, vertical)).toBe('menu_information')
	})

	it('infers ordering over menu questions', () => {
		const state = restaurantState()
		state.toolsUsed.add('search_menu')
		cartOf(state).push(line())
		expect(classifyPurpose(state, vertical)).toBe('ordering')
	})

	it('counts a texted link as ordering', () => {
		const state = restaurantState()
		state.link = { url: 'https://x.test/menu', smsSent: true }
		expect(classifyPurpose(state, vertical)).toBe('ordering')
	})

	it('falls back to the phone menu choices', () => {
		const reservation = new CallState()
		reservation.menuChoices.push('Speak with our team', 'Book a table')
		expect(classifyPurpose(reservation, vertical)).toBe('reservation')

		const hours = new CallState()
		hours.menuChoices.push('Hear our hours')
		expect(classifyPurpose(hours, vertical)).toBe('business_information')

		const staff = new CallState()
		staff.menuChoices.push('Speak with our team')
		expect(classifyPurpose(staff, vertical)).toBe('other')
	})

	it('infers reservations from recorded requests', () => {
		const reservation = new CallState()
		reservation.requests.push('reservation')
		expect(classifyPurpose(reservation, vertical)).toBe('reservation')
	})

	it('summarizes an order link with the restaurant wording', () => {
		const state = restaurantState()
		state.addTurn('caller', 'Two pizzas please')
		cartOf(state).push(line(2, 12.5))
		state.link = { url: 'https://x.test/menu#order=t', smsSent: true }
		expect(resolveOutcome(state)).toBe('link_sent')
		expect(buildSummary(state, summaryOptions)).toBe(
			'Order link sent. Order: 2 items, $25.00 before tax.',
		)
	})

	it('labels the restaurant request types', () => {
		const state = new CallState()
		state.requests.push('reservation', 'catering')
		expect(buildSummary(state, summaryOptions)).toBe(
			'Request recorded for staff follow-up. Logged: reservation request, catering request.',
		)
	})
})
