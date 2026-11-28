/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/client-auth', () => ({
	getAccessToken: () => 'token',
	getOrgBinding: () => ({}),
}))
vi.mock('~/lib/guest-account-client', () => ({
	createSavedAddress: vi.fn(),
	deleteSavedAddress: vi.fn(),
	listSavedAddresses: vi.fn(),
	updateSavedAddress: vi.fn(),
}))

import { pickDeliverableStore } from './profile-addresses'

const quote = (token: string) =>
	({
		token,
		expiresAt: '',
		address: {},
		deliveryFee: 0,
		minimumOrder: 0,
		eta: { min: 1, max: 2 },
	}) as never
const choice = (locationId: string, withQuote: boolean) => ({
	locationId,
	name: locationId,
	formattedAddress: null,
	distanceMeters: null,
	open: true,
	etaMinutes: null,
	quote: withQuote ? quote(`tok_${locationId}`) : null,
})

describe('adding an address from the profile (#113)', () => {
	it('saves against the first store that delivers there, with its signed quote', () => {
		expect(
			pickDeliverableStore({
				status: 'ok',
				locations: [choice('a', false), choice('b', true), choice('c', true)],
			}),
		).toEqual({ locationId: 'b', quoteToken: 'tok_b' })
	})

	it('saves nothing when no store delivers or the address was not found', () => {
		expect(
			pickDeliverableStore({ status: 'ok', locations: [choice('a', false)] }),
		).toBeNull()
		expect(pickDeliverableStore({ status: 'ok', locations: [] })).toBeNull()
		expect(pickDeliverableStore({ status: 'not_found' })).toBeNull()
		expect(
			pickDeliverableStore({ status: 'unavailable', reason: 'no_zones' }),
		).toBeNull()
	})
})
