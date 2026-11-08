import { describe, expect, it } from 'vitest'
import {
	mapPolarShopOrder,
	polarCheckoutStatusToOrderStatus,
} from './polar-shop'
import { calculateShopFees, SHOP_PLATFORM_FEE_PERCENT } from './shop-fees'

describe('shop fees', () => {
	it('keeps a 20% platform share', () => {
		expect(SHOP_PLATFORM_FEE_PERCENT).toBe(20)
		expect(calculateShopFees(1000)).toEqual({
			platformFeeCents: 200,
			orgPayoutCents: 800,
			amountCents: 1000,
		})
	})
})

describe('polarCheckoutStatusToOrderStatus', () => {
	it('maps Polar checkout statuses', () => {
		expect(polarCheckoutStatusToOrderStatus('succeeded')).toBe('paid')
		expect(polarCheckoutStatusToOrderStatus('failed')).toBe('failed')
		expect(polarCheckoutStatusToOrderStatus('expired')).toBe('failed')
		expect(polarCheckoutStatusToOrderStatus('open')).toBe('pending')
	})
})

describe('mapPolarShopOrder', () => {
	it('marks an order Polar refunded in full, not one refunded in part', () => {
		const base = { id: 'ord_2', paid: true, metadata: {} }
		expect(mapPolarShopOrder({ ...base, status: 'refunded' }).refunded).toBe(
			true,
		)
		expect(
			mapPolarShopOrder({ ...base, status: 'partially_refunded' }).refunded,
		).toBe(false)
	})

	it('prefers metadata product name and net amount', () => {
		expect(
			mapPolarShopOrder({
				id: 'ord_1',
				checkoutId: 'chk_1',
				paid: true,
				netAmount: 1999,
				totalAmount: 2199,
				currency: 'usd',
				metadata: { type: 'shop_order', orgId: 'org_1', productName: 'Pack' },
			}),
		).toEqual({
			id: 'ord_1',
			checkoutId: 'chk_1',
			paid: true,
			refunded: false,
			amountCents: 1999,
			currency: 'usd',
			metadata: {
				type: 'shop_order',
				orgId: 'org_1',
				productName: 'Pack',
			},
			productName: 'Pack',
		})
	})
})
