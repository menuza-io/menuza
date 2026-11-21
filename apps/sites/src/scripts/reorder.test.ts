import { describe, expect, it, vi } from 'vitest'
import { restoreCart } from './cart-restore'
import {
	fetchReorder,
	getReorderId,
	hasReorderParam,
	reorderHref,
	stripReorderParam,
} from './reorder'

const menu = [
	{
		categories: [
			{
				id: 'cat_1',
				displayName: 'Pizza',
				items: [
					{
						id: 'item_1',
						displayName: 'Margherita',
						price: 10,
						variations: {
							groups: [
								{
									id: 'size',
									name: 'Size',
									values: [
										{ id: 'l', name: 'Large' },
										{ id: 's', name: 'Small' },
									],
								},
							],
							variants: [
								{
									id: 'var_l',
									valueIds: ['l'],
									price: 12,
									availabilityStatus: 'available',
								},
								{
									id: 'var_s',
									valueIds: ['s'],
									price: 8,
									availabilityStatus: 'unavailable',
								},
							],
						},
						modifierGroups: [
							{
								id: 'grp_1',
								name: 'Extras',
								selectionType: 'multiple',
								minSelections: 0,
								maxSelections: null,
								options: [{ id: 'opt_1', displayName: 'Olives', price: 2 }],
							},
						],
					},
					{
						id: 'item_2',
						displayName: 'Cola',
						price: 3,
						variations: { groups: [], variants: [] },
						modifierGroups: [],
					},
					{
						id: 'item_3',
						displayName: 'Soup',
						price: 5,
						availabilityStatus: 'unavailable',
						variations: { groups: [], variants: [] },
						modifierGroups: [],
					},
				],
			},
		],
	},
] as never

const line = (overrides: Record<string, unknown>) => ({
	itemId: 'item_1',
	variantId: 'var_l',
	quantity: 2,
	options: [{ groupId: 'grp_1', optionId: 'opt_1', quantity: 1 }],
	...overrides,
})

describe('the reorder fragment', () => {
	it('keeps the order id in the fragment, and strips it from the address', () => {
		expect(reorderHref('ord_1')).toBe('/menu#reorder=ord_1')
		expect(reorderHref('ord_1', '/ar')).toBe('/ar/menu#reorder=ord_1')
		expect(getReorderId('https://x.test/menu#reorder=ord_1')).toBe('ord_1')
		expect(hasReorderParam('https://x.test/menu#reorder=bad id!')).toBe(true)
		expect(getReorderId('https://x.test/menu#reorder=bad id!')).toBeNull()
		expect(getReorderId('https://x.test/menu?reorder=ord_1')).toBeNull()
		expect(
			stripReorderParam('https://x.test/menu?location=l1#reorder=ord_1&x=1'),
		).toBe('/menu?location=l1#x=1')
	})
})

describe('fetching the order’s catalog ids (#112)', () => {
	const respond = (status: number, body: unknown = {}) =>
		vi.fn(async () => ({
			session: 'ok' as const,
			response: new Response(JSON.stringify(body), { status }),
		}))

	it('returns lines as ids only', async () => {
		const result = await fetchReorder(
			'ord_1',
			respond(200, {
				locationId: 'loc_1',
				fulfillment: 'pickup',
				lines: [
					{
						itemId: 'item_1',
						variantId: 'var_l',
						quantity: 2,
						options: [
							{ groupId: 'grp_1', optionId: 'opt_1', quantity: 1, half: null },
						],
						instructions: 'no basil',
						name: 'Margherita',
					},
				],
			}) as never,
		)
		expect(result).toMatchObject({
			status: 'loaded',
			lineCount: 1,
			cart: { locationId: 'loc_1' },
		})
		expect(JSON.stringify(result)).not.toMatch(/price/i)
	})

	it('maps the region’s answers', async () => {
		expect((await fetchReorder('x', respond(404) as never)).status).toBe(
			'not_found',
		)
		expect((await fetchReorder('x', respond(409) as never)).status).toBe(
			'not_reorderable',
		)
		expect((await fetchReorder('x', respond(500) as never)).status).toBe(
			'error',
		)
		expect(
			(await fetchReorder('x', respond(200, { nonsense: true }) as never))
				.status,
		).toBe('error')
		expect(
			(
				await fetchReorder(
					'x',
					vi.fn(async () => ({
						session: 'signed_out',
						response: new Response(null, { status: 401 }),
					})) as never,
				)
			).status,
		).toBe('signed_out')
		expect(
			(
				await fetchReorder(
					'x',
					vi.fn(async () => {
						throw new Error('offline')
					}) as never,
				)
			).status,
		).toBe('error')
	})
})

describe('order again rebuilds the cart and reports what is gone (#112)', () => {
	it('keeps what is still orderable, priced from the menu', () => {
		const result = restoreCart([line({}) as never], menu)
		expect(result.droppedCount).toBe(0)
		expect(result.cart).toHaveLength(1)
		expect(result.cart[0]).toMatchObject({
			itemId: 'item_1',
			quantity: 2,
			basePrice: 12,
			unitPrice: 14,
			variantId: 'var_l',
		})
	})

	it('drops the whole line when an option is gone, not just the option', () => {
		const result = restoreCart(
			[
				line({
					options: [{ groupId: 'grp_1', optionId: 'opt_gone', quantity: 1 }],
				}) as never,
				line({ itemId: 'item_2', variantId: undefined, options: [] }) as never,
			],
			menu,
		)
		expect(result.cart.map((l) => l.itemId)).toEqual(['item_2'])
		expect(result.droppedCount).toBe(1)
	})

	it('drops a line whose size is unavailable, a missing dish and a sold-out dish', () => {
		const result = restoreCart(
			[
				line({ variantId: 'var_s' }) as never,
				line({ itemId: 'gone', variantId: undefined, options: [] }) as never,
				line({ itemId: 'item_3', variantId: undefined, options: [] }) as never,
				line({
					itemId: 'item_2',
					variantId: undefined,
					options: [],
					quantity: 3,
				}) as never,
			],
			menu,
		)
		expect(result.cart.map((l) => [l.itemId, l.quantity])).toEqual([
			['item_2', 3],
		])
		expect(result.droppedCount).toBe(3)
	})

	it('keeps a line only if the item exists at the current location', () => {
		const otherLocationMenu = [
			{
				categories: [
					{
						id: 'c',
						displayName: 'Drinks',
						items: [
							{
								id: 'item_2',
								displayName: 'Cola',
								price: 4,
								variations: { groups: [], variants: [] },
								modifierGroups: [],
							},
						],
					},
				],
			},
		] as never
		const result = restoreCart(
			[
				line({}) as never,
				line({ itemId: 'item_2', variantId: undefined, options: [] }) as never,
			],
			otherLocationMenu,
		)
		expect(result.cart.map((l) => [l.itemId, l.unitPrice])).toEqual([
			['item_2', 4],
		])
		expect(result.droppedCount).toBe(1)
	})
})

describe('the app’s hand-off in the fragment (#112)', async () => {
	const { encodeReorderPayload } = await import('@repo/common/customer-orders')
	const {
		getReorderPayload,
		hasReorderPayloadParam,
		stripReorderPayloadParam,
	} = await import('./reorder')
	const payload = encodeReorderPayload({
		locationId: 'loc_1',
		fulfillment: 'pickup',
		lines: [
			{
				itemId: 'item_1',
				variantId: 'var_l',
				quantity: 2,
				options: [],
				instructions: '',
				name: 'x',
			},
		],
	})!

	it('reads the lines from the fragment only, then strips it', () => {
		const href = `https://x.test/menu#reorderlines=${payload}`
		expect(getReorderPayload(href)).toMatchObject({
			locationId: 'loc_1',
			lines: [{ itemId: 'item_1', variantId: 'var_l', quantity: 2 }],
		})
		expect(
			getReorderPayload(`https://x.test/menu?reorderlines=${payload}`),
		).toBeNull()
		expect(hasReorderPayloadParam(href)).toBe(true)
		expect(stripReorderPayloadParam(href)).toBe('/menu')
		expect(
			getReorderPayload('https://x.test/menu#reorderlines=junk'),
		).toBeNull()
	})
})

describe('channel availability during reorder (#220)', () => {
	it('drops dishes omitted from the live channel menu and reports droppedCount', () => {
		// Web menu only includes the web-available dish; a Till-only dish is absent from menus.
		const webMenus = [
			{
				categories: [
					{
						items: [
							{
								id: 'web-burger',
								displayName: 'Web Burger',
								price: 25,
								availabilityStatus: 'available',
								variations: { groups: [], variants: [] },
							},
						],
					},
				],
			},
		]
		const result = restoreCart(
			[
				{
					itemId: 'web-burger',
					quantity: 1,
					options: [],
				},
				{
					itemId: 'till-only-steak',
					quantity: 2,
					options: [],
				},
			],
			webMenus,
		)
		expect(result.cart).toHaveLength(1)
		expect(result.cart[0]?.itemId).toBe('web-burger')
		expect(result.droppedCount).toBe(1)
	})
})
