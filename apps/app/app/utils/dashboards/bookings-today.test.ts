import { describe, expect, it } from 'vitest'
import { inaccessibleBlockIds } from './bookings-today.ts'
import { type DashboardBlock } from './config.ts'

const blocks: DashboardBlock[] = [
	{ id: 'stats-1', type: 'stats' },
	{ id: 'bookings-today-1', type: 'bookings-today' },
]

describe('inaccessibleBlockIds', () => {
	it('hides a saved Bookings today block from viewers without access', () => {
		expect(inaccessibleBlockIds(blocks, { available: false })).toEqual([
			'bookings-today-1',
		])
	})

	it('hides nothing while the viewer has access', () => {
		expect(inaccessibleBlockIds(blocks, { available: true })).toEqual([])
	})
})
