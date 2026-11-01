import { describe, expect, it } from 'vitest'
import {
	discountLocationsAllowedInScope,
	discountVisibleInScope,
} from './location-scope.server.ts'

describe('discount location scope', () => {
	it('shows every discount to an operator with all locations', () => {
		expect(discountVisibleInScope(['a'], null)).toBe(true)
		expect(discountVisibleInScope(null, null)).toBe(true)
	})

	it('hides discounts that never touch the operator locations', () => {
		expect(discountVisibleInScope(['a'], ['b'])).toBe(false)
		expect(discountVisibleInScope(['a', 'b'], ['b'])).toBe(true)
	})

	it('still shows org-wide discounts to a scoped operator', () => {
		expect(discountVisibleInScope(null, ['a'])).toBe(true)
	})

	it('refuses all-locations saves and out-of-scope picks', () => {
		expect(discountLocationsAllowedInScope(null, true, ['a'])).toBe(false)
		expect(discountLocationsAllowedInScope(['a', 'b'], false, ['a'])).toBe(
			false,
		)
		expect(discountLocationsAllowedInScope(['a'], false, ['a'])).toBe(true)
	})
})
