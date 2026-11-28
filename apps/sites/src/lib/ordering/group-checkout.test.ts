import { describe, expect, it } from 'vitest'

import {
	cartFromGroupView,
	clearGroupCheckout,
	groupCartKey,
	readGroupCheckout,
	saveGroupCheckout,
} from './group-checkout.ts'

function memory() {
	const map = new Map<string, string>()
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	}
}

describe('the host’s group checkout (#170)', () => {
	it('leaves a note for the checkout page and clears it', () => {
		const storage = memory()
		expect(readGroupCheckout(storage, 'org')).toBeNull()
		saveGroupCheckout(storage, 'org', {
			groupId: 'g1',
			version: 4,
			token: 'gp1.x',
		})
		expect(readGroupCheckout(storage, 'org')).toEqual({
			groupId: 'g1',
			version: 4,
			token: 'gp1.x',
		})
		expect(readGroupCheckout(storage, 'other')).toBeNull()
		clearGroupCheckout(storage, 'org')
		expect(readGroupCheckout(storage, 'org')).toBeNull()
		storage.setItem('menuza_group_checkout_org', '{"groupId":1}')
		expect(readGroupCheckout(storage, 'org')).toBeNull()
		expect(readGroupCheckout(null, 'org')).toBeNull()
	})

	it('keeps the group’s cart apart from the host’s own', () => {
		expect(groupCartKey('org')).toBe('menuza_cart_org_group')
		expect(groupCartKey('org')).not.toBe('menuza_cart_org')
	})

	it('turns the group’s dishes into cart lines the checkout can quote', () => {
		const cart = cartFromGroupView(
			{
				id: 'g1',
				status: 'open',
				locationId: 'loc-1',
				hostFirstName: 'Hana',
				deadlineAt: null,
				perPersonLimitMinor: null,
				totalLimitMinor: null,
				totalMinor: 2500,
				currency: 'USD',
				version: 3,
				people: [],
				you: { personId: 'p1', isHost: true },
				order: null,
				canAdd: true,
				serverNow: 1,
				lines: [
					{
						id: 'l1',
						personId: 'p1',
						line: {
							itemId: 'pizza',
							variantId: 'large',
							quantity: 2,
							instructions: 'no onions',
							options: [],
						},
						itemName: '{"en":"Pizza","ar":"بيتزا"}',
						variantNames: ['{"en":"Large"}'],
						options: [
							{
								groupId: 'g',
								groupName: 'Toppings',
								optionId: 'o',
								optionName: 'Olives',
								half: null,
								quantity: 1,
								priceDelta: 1.5,
							},
						],
						amountMinor: 2500,
						available: true,
						canRemove: true,
					},
				],
			},
			'en',
			'en',
		)
		expect(cart).toHaveLength(1)
		expect(cart[0]).toMatchObject({
			itemId: 'pizza',
			variantId: 'large',
			name: 'Pizza',
			quantity: 2,
			unitPrice: 12.5,
			instructions: 'no onions',
		})
		expect(cart[0]!.options).toEqual([
			expect.objectContaining({ optionName: 'Large', variation: true }),
			expect.objectContaining({
				groupId: 'g',
				optionId: 'o',
				optionName: 'Olives',
				priceDelta: 1.5,
				quantity: 1,
			}),
		])
	})
})
