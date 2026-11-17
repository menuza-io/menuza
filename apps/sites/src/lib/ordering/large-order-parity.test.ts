import { buildOrderLimitCatalogFromMenus } from '@repo/common/order-limit-catalog'
import { orderLimitExemptFromCatalog } from '@repo/common/order-limit-exempt'
import {
	computePromisedTime,
	largeOrderExtraMinutes,
	largeOrderRuleFrom,
} from '@repo/common/promised-time'
import { orderDishUnits } from '@repo/common/slot-usage'
import { describe, expect, it } from 'vitest'
import { asapEstimate } from './asap-estimate.ts'
import { countedDishUnits, orderLimitMetaFromMenus } from './order-limits.ts'

/**
 * #355: Sites, the region and the order page promise the same time for the
 * same cart. The region counts a cart's items the way `placeOrder` does (the
 * order context's catalog, dishes and categories left out of order limits
 * skipped) and stores `computePromisedTime`; Sites counts with the public
 * menu through the same catalog function and shows `asapEstimate`. A rule with
 * both thresholds, a dish and a whole category that do not count.
 */

const NOW = new Date('2026-11-13T18:00:00.000Z')
const MIN = 60_000

const location = {
	timezone: 'America/New_York',
	prepTime: 20,
	deliveryConfig: {
		providers: ['in_house'],
		estimatedDeliveryTimeMin: 30,
		estimatedDeliveryTimeMax: 45,
	} as never,
}

const rule = largeOrderRuleFrom({
	itemThreshold: 12,
	amountThresholdMinor: 30_000,
	extraPrepMinutes: 15,
})

/** The menu both sides read: drinks (a whole category) and bread (one dish) do not count. */
const menus = [
	{
		availabilityStatus: 'available',
		categories: [
			{
				id: 'drinks',
				availabilityStatus: 'available',
				excludeFromOrderLimits: true,
				items: [{ id: 'cola', availabilityStatus: 'available' }],
			},
			{
				id: 'food',
				availabilityStatus: 'available',
				items: [
					{ id: 'pizza', availabilityStatus: 'available' },
					{
						id: 'bread',
						availabilityStatus: 'available',
						excludeFromOrderLimits: true,
					},
				],
				subcategories: [
					{
						id: 'pasta',
						availabilityStatus: 'available',
						items: [{ id: 'penne', availabilityStatus: 'available' }],
					},
				],
			},
		],
	},
]

const PRICE: Record<string, number> = {
	cola: 3,
	pizza: 15,
	bread: 4,
	penne: 14,
}

type Cart = Array<{ itemId: string; quantity: number }>

const subtotalOf = (cart: Cart) =>
	cart.reduce((sum, line) => sum + PRICE[line.itemId]! * line.quantity, 0)

/** What the region does at placement. */
function regionStores(cart: Cart, fulfillment: 'pickup' | 'delivery') {
	const { catalog, categoryExempt } = buildOrderLimitCatalogFromMenus(menus)
	const counted = orderDishUnits(
		cart.map((line) => ({
			itemId: line.itemId,
			quantity: line.quantity,
			// A priced line carries every category the dish is in.
			categoryIds: [...(catalog.get(line.itemId)?.categoryIds ?? [])],
		})),
		orderLimitExemptFromCatalog(catalog, categoryExempt),
	)
	const promised = computePromisedTime({
		now: NOW,
		fulfillment,
		scheduledFor: null,
		location,
		largeOrder: rule,
		subtotalCents: subtotalOf(cart) * 100,
		itemCount: counted,
	})
	return { counted, promised }
}

/** What the checkout page shows. */
function sitesShows(cart: Cart) {
	const meta = orderLimitMetaFromMenus(menus)
	const counted = countedDishUnits(cart, meta)
	return {
		counted,
		shown: asapEstimate({
			location,
			now: NOW,
			largeOrder: rule,
			subtotal: subtotalOf(cart),
			itemCount: counted,
		}),
	}
}

const carts: Record<string, Cart> = {
	'under both thresholds once the drinks and bread are left out (20 pieces, 10 count)':
		[
			{ itemId: 'pizza', quantity: 8 },
			{ itemId: 'cola', quantity: 6 },
			{ itemId: 'bread', quantity: 4 },
			{ itemId: 'penne', quantity: 2 },
		],
	'over the item threshold': [{ itemId: 'pizza', quantity: 13 }],
	'over the amount threshold with few items': [
		{ itemId: 'pizza', quantity: 21 },
	],
	'exactly at the item threshold (not over it)': [
		{ itemId: 'penne', quantity: 12 },
	],
	'only things that do not count': [
		{ itemId: 'cola', quantity: 40 },
		{ itemId: 'bread', quantity: 40 },
	],
}

describe('Sites and the region count a cart the same way (#355)', () => {
	for (const [name, cart] of Object.entries(carts)) {
		it(`counts the same dishes: ${name}`, () => {
			expect(sitesShows(cart).counted).toBe(
				regionStores(cart, 'pickup').counted,
			)
		})

		it(`promises the same pickup and delivery time: ${name}`, () => {
			const { shown } = sitesShows(cart)
			const pickup = regionStores(cart, 'pickup').promised
			expect(pickup.promisedAt!.getTime() - NOW.getTime()).toBe(
				shown.pickupMinutes * MIN,
			)
			const delivery = regionStores(cart, 'delivery').promised
			expect(delivery.promisedAt!.getTime() - NOW.getTime()).toBe(
				shown.delivery.min * MIN,
			)
			expect(delivery.promisedUntil!.getTime() - NOW.getTime()).toBe(
				shown.delivery.max * MIN,
			)
		})
	}

	it('adds 15 minutes to a 13-item order and none to a 2-item one', () => {
		const small = sitesShows([{ itemId: 'pizza', quantity: 2 }]).shown
		const large = sitesShows([{ itemId: 'pizza', quantity: 13 }]).shown
		expect(large.pickupMinutes - small.pickupMinutes).toBe(15)
		expect(large.largeOrderExtra).toBe(15)
	})

	it('does not reach the threshold by counting drinks and bread, which a client counting every unit would', () => {
		const cart = carts[Object.keys(carts)[0]!]!
		const everything = cart.reduce((sum, line) => sum + line.quantity, 0)
		expect(everything).toBe(20)
		expect(sitesShows(cart).counted).toBe(10)
		expect(sitesShows(cart).shown.largeOrderExtra).toBe(0)
		// What counting every unit would have promised: a different time.
		const naive = largeOrderExtraMinutes(rule, {
			subtotalCents: subtotalOf(cart) * 100,
			itemCount: everything,
		})
		expect(naive).toBe(15)
		expect(naive).not.toBe(sitesShows(cart).shown.largeOrderExtra)
	})

	it('counts the units of a per-item packaging fee the same way as the region (#408)', () => {
		const { catalog, categoryExempt } = buildOrderLimitCatalogFromMenus(menus)
		const exempt = orderLimitExemptFromCatalog(catalog, categoryExempt)
		const meta = orderLimitMetaFromMenus(menus)
		for (const cart of Object.values(carts)) {
			const region = orderDishUnits(
				cart.map((line) => ({
					itemId: line.itemId,
					quantity: line.quantity,
					categoryIds: [...(catalog.get(line.itemId)?.categoryIds ?? [])],
				})),
				exempt,
			)
			expect(countedDishUnits(cart, meta)).toBe(region)
		}
	})

	it('reads the same exemptions from the page meta after the JSON trip the page makes', () => {
		const meta = JSON.parse(JSON.stringify(orderLimitMetaFromMenus(menus)))
		const cart = carts[Object.keys(carts)[0]!]!
		expect(countedDishUnits(cart, meta)).toBe(
			regionStores(cart, 'pickup').counted,
		)
	})
})
