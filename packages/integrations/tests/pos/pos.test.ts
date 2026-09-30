import { describe, expect, it } from 'vitest'
import { createAdapter } from '../../src/pos/adapter'
import { resolveTransport } from '../../src/pos/transport'
import {
	merchantIds,
	posProviders,
	type PosProvider,
	type RemoteItem,
	type RemoteMenu,
} from '../../src/pos/types'
import {
	cloverWire,
	doordashWire,
	squareWire,
	toastWire,
	uberWire,
} from '../../src/pos/wire'

const sampleItem: RemoteItem = {
	id: 'item-1',
	name: 'Margherita Pizza',
	description: 'Tomato, basil, mozzarella',
	category: 'Pizza',
	price: 1299,
	imageUrl: null,
	available: true,
	modifierGroups: [
		{
			name: 'Extra toppings',
			min: 0,
			max: 3,
			options: [{ name: 'Olives', price: 100 }],
		},
	],
	variations: [],
	menus: [],
	allergens: ['dairy'],
	alcohol: false,
	taxRate: 8.5,
	version: 1,
}
const sampleMenus: RemoteMenu[] = [
	{ name: 'Lunch', days: [0, 1, 2, 3, 4], start: '11:00', end: '15:00' },
]

describe('POS wire codecs', () => {
	it('round-trips a Clover element', () => {
		const decoded = cloverWire.decode(cloverWire.encode(sampleItem))
		expect(decoded.name).toBe(sampleItem.name)
		expect(decoded.price).toBe(sampleItem.price)
		expect(decoded.category).toBe(sampleItem.category)
		expect(decoded.modifierGroups[0]?.options[0]?.name).toBe('Olives')
		expect(decoded.taxRate).toBeCloseTo(8.5)
	})

	it('round-trips Square catalog objects', () => {
		const objects = squareWire.encode([sampleItem], 'USD', 'LOC')
		const [decoded] = squareWire.decode(objects, 'LOC')
		expect(decoded?.name).toBe(sampleItem.name)
		expect(decoded?.price).toBe(sampleItem.price)
		expect(decoded?.category).toBe(sampleItem.category)
		expect(decoded?.modifierGroups[0]?.name).toBe('Extra toppings')
	})

	it('round-trips a Toast menu', () => {
		const payload = toastWire.encode([sampleItem], sampleMenus, 'GUID')
		const decoded = toastWire.decode(payload, [
			{ guid: 'item-1', status: 'IN_STOCK' },
		])
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
		expect(decoded.menus[0]?.name).toBe('Lunch')
	})

	it('round-trips an Uber Eats menu', () => {
		const decoded = uberWire.decode(
			uberWire.encode([{ ...sampleItem, menus: ['Lunch'] }], sampleMenus),
		)
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
		expect(decoded.items[0]?.menus).toEqual(['Lunch'])
	})

	it('round-trips a DoorDash menu', () => {
		const decoded = doordashWire.decode(
			doordashWire.encode([{ ...sampleItem, menus: ['Lunch'] }], sampleMenus),
		)
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
	})
})

function adapterFor(provider: PosProvider, storeId: string) {
	const transport = resolveTransport(provider, storeId, {
		environment: 'sandbox',
		merchantId: merchantIds[provider],
	})
	return createAdapter(provider, transport)
}

describe('POS sandbox adapters', () => {
	for (const provider of posProviders) {
		it(`${provider}: connects and reads a seeded catalog`, async () => {
			const adapter = adapterFor(provider, `store-${provider}`)
			const currency = await adapter.connect()
			expect(currency).toBe('USD')

			const catalog = await adapter.read()
			expect(catalog.items.length).toBeGreaterThan(0)
			expect(catalog.items.every((item) => item.name)).toBe(true)
		})
	}

	it('clover: creates and updates an item', async () => {
		const adapter = adapterFor('clover', 'store-clover-write')
		const created = await adapter.create(
			{ ...sampleItem, id: '' },
			'key-1',
			'USD',
		)
		expect(created.id).toBeTruthy()
		await adapter.update({ ...created, price: 999 }, 'key-2', 'USD')
		const catalog = await adapter.read()
		expect(catalog.items.find((item) => item.id === created.id)?.price).toBe(
			999,
		)
	})

	it('square: creates an item and returns an id', async () => {
		const adapter = adapterFor('square', 'store-square-write')
		const created = await adapter.create(
			{ ...sampleItem, id: 'draft' },
			'key-square',
			'USD',
		)
		expect(created.id).toBeTruthy()
		const catalog = await adapter.read()
		expect(catalog.items.some((item) => item.id === created.id)).toBe(true)
	})

	it('ubereats: replaces the whole menu', async () => {
		const adapter = adapterFor('ubereats', 'store-uber-write')
		const before = await adapter.read()
		await adapter.submitMenu(
			[{ ...sampleItem, menus: ['Lunch'] }],
			sampleMenus,
			0,
			'key-uber',
		)
		const after = await adapter.read()
		expect(after.items).toHaveLength(1)
		expect(after.items[0]?.id).toBe('item-1')
		expect(before.items.length).toBeGreaterThan(0)
	})

	it('doordash: replaces the whole menu through a job', async () => {
		const adapter = adapterFor('doordash', 'store-dd-write')
		const before = await adapter.read()
		await adapter.submitMenu(
			[{ ...sampleItem, menus: ['Lunch'] }],
			sampleMenus,
			before.version,
			'key-dd',
		)
		const after = await adapter.read()
		expect(after.items).toHaveLength(1)
	})

	it('toast: updates availability only', async () => {
		const adapter = adapterFor('toast', 'store-toast-write')
		const before = await adapter.read()
		const item = before.items[0]!
		await adapter.setAvailability(item, false, 'key-toast', 'USD')
		const after = await adapter.read()
		expect(after.items.find((entry) => entry.id === item.id)?.available).toBe(
			false,
		)
	})
})
