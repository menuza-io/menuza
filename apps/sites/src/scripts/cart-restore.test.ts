import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
	fetchSavedCart,
	getCartToken,
	hasCartParam,
	restoreCart,
	stripCartParam,
	type SavedCartLine,
} from './cart-restore'

const TOKEN = `1799928000000.cust_1.${'a'.repeat(64)}`
const origin = 'https://shop.example.com'

const menu = {
	categories: [
		{
			items: [
				{ id: 'burger', displayName: 'Burger', price: 10, modifierGroups: [] },
				{
					id: 'soldout',
					displayName: 'Soup',
					price: 5,
					availabilityStatus: 'unavailable',
					modifierGroups: [],
				},
				{
					id: 'pizza',
					displayName: 'Pizza',
					price: 12,
					modifierGroups: [
						{
							id: 'toppings',
							name: 'Toppings',
							selectionType: 'quantity',
							minSelections: 0,
							maxSelections: 5,
							options: [
								{ id: 'cheese', displayName: 'Cheese', price: 1.5 },
								{ id: 'gone', displayName: 'Truffle', price: 4, availabilityStatus: 'unavailable' },
							],
						},
					],
				},
			],
		},
	],
}

describe('cart restore link (#150)', () => {
	it('reads the token only from the fragment, never the query string', () => {
		expect(getCartToken(`${origin}/menu#cart=${TOKEN}`)).toBe(TOKEN)
		expect(getCartToken(`${origin}/menu?cart=${TOKEN}`)).toBeNull()
		expect(getCartToken(`${origin}/menu?x=1#other=1&cart=${TOKEN}`)).toBe(TOKEN)
		expect(getCartToken(`${origin}/menu#cart=not-a-token`)).toBeNull()
		expect(hasCartParam(`${origin}/menu?cart=${TOKEN}`)).toBe(false)
		expect(hasCartParam(`${origin}/menu#cart=junk`)).toBe(true)
	})

	it('strips the token from the address and keeps everything else', () => {
		expect(stripCartParam(`${origin}/menu#cart=${TOKEN}`)).toBe('/menu')
		expect(stripCartParam(`${origin}/menu?location=l1#cart=${TOKEN}&x=1`)).toBe(
			'/menu?location=l1#x=1',
		)
		expect(stripCartParam(`${origin}/menu?location=l1`)).toBe('/menu?location=l1')
	})

	it('sends the token in a header from the browser, never in the URL, and treats 404 as expired', async () => {
		const fetchImpl = vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 }))
		const result = await fetchSavedCart({
			tenantApiUrl: 'https://tenant.example.com',
			token: TOKEN,
			binding: { slug: 'olive' },
			fetchImpl: fetchImpl as never,
		})
		expect(result).toEqual({ status: 'expired' })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://tenant.example.com/orders/cart-link?slug=olive')
		expect(url).not.toContain(TOKEN)
		expect((init.headers as Record<string, string>)['X-Cart-Token']).toBe(TOKEN)
		expect(init.credentials).toBe('omit')
	})

	it('loads the saved lines (ids and quantities)', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({
				cart: {
					locationId: 'loc-1',
					currency: 'USD',
					lines: [{ itemId: 'burger', quantity: 2, options: [] }, { bad: true }],
				},
			}),
		)
		const result = await fetchSavedCart({
			tenantApiUrl: 'https://t',
			token: TOKEN,
			binding: {},
			fetchImpl: fetchImpl as never,
		})
		expect(result).toEqual({
			status: 'loaded',
			cart: {
				locationId: 'loc-1',
				currency: 'USD',
				lines: [{ itemId: 'burger', quantity: 2, options: [] }],
			},
		})
	})

	it('drops unavailable items and options, keeps quantities, prices from the menu', () => {
		const lines: SavedCartLine[] = [
			{ itemId: 'burger', quantity: 3, options: [] },
			{ itemId: 'soldout', quantity: 1, options: [] },
			{ itemId: 'deleted', quantity: 1, options: [] },
			{
				itemId: 'pizza',
				quantity: 1,
				options: [{ groupId: 'toppings', optionId: 'cheese', quantity: 2 }],
			},
			{
				itemId: 'pizza',
				quantity: 1,
				options: [{ groupId: 'toppings', optionId: 'gone' }],
			},
		]
		const result = restoreCart(lines, [menu])
		expect(result.cart.map((line) => [line.itemId, line.quantity])).toEqual([
			['burger', 3],
			['pizza', 1],
		])
		expect(result.cart[0]!.unitPrice).toBe(10)
		// Quantity option: 2 x 1.50 on top of the menu's 12.
		expect(result.cart[1]!.unitPrice).toBe(15)
		expect(result.cart[1]!.options[0]).toMatchObject({ quantity: 2, priceDelta: 3 })
		expect(result.droppedCount).toBe(3)
		expect(result.removedNames).toContain('Soup')
	})

	it('a link with nothing left to order restores nothing', () => {
		const result = restoreCart([{ itemId: 'soldout', quantity: 1 }], [menu])
		expect(result.cart).toEqual([])
		expect(result.droppedCount).toBe(1)
	})

	it('the menu page and the SSR page never read the token from the query string or on the server', () => {
		const here = path.dirname(new URL(import.meta.url).pathname)
		const menuPage = readFileSync(path.join(here, '../pages/menu.astro'), 'utf8')
		const restore = readFileSync(path.join(here, 'cart-restore.ts'), 'utf8')
		for (const source of [menuPage, restore]) {
			expect(source).not.toMatch(/searchParams\.get\(['"]cart['"]\)/)
		}
		// Server-side frontmatter (before the client <script>) never touches the fragment.
		const frontmatter = menuPage.split('---')[1] ?? ''
		expect(frontmatter).not.toMatch(/\.hash|cart-restore|CART_PARAM|X-Cart-Token/)
		expect(restore).toContain("hash.slice(1)")
	})
})
