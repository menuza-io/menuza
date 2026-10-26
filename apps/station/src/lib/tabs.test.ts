import { describe, expect, it } from 'vitest'
import { type PosOrder } from './db.ts'
import { tabForTable, tableKey } from './tabs.ts'

const tab = (over: Partial<PosOrder>): PosOrder =>
	({
		id: 'tab',
		status: 'open',
		orderType: 'dine_in',
		tableLabel: '12',
		transferredTo: null,
		payments: [],
		lines: [],
		locationId: 'loc',
		origin: 'demo-place',
		...over,
	}) as PosOrder

describe('one tab per table', () => {
	it('reads a table label the way people type it', () => {
		expect(
			['12', ' Table 12 ', 't12', 'T-12', 'tbl #12'].map(tableKey),
		).toEqual(['12', '12', '12', '12', '12'])
		expect(tableKey('Patio 3')).toBe('patio 3')
		expect(tableKey('Terrace 3')).toBe('terrace 3')
		expect(tableKey('')).toBe('')
	})

	it('finds the open dine-in tab for the same table, and nothing else', () => {
		const tabs = [
			tab({ id: 'paid', status: 'paid' }),
			tab({ id: 'takeaway', orderType: 'takeaway' }),
			tab({ id: 'moved', transferredTo: 'T2' }),
			tab({ id: 'other', tableLabel: '14' }),
			tab({ id: 'this', tableLabel: 'Table 12' }),
		]
		expect(tabForTable(tabs, '12')?.id).toBe('this')
		expect(tabForTable(tabs, '12', { except: 'this' })).toBeNull()
		expect(tabForTable(tabs, '')).toBeNull()
		expect(tabForTable(tabs, '13')).toBeNull()
	})
})

describe('a tab this order could not join', () => {
	it('is passed over: part paid, another location, or another restaurant', () => {
		const paid = tab({
			id: 'paid',
			payments: [{ id: 'p' } as PosOrder['payments'][number]],
		})
		expect(tabForTable([paid], '12')).toBeNull()
		const here = { locationId: 'loc', origin: 'demo-place' }
		expect(tabForTable([tab({ locationId: 'other' })], '12', here)).toBeNull()
		expect(tabForTable([tab({ origin: '@demo' })], '12', here)).toBeNull()
		expect(tabForTable([tab({})], '12', here)?.id).toBe('tab')
		// Saved before orders carried their restaurant: taken here.
		expect(tabForTable([tab({ origin: undefined })], '12', here)?.id).toBe(
			'tab',
		)
	})

	it('is offered only with room for what would join it', () => {
		const long = tab({
			lines: Array.from(
				{ length: 48 },
				() => ({}) as PosOrder['lines'][number],
			),
		})
		expect(tabForTable([long], '12', { adding: 2 })?.id).toBe('tab')
		expect(tabForTable([long], '12', { adding: 3 })).toBeNull()
	})
})
