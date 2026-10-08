import { describe, expect, it, vi } from 'vitest'
import {
	fetchVoiceOrderHandoff,
	getHandoffToken,
	hasHandoffParam,
	normalizeFulfillmentMode,
	normalizeHandoffCart,
	repriceHandoffCart,
	stripHandoffParam,
	type HandoffCartItem,
} from './voice-order-handoff'

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'

describe('getHandoffToken', () => {
	it('reads the token from the fragment', () => {
		expect(
			getHandoffToken(`https://x.test/menu?location=loc1#handoff=${TOKEN}`),
		).toBe(TOKEN)
		expect(hasHandoffParam(`https://x.test/menu#handoff=short`)).toBe(true)
		expect(hasHandoffParam(`https://x.test/menu#top`)).toBe(false)
	})

	it('still accepts the order param used by older links', () => {
		expect(
			getHandoffToken(`https://x.test/menu?location=loc1#order=${TOKEN}`),
		).toBe(TOKEN)
	})

	it('still accepts the query string used by older links', () => {
		expect(
			getHandoffToken(`https://x.test/menu?order=${TOKEN}&location=loc1`),
		).toBe(TOKEN)
	})

	it('rejects missing or malformed tokens', () => {
		expect(getHandoffToken('https://x.test/menu')).toBeNull()
		expect(getHandoffToken('https://x.test/menu?order=short')).toBeNull()
		expect(
			getHandoffToken('https://x.test/menu?order=bad%20token%20value%20here!!'),
		).toBeNull()
	})
})

describe('stripHandoffParam', () => {
	it('removes only the order param and keeps the rest', () => {
		expect(
			stripHandoffParam(
				`https://x.test/ar/menu?order=${TOKEN}&location=loc1#top`,
			),
		).toBe('/ar/menu?location=loc1#top')
	})

	it('drops the query string when order was the only param', () => {
		expect(stripHandoffParam(`https://x.test/menu?order=${TOKEN}`)).toBe(
			'/menu',
		)
	})

	it('removes the token from the fragment and keeps other fragments', () => {
		expect(
			stripHandoffParam(`https://x.test/menu?location=loc1#handoff=${TOKEN}`),
		).toBe('/menu?location=loc1')
		expect(stripHandoffParam(`https://x.test/menu#handoff=${TOKEN}&a=1`)).toBe(
			'/menu#a=1',
		)
		expect(stripHandoffParam(`https://x.test/menu#order=${TOKEN}&a=1`)).toBe(
			'/menu#a=1',
		)
		expect(stripHandoffParam('https://x.test/menu#top')).toBe('/menu#top')
	})
})

describe('repriceHandoffCart', () => {
	const pizza = {
		id: 'pizza',
		displayName: 'Pepperoni Pizza',
		price: 10,
		variations: {
			groups: [
				{
					id: 'size',
					name: 'Size',
					values: [
						{ id: 'sm', name: 'Small' },
						{ id: 'lg', name: 'Large' },
					],
				},
			],
			variants: [
				{ id: 'v-sm', valueIds: ['sm'], price: 10 },
				{
					id: 'v-lg',
					valueIds: ['lg'],
					price: 15,
					availabilityStatus: 'available',
				},
			],
		},
		modifierGroups: [
			{
				id: 'crust',
				name: 'Crust',
				selectionType: 'single',
				minSelections: 1,
				maxSelections: 1,
				options: [
					{ id: 'thin', displayName: 'Thin', price: 0 },
					{
						id: 'stuffed',
						displayName: 'Stuffed',
						price: 3,
						nestedModifierGroups: [
							{
								id: 'cheese',
								name: 'Cheese',
								selectionType: 'single',
								minSelections: 1,
								options: [{ id: 'mozz', displayName: 'Mozzarella', price: 1 }],
							},
						],
					},
				],
			},
			{
				id: 'tops',
				name: 'Toppings',
				selectionType: 'pizza',
				minSelections: 0,
				options: [
					{ id: 'olives', displayName: 'Olives', price: 2 },
					{
						id: 'ham',
						displayName: 'Ham',
						price: 2,
						availabilityStatus: 'unavailable',
					},
				],
			},
		],
	}
	const soda = {
		id: 'soda',
		displayName: 'Soda',
		price: 2.5,
		availabilityStatus: 'available',
	}
	const menus = [
		{ categories: [{ items: [soda], subcategories: [{ items: [pizza] }] }] },
	]

	function line(overrides: Partial<HandoffCartItem>): HandoffCartItem {
		return {
			id: 'line',
			itemId: 'soda',
			name: 'Soda',
			basePrice: 2.5,
			unitPrice: 2.5,
			quantity: 1,
			options: [],
			instructions: '',
			...overrides,
		}
	}

	const option = (
		groupId: string,
		optionId: string,
		priceDelta = 0,
		half?: 'whole' | 'left' | 'right',
	) => ({
		groupId,
		groupName: '',
		optionId,
		optionName: '',
		priceDelta,
		...(half ? { half } : {}),
	})

	it('uses current menu prices and names, including nested options', () => {
		const result = repriceHandoffCart(
			[
				line({
					id: 'p',
					itemId: 'pizza',
					variantId: 'v-lg',
					name: 'Old name',
					basePrice: 1,
					unitPrice: 1,
					quantity: 2,
					options: [
						option('size', 'lg'),
						option('crust', 'stuffed', 0.5),
						option('cheese', 'mozz'),
						option('tops', 'olives', 0, 'left'),
					],
				}),
			],
			menus,
		)
		expect(result.removed).toEqual([])
		expect(result.pricesChanged).toBe(true)
		expect(result.cart).toHaveLength(1)
		const [repriced] = result.cart
		expect(repriced).toMatchObject({
			name: 'Pepperoni Pizza',
			basePrice: 15,
			unitPrice: 15 + 3 + 1 + 1,
			quantity: 2,
			variantId: 'v-lg',
		})
		expect(repriced!.options.map((o) => o.optionName)).toEqual([
			'Large',
			'Stuffed',
			'Mozzarella',
			'Olives',
		])
		// Checkout drops variation echoes; the order API prices them from variantId.
		expect(repriced!.options.map((o) => o.variation === true)).toEqual([
			true,
			false,
			false,
			false,
		])
	})

	it('reports no price change when the handoff matches the menu', () => {
		const result = repriceHandoffCart([line({})], menus)
		expect(result).toEqual({
			cart: [line({})],
			removed: [],
			pricesChanged: false,
		})
	})

	it('drops lines that can no longer be ordered as described', () => {
		const base = {
			itemId: 'pizza',
			variantId: 'v-sm',
			name: 'Pizza',
		}
		const result = repriceHandoffCart(
			[
				line({ id: 'gone', itemId: 'missing', name: 'Calzone' }),
				line({ ...base, id: 'no-crust', name: 'No crust', options: [] }),
				line({
					...base,
					id: 'no-cheese',
					name: 'Missing nested choice',
					options: [option('crust', 'stuffed')],
				}),
				line({
					...base,
					id: 'ham',
					name: 'Ham pizza',
					options: [option('crust', 'thin'), option('tops', 'ham', 0, 'whole')],
				}),
				line({
					...base,
					id: 'orphan',
					name: 'Orphan nested',
					options: [option('crust', 'thin'), option('cheese', 'mozz')],
				}),
				line({ ...base, id: 'no-size', variantId: undefined, name: 'No size' }),
				line({ id: 'ok' }),
			],
			menus,
		)
		expect(result.cart.map((l) => l.id)).toEqual(['ok'])
		expect(result.removed).toEqual([
			'Calzone',
			'No crust',
			'Missing nested choice',
			'Ham pizza',
			'Orphan nested',
			'No size',
		])
	})

	it('drops items in unavailable categories or over the max', () => {
		const result = repriceHandoffCart(
			[
				line({
					itemId: 'pizza',
					variantId: 'v-sm',
					options: [option('crust', 'thin'), option('crust', 'stuffed')],
				}),
				line({ id: 'soda' }),
			],
			[
				{
					categories: [
						{ availabilityStatus: 'unavailable', items: [soda] },
						{ items: [pizza] },
					],
				},
			],
		)
		expect(result.cart).toEqual([])
		expect(result.removed).toHaveLength(2)
	})
})

describe('normalizeHandoffCart', () => {
	it('keeps valid items and fills defaults', () => {
		const cart = normalizeHandoffCart([
			{
				id: 'line1',
				itemId: 'item1',
				variantId: 'v1',
				name: 'Pizza',
				basePrice: 10,
				unitPrice: 12,
				quantity: 2,
				options: [
					{
						groupId: 'g',
						groupName: 'Top',
						optionId: 'o',
						optionName: 'Olives',
						priceDelta: 2,
						half: 'left',
					},
					{ groupId: '', optionId: 'x' },
				],
				instructions: 'Extra crispy',
			},
			{ itemId: 'item2', name: 'Soda', basePrice: 2 },
			{ name: 'No item id' },
			null,
		])
		expect(cart).toHaveLength(2)
		expect(cart[0]).toEqual({
			id: 'line1',
			itemId: 'item1',
			variantId: 'v1',
			name: 'Pizza',
			basePrice: 10,
			unitPrice: 12,
			quantity: 2,
			options: [
				{
					groupId: 'g',
					groupName: 'Top',
					optionId: 'o',
					optionName: 'Olives',
					priceDelta: 2,
					half: 'left',
				},
			],
			instructions: 'Extra crispy',
		})
		expect(cart[1]).toMatchObject({
			itemId: 'item2',
			unitPrice: 2,
			quantity: 1,
			options: [],
			instructions: '',
		})
		expect(cart[1].id).toMatch(/^cart_/)
		expect(cart[1]).not.toHaveProperty('variantId')
	})

	it('returns an empty cart for non-array input', () => {
		expect(normalizeHandoffCart({})).toEqual([])
	})
})

describe('normalizeFulfillmentMode', () => {
	it('accepts only pickup or delivery', () => {
		expect(normalizeFulfillmentMode('delivery')).toBe('delivery')
		expect(normalizeFulfillmentMode('pickup')).toBe('pickup')
		expect(normalizeFulfillmentMode('dine-in')).toBeNull()
		expect(normalizeFulfillmentMode(null)).toBeNull()
	})
})

describe('fetchVoiceOrderHandoff', () => {
	const options = {
		tenantApiUrl: 'https://tenant.test',
		token: TOKEN,
		binding: { slug: 'acme' },
	}

	async function fetchWith(response: () => Response) {
		const fetchMock = vi.fn(async () => response())
		vi.stubGlobal('fetch', fetchMock)
		try {
			return { result: await fetchVoiceOrderHandoff(options), fetchMock }
		} finally {
			vi.unstubAllGlobals()
		}
	}

	it('reads the cart from the link payload and the location from its scope', async () => {
		const { result, fetchMock } = await fetchWith(() =>
			Response.json({
				path: '/menu?location=loc1',
				payload: {
					cart: [
						{ itemId: 'item_1', name: 'Pizza', basePrice: 10, quantity: 2 },
					],
					fulfillmentMode: 'delivery',
				},
				scopeId: 'loc1',
				expiresAt: '2030-01-01T00:00:00.000Z',
			}),
		)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://tenant.test/voice/handoffs/${TOKEN}?slug=acme`,
			expect.objectContaining({ credentials: 'omit' }),
		)
		expect(result).toMatchObject({
			status: 'loaded',
			locationId: 'loc1',
			fulfillmentMode: 'delivery',
			cart: [expect.objectContaining({ itemId: 'item_1', quantity: 2 })],
		})
	})

	it('treats a link without a cart as an error and a gone link as expired', async () => {
		const empty = await fetchWith(() =>
			Response.json({ path: '/menu', payload: {} }),
		)
		expect(empty.result).toEqual({ status: 'error' })
		const gone = await fetchWith(() => new Response(null, { status: 410 }))
		expect(gone.result).toEqual({ status: 'expired' })
	})
})
