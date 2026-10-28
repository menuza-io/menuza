import { describe, expect, it } from 'vitest'
import { groupByLocation } from './vertical-ui.tsx'

describe('groupByLocation', () => {
	it('groups tables by location, in location order, unknown ones last', () => {
		const tables = [
			{ id: 't1', label: '1', locationId: 'b' },
			{ id: 't2', label: '1', locationId: 'a' },
			{ id: 't3', label: '2', locationId: 'gone' },
			{ id: 't4', label: '2', locationId: 'a' },
		]
		const groups = groupByLocation(tables, [
			{ id: 'a', name: 'Downtown' },
			{ id: 'b', name: 'Airport' },
			{ id: 'c', name: 'Empty' },
		])
		expect(
			groups.map((group) => [group.name, group.tables.map((t) => t.id)]),
		).toEqual([
			['Downtown', ['t2', 't4']],
			['Airport', ['t1']],
			[null, ['t3']],
		])
	})
})
