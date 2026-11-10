import { expect } from 'vitest'
import { BASE, cid, type Reply } from './inventory-test-utils.ts'

/**
 * Builders for the phase 2 route tests: suppliers, items, supplier products,
 * levels and stock, all through the real operator routes with one admin token.
 */

type Call = (
	method: string,
	path: string,
	options: { token: string; body?: unknown; headers?: Record<string, string> },
) => Promise<Reply>

export function makeWorld(call: Call, token: string, locationId: string) {
	async function ok(method: string, path: string, body?: unknown) {
		const res = await call(method, `${BASE}${path}`, { token, body })
		expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(
			200,
		)
		return res.body as Record<string, any>
	}

	return {
		ok,
		async supplier(name: string, extra: Record<string, unknown> = {}) {
			return ok('POST', '/suppliers', {
				clientId: cid('sup'),
				name,
				currency: 'SAR',
				...extra,
			})
		},
		async item(name: string, baseUnit = 'g') {
			return ok('POST', '/items', {
				clientId: cid('item'),
				name,
				category: 'meat',
				kind: 'bought',
				baseUnit,
			})
		},
		async product(
			supplierId: string,
			itemId: string,
			extra: Record<string, unknown> = {},
		) {
			return ok('POST', `/suppliers/${supplierId}/products`, {
				itemId,
				packName: 'Box 10 kg',
				packBaseQuantity: 10_000_000,
				priceMinor: 28_000,
				...extra,
			})
		},
		/** Levels for items that have no place row yet (version 0). */
		async levels(
			rows: Array<{
				itemId: string
				orderBelowQuantity: number | null
				fillUpToQuantity: number | null
				expectedVersion?: number
			}>,
		) {
			const body = await ok('PUT', '/levels/bulk', {
				clientId: cid('lvl'),
				locationId,
				levels: rows.map((row) => ({ expectedVersion: 0, ...row })),
			})
			expect(body.refused).toEqual([])
			return body
		},
		/** Puts stock on the shelf by a by-hand adjustment (base thousandths). */
		async stock(itemId: string, quantity: number) {
			return ok('POST', `/items/${itemId}/adjust`, {
				clientId: cid('adj'),
				locationId,
				quantity,
				reason: 'found',
			})
		},
	}
}
