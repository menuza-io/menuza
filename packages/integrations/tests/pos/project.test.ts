import { describe, expect, it } from 'vitest'
import { type MenuVariations } from '@repo/common/menu-types'
import { projectMenuVariations } from '../../src/pos/project'

describe('POS menu variation projection', () => {
	it('exports full combinations with their own prices and excludes sold-out variants', () => {
		const variations: MenuVariations = {
			groups: [
				{
					id: 'size',
					name: 'Size',
					values: [
						{ id: 'small', name: 'Small' },
						{ id: 'large', name: 'Large' },
					],
				},
				{
					id: 'milk',
					name: 'Milk',
					values: [
						{ id: 'oat', name: 'Oat' },
						{ id: 'dairy', name: 'Dairy' },
					],
				},
			],
			variants: [
				{
					id: '1',
					valueIds: ['small', 'oat'],
					price: 4.25,
					imageKey: null,
					availabilityStatus: 'available',
					unavailableUntil: null,
				},
				{
					id: '2',
					valueIds: ['small', 'dairy'],
					price: 3.5,
					imageKey: null,
					availabilityStatus: 'unavailable',
					unavailableUntil: null,
				},
				{
					id: '3',
					valueIds: ['large', 'oat'],
					price: 5.75,
					imageKey: null,
					availabilityStatus: 'unavailable_until',
					unavailableUntil: '2026-09-29T10:00:00Z',
				},
				{
					id: '4',
					valueIds: ['large', 'dairy'],
					price: 5,
					imageKey: null,
					availabilityStatus: 'unavailable_until',
					unavailableUntil: '2026-09-30T10:00:00Z',
				},
			],
		}
		expect(
			projectMenuVariations(variations, new Date('2026-09-29T12:00:00Z')),
		).toEqual([
			{ name: 'Small / Oat', price: 425 },
			{ name: 'Large / Oat', price: 575 },
		])
	})
})
