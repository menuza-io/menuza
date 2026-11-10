import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	canSeeInventoryCost,
	InventoryError,
	inventoryErrorResponse,
	omitInventoryMoney,
} from './inventory-http.ts'

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const COST = INVENTORY_PERMISSIONS.READ_INVENTORY_COST

const stock = {
	itemId: 'i1',
	onHand: 6_000_000,
	valueMinor: 16_800,
	cost: { lastCostMicro: 2_800_000, currency: 'SAR' },
	history: [
		{ quantity: 1, valueMinor: 5 },
		{ quantity: -1, valueMinor: -5 },
	],
}
const MONEY = ['valueMinor', 'lastCostMicro']

describe('money is left out without the cost grant', () => {
	it('knows which tokens may see money', () => {
		expect(canSeeInventoryCost([READ])).toBe(false)
		expect(canSeeInventoryCost([READ, COST])).toBe(true)
	})

	it('removes money fields everywhere in the response for a token without the grant', () => {
		expect(omitInventoryMoney(stock, [READ], MONEY)).toEqual({
			itemId: 'i1',
			onHand: 6_000_000,
			cost: { currency: 'SAR' },
			history: [{ quantity: 1 }, { quantity: -1 }],
		})
		const stripped = omitInventoryMoney([stock], [READ], MONEY)
		expect(JSON.stringify(stripped)).not.toContain('valueMinor')
		expect(JSON.stringify(stripped)).not.toContain('lastCostMicro')
	})

	it('keeps everything for a token with the grant and leaves the input untouched', () => {
		expect(omitInventoryMoney(stock, [READ, COST], MONEY)).toBe(stock)
		omitInventoryMoney(stock, [READ], MONEY)
		expect(stock.valueMinor).toBe(16_800)
	})
})

describe('inventory errors', () => {
	it('answers the code, status and details, no-store', async () => {
		const res = inventoryErrorResponse(
			new InventoryError('stale_version', 409, { currentVersion: 3 }),
		)
		expect(res.status).toBe(409)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(await res.json()).toEqual({
			error: 'stale_version',
			code: 'stale_version',
			currentVersion: 3,
		})
	})

	it('rethrows anything it does not know', () => {
		expect(() => inventoryErrorResponse(new Error('boom'))).toThrow('boom')
	})
})
