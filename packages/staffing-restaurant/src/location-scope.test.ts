import { describe, expect, it } from 'vitest'
import {
	locationIdsClaim,
	memberLocationScopeInputSchema,
	STAFFING_MAX_SCOPED_LOCATIONS,
} from './location-scope.ts'

describe('locationIdsClaim', () => {
	it('is null (every location) only for the exact scope "all"', () => {
		expect(locationIdsClaim('all', [])).toBeNull()
		expect(locationIdsClaim('all', ['a'])).toBeNull()
	})

	it('returns the selected ids, de-duplicated and sorted', () => {
		expect(locationIdsClaim('selected', ['b', 'a', 'b'])).toEqual(['a', 'b'])
	})

	it('treats "selected" with nothing chosen as no access, not all access', () => {
		expect(locationIdsClaim('selected', [])).toEqual([])
	})

	it('fails closed for a missing or unknown scope', () => {
		for (const scope of [undefined, null, '', 'ALL', 'everything', 'none']) {
			expect(locationIdsClaim(scope, ['a'])).toEqual([])
		}
	})
})

describe('memberLocationScopeInputSchema', () => {
	it('drops any location list that arrives with scope "all"', () => {
		expect(
			memberLocationScopeInputSchema.parse({
				scope: 'all',
				locationIds: ['a', 'b'],
			}),
		).toEqual({ scope: 'all', locationIds: [] })
	})

	it('trims, de-duplicates and sorts selected ids', () => {
		expect(
			memberLocationScopeInputSchema.parse({
				scope: 'selected',
				locationIds: [' b ', 'a', 'b'],
			}),
		).toEqual({ scope: 'selected', locationIds: ['a', 'b'] })
	})

	it('allows selected with no locations (no staffing access)', () => {
		expect(memberLocationScopeInputSchema.parse({ scope: 'selected' })).toEqual(
			{
				scope: 'selected',
				locationIds: [],
			},
		)
	})

	it('rejects unknown scopes, unknown keys, blank ids and oversize lists', () => {
		expect(
			memberLocationScopeInputSchema.safeParse({ scope: 'some' }).success,
		).toBe(false)
		expect(
			memberLocationScopeInputSchema.safeParse({
				scope: 'all',
				userId: 'someone-else',
			}).success,
		).toBe(false)
		expect(
			memberLocationScopeInputSchema.safeParse({
				scope: 'selected',
				locationIds: ['  '],
			}).success,
		).toBe(false)
		expect(
			memberLocationScopeInputSchema.safeParse({
				scope: 'selected',
				locationIds: Array.from(
					{ length: STAFFING_MAX_SCOPED_LOCATIONS + 1 },
					(_, i) => `loc-${i}`,
				),
			}).success,
		).toBe(false)
	})
})
