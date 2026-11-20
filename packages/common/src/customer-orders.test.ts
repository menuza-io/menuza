import { describe, expect, it } from 'vitest'
import {
	decodeReorderPayload,
	encodeReorderPayload,
	isLapsedUnpaidOnlineOrder,
	reorderableFulfillment,
	type ReorderResponse,
} from './customer-orders.ts'

const reorder: ReorderResponse = {
	locationId: 'loc_1',
	fulfillment: 'pickup',
	lines: [
		{
			itemId: 'item_1',
			variantId: 'var_l',
			quantity: 2,
			options: [
				{ groupId: 'g1', optionId: 'o1', quantity: 1, half: null },
				{ groupId: 'g2', optionId: 'o2', quantity: 3, half: 'left' },
			],
			instructions: 'ring the bell, Alice',
			name: 'Margherita',
		},
		{
			itemId: 'item_2',
			variantId: null,
			quantity: 1,
			options: [],
			instructions: '',
			name: 'Cola',
		},
	],
}

describe('the app → website reorder hand-off (#112)', () => {
	it('round-trips ids, quantities and halves', () => {
		const encoded = encodeReorderPayload(reorder)!
		expect(decodeReorderPayload(encoded)).toEqual({
			locationId: 'loc_1',
			lines: [
				{
					itemId: 'item_1',
					variantId: 'var_l',
					quantity: 2,
					options: [
						{ groupId: 'g1', optionId: 'o1' },
						{ groupId: 'g2', optionId: 'o2', quantity: 3, half: 'left' },
					],
				},
				{ itemId: 'item_2', quantity: 1, options: [] },
			],
		})
	})

	it('carries no names, prices or guest notes', () => {
		const encoded = encodeReorderPayload(reorder)!
		const json = Buffer.from(
			encoded.replace(/-/g, '+').replace(/_/g, '/'),
			'base64',
		).toString()
		expect(json).not.toMatch(/Alice|ring the bell|Margherita|price/i)
	})

	it('refuses junk, oversized and tampered payloads', () => {
		expect(decodeReorderPayload(null)).toBeNull()
		expect(decodeReorderPayload('not base64!!')).toBeNull()
		expect(
			decodeReorderPayload(
				Buffer.from('{"l":"x","n":[]}').toString('base64url'),
			),
		).toBeNull()
		expect(decodeReorderPayload('a'.repeat(13_000))).toBeNull()
		expect(
			decodeReorderPayload(
				Buffer.from(
					JSON.stringify({ l: 'x y', n: [{ i: 'a', q: 1 }] }),
				).toString('base64url'),
			),
		).toBeNull()
		const hostile = {
			...reorder,
			lines: [{ ...reorder.lines[0]!, itemId: '../../etc' }],
		}
		expect(encodeReorderPayload(hostile)).toBeNull()
	})
})

describe('rules', () => {
	it('only pickup and delivery can be ordered again', () => {
		expect(reorderableFulfillment('pickup')).toBe(true)
		expect(reorderableFulfillment('delivery')).toBe(true)
		expect(reorderableFulfillment('dine_in')).toBe(false)
	})

	it('a lapsed unpaid online order is one to finish', () => {
		expect(
			isLapsedUnpaidOnlineOrder({
				status: 'expired',
				paymentMethod: 'online',
				paymentStatus: 'unpaid',
			}),
		).toBe(true)
		expect(
			isLapsedUnpaidOnlineOrder({
				status: 'expired',
				paymentMethod: 'online',
				paymentStatus: 'paid',
			}),
		).toBe(false)
		expect(
			isLapsedUnpaidOnlineOrder({
				status: 'cancelled',
				paymentMethod: 'online',
				paymentStatus: 'unpaid',
			}),
		).toBe(false)
		expect(
			isLapsedUnpaidOnlineOrder({
				status: 'expired',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
			}),
		).toBe(false)
	})
})
