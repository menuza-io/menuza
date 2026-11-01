import {
	fetchPublishedDrops,
	fetchPublishedMenu,
	presentDrops,
	presentMenu,
} from './catalog'
import { StubTransport } from '@/test/stub-transport'
import { makeConfiguration } from '@/test/support'

const menuPayload = {
	organization: { currency: 'USD' },
	menus: [
		{
			id: 'menu_1',
			displayName: 'Lunch',
			categories: [
				{
					id: 'cat_1',
					displayName: '{"en":"Burgers","ar":"برجر"}',
					items: [
						{
							id: 'item_1',
							displayName: 'Burger',
							description: 'With cheese',
							price: 10,
							availabilityStatus: 'available',
						},
						{
							id: 'item_2',
							displayName: 'Sold out soda',
							price: 2,
							availabilityStatus: 'unavailable',
						},
					],
					subcategories: [
						{
							id: 'cat_2',
							displayName: 'Sides',
							items: [
								{
									id: 'item_3',
									displayName: 'Fries',
									price: 4,
									availabilityStatus: 'available',
									variations: {
										variants: [
											{ availabilityStatus: 'unavailable' },
											{ availabilityStatus: 'unavailable' },
										],
									},
								},
							],
						},
					],
				},
				{
					id: 'cat_hidden',
					displayName: 'Hidden',
					availabilityStatus: 'unavailable',
					items: [
						{
							id: 'item_hidden',
							displayName: 'Secret',
							price: 1,
						},
					],
				},
			],
		},
	],
	promotions: [
		{
			id: 'disc_1',
			name: 'Lunch deal',
			valueType: 'percent',
			percentBp: 1000,
			scope: 'items',
			itemIds: ['item_1'],
			categoryIds: [],
		},
	],
}

describe('presentMenu', () => {
	it('keeps visible items, localized names, and sold-out rows', () => {
		const menu = presentMenu(menuPayload, 'ar', 'en')
		expect(menu.currency).toBe('USD')
		expect(menu.sections.map((section) => section.name)).toEqual([
			'برجر',
			'Sides',
		])
		expect(menu.sections[0]?.items).toEqual([
			{
				id: 'item_1',
				name: 'Burger',
				description: 'With cheese',
				price: 10,
				soldOut: false,
				categoryIds: ['cat_1'],
				excludeFromDiscounts: false,
			},
			{
				id: 'item_2',
				name: 'Sold out soda',
				description: null,
				price: 2,
				soldOut: true,
				categoryIds: ['cat_1'],
				excludeFromDiscounts: false,
			},
		])
		expect(menu.sections[1]?.items[0]?.soldOut).toBe(true)
		expect(menu.sections[1]?.items[0]?.categoryIds).toEqual(['cat_1', 'cat_2'])
		expect(menu.promotions[0]?.itemIds).toEqual(['item_1'])
	})
})

describe('presentMenu promotions', () => {
	const base = {
		name: 'Offer',
		scope: 'order',
		itemIds: [],
		categoryIds: [],
	}

	it('defaults the display fields for an older payload', () => {
		const menu = presentMenu(
			{
				promotions: [
					{ ...base, id: 'a', valueType: 'percent', percentBp: 1000 },
				],
			},
			'en',
			'en',
		)
		expect(menu.promotions[0]).toMatchObject({
			showName: false,
			itemBadges: true,
			locationIds: null,
			fulfillments: null,
			startsAt: null,
			endsAt: null,
			code: null,
		})
	})

	it('keeps a set price and the fields the website filters by', () => {
		const menu = presentMenu(
			{
				promotions: [
					{
						...base,
						id: 'a',
						valueType: 'fixed_price',
						amountMinor: 999,
						currency: 'USD',
						showName: true,
						itemBadges: false,
						locationIds: ['loc_1'],
						fulfillments: ['pickup', 'curbside'],
						startsAt: '2026-11-01T09:00',
						endsAt: '2026-11-02T09:00',
						code: ' LUNCH ',
					},
				],
			},
			'en',
			'en',
		)
		expect(menu.promotions).toEqual([
			expect.objectContaining({
				valueType: 'fixed_price',
				amountMinor: 999,
				showName: true,
				itemBadges: false,
				locationIds: ['loc_1'],
				fulfillments: ['pickup'],
				startsAt: '2026-11-01T09:00',
				endsAt: '2026-11-02T09:00',
				code: 'LUNCH',
			}),
		])
	})

	it('stays tolerant of a malformed display field and an unknown value type', () => {
		const menu = presentMenu(
			{
				promotions: [
					{
						...base,
						id: 'a',
						valueType: 'percent',
						percentBp: 500,
						showName: 'yes',
						locationIds: 'x',
					},
					{ ...base, id: 'b', valueType: 'something_new' },
				],
			},
			'en',
			'en',
		)
		expect(menu.promotions.map((promotion) => promotion.id)).toEqual(['a'])
		expect(menu.promotions[0]).toMatchObject({
			showName: false,
			locationIds: null,
		})
	})

	it('takes the offer scope from the default location', () => {
		const menu = presentMenu(
			{
				locations: [
					{ id: 'loc_1', timezone: 'UTC' },
					{
						id: 'loc_2',
						isDefault: true,
						timezone: 'Asia/Riyadh',
						fulfillmentOptions: { pickup: true, delivery: false },
					},
				],
			},
			'en',
			'en',
		)
		expect(menu.offerScope).toEqual({
			locationId: 'loc_2',
			timeZone: 'Asia/Riyadh',
			modes: ['pickup'],
		})
		expect(presentMenu({}, 'en', 'en').offerScope.locationId).toBeNull()
	})
})

describe('presentDrops', () => {
	it('keeps public listing fields and https covers only', () => {
		const drops = presentDrops({
			drops: [
				{
					title: 'Friday lunch',
					slug: 'friday-lunch',
					description: null,
					coverImageUrl: 'https://cdn.example/cover.jpg',
					status: 'live',
					ordersOpenAt: null,
					ordersCloseAt: null,
					pickupDates: ['2026-11-06'],
					pickupLocationNames: ['Main'],
					pickupTimezone: 'Asia/Riyadh',
				},
				{
					title: 'No cover',
					slug: 'no-cover',
					status: 'scheduled',
					coverImageUrl: '/resources/images?objectKey=x',
				},
			],
		})
		expect(drops[0]?.coverImageUrl).toBe('https://cdn.example/cover.jpg')
		expect(drops[1]?.coverImageUrl).toBeNull()
		expect(drops[1]?.pickupDates).toEqual([])
	})
})

describe('catalog fetches', () => {
	it('loads the menu and drops for the bound site', async () => {
		const transport = new StubTransport((request) => {
			const path = new URL(request.url).pathname
			if (path === '/resources/sites/menu') return { json: menuPayload }
			if (path === '/resources/sites/drops') return { json: { drops: [] } }
			return { status: 404, raw: 'no' }
		})
		const configuration = makeConfiguration()
		const menu = await fetchPublishedMenu(configuration, transport.send)
		const drops = await fetchPublishedDrops(configuration, transport.send)
		expect(presentMenu(menu, 'en', 'en').sections).toHaveLength(2)
		expect(presentDrops(drops)).toEqual([])
		expect(transport.paths).toEqual([
			'/resources/sites/menu',
			'/resources/sites/drops',
		])
		expect(transport.recorded[0]?.url.searchParams.get('slug')).toBe('acme')
	})
})
