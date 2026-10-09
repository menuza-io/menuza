import { describe, expect, it, vi } from 'vitest'
import {
	ORDER_DETAILS_CHANGE_EVENT,
	type OrderDetails,
	hasValidDeliveryQuote,
	legacyModeKey,
	loadOrderDetails,
	orderDetailsKey,
	parseOrderDetails,
	saveOrderDetails,
	updateOrderDetails,
} from './order-details.ts'

function memory() {
	const map = new Map<string, string>()
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	}
}

const now = new Date('2026-10-08T17:00:00Z')
const delivery = {
	quoteToken: 'tok',
	expiresAt: '2026-10-08T19:00:00Z',
	formatted: '123 Demo Street, Chicago, IL 60601',
	line1: '123 Demo Street',
	city: 'Chicago',
	postalCode: '60601',
	deliveryFee: 3.5,
	minimumOrder: 15,
	zoneName: 'Loop',
	eta: { min: 25, max: 40 },
}
const details: OrderDetails = {
	v: 1,
	mode: 'delivery',
	locationId: 'loc_1',
	delivery,
	scheduledFor: '2026-10-08T23:30:00Z',
}

describe('parseOrderDetails', () => {
	it('round-trips valid details', () => {
		expect(parseOrderDetails(JSON.stringify(details), now)).toEqual(details)
	})

	it('drops expired quotes (with a minute of skew) and past schedules', () => {
		const stale = {
			...details,
			delivery: { ...delivery, expiresAt: '2026-10-08T17:00:30Z' },
			scheduledFor: '2026-10-08T16:00:00Z',
		}
		const parsed = parseOrderDetails(JSON.stringify(stale), now)
		expect(parsed?.delivery).toBeUndefined()
		expect(parsed?.scheduledFor).toBeNull()
		expect(hasValidDeliveryQuote(parsed, now)).toBe(false)
	})

	it('rejects junk', () => {
		expect(parseOrderDetails('{', now)).toBeNull()
		expect(parseOrderDetails(JSON.stringify({ v: 2 }), now)).toBeNull()
		expect(
			parseOrderDetails(
				JSON.stringify({
					...details,
					delivery: { ...delivery, deliveryFee: -1 },
				}),
				now,
			)?.delivery,
		).toBeUndefined()
	})
})

describe('loadOrderDetails', () => {
	it('falls back to the legacy mode key', () => {
		const storage = memory()
		storage.setItem(legacyModeKey('org'), 'delivery')
		expect(
			loadOrderDetails('org', { locationId: 'loc_1', storage, now }),
		).toEqual({
			v: 1,
			mode: 'delivery',
			locationId: 'loc_1',
			scheduledFor: null,
		})
	})

	it('resets the quote and schedule for another location', () => {
		const storage = memory()
		storage.setItem(orderDetailsKey('org'), JSON.stringify(details))
		const loaded = loadOrderDetails('org', {
			locationId: 'loc_2',
			storage,
			now,
		})
		expect(loaded).toEqual({
			v: 1,
			mode: 'delivery',
			locationId: 'loc_2',
			scheduledFor: null,
		})
	})

	it('respects allowed modes', () => {
		const storage = memory()
		storage.setItem(orderDetailsKey('org'), JSON.stringify(details))
		expect(
			loadOrderDetails('org', {
				locationId: 'loc_1',
				storage,
				now,
				allowedModes: ['pickup'],
			}).mode,
		).toBe('pickup')
	})
})

describe('saveOrderDetails', () => {
	it('writes both keys and dispatches the change event', () => {
		const storage = memory()
		const target = new EventTarget()
		const listener = vi.fn()
		target.addEventListener(ORDER_DETAILS_CHANGE_EVENT, (event) =>
			listener((event as CustomEvent).detail),
		)
		saveOrderDetails('org', details, { storage, target })
		expect(JSON.parse(storage.map.get(orderDetailsKey('org'))!)).toEqual(
			details,
		)
		expect(storage.map.get(legacyModeKey('org'))).toBe('delivery')
		expect(listener).toHaveBeenCalledWith(details)
	})

	it('removes delivery when patched to undefined', () => {
		const storage = memory()
		const next = updateOrderDetails(
			'org',
			details,
			{ mode: 'pickup', delivery: undefined },
			{ storage, target: null },
		)
		expect(next.delivery).toBeUndefined()
		expect(storage.map.get(legacyModeKey('org'))).toBe('pickup')
	})
})
