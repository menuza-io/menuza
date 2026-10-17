import { type FilterCondition } from '@repo/ui/filters'
import { describe, expect, it } from 'vitest'
import { isActiveCustomerCondition } from './customers.tsx'

function condition(
	overrides: Partial<FilterCondition> & Pick<FilterCondition, 'field'>,
): FilterCondition {
	return {
		path: [overrides.field],
		operator: 'is_any_of',
		values: [],
		negated: false,
		...overrides,
	}
}

describe('isActiveCustomerCondition', () => {
	it('ignores a status chip with no value picked', () => {
		expect(isActiveCustomerCondition(condition({ field: 'status' }))).toBe(
			false,
		)
	})

	it('ignores a text chip with a blank value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'name', operator: 'contains', values: ['  '] }),
			),
		).toBe(false)
	})

	it('counts a chip with a value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'status', values: ['verified'] }),
			),
		).toBe(true)
		expect(
			isActiveCustomerCondition(
				condition({ field: 'name', operator: 'contains', values: ['ali'] }),
			),
		).toBe(true)
	})

	it('counts operators that take no value', () => {
		expect(
			isActiveCustomerCondition(
				condition({ field: 'email', operator: 'empty' }),
			),
		).toBe(true)
		expect(
			isActiveCustomerCondition(
				condition({ field: 'email', operator: 'not_empty' }),
			),
		).toBe(true)
	})
})
