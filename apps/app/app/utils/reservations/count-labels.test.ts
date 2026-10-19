import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeDayFeedResponse } from './book-api.ts'
import {
	guestsCountLabel,
	guestsRangeLabel,
	inNextMinutesLabel,
	partiesLabel,
	tablesActiveLabel,
	unassignedAndConflictsLabel,
} from './count-labels.ts'

/** What tenant-api's day feed sends today: no `totalParties`, `seatedParties`, ... */
const SERVER_DAY = {
	locationId: 'loc_1',
	businessDate: '2026-10-18',
	stats: {
		totalReservations: 5,
		totalCovers: 18,
		seatedCovers: 4,
		unassignedCount: 1,
	},
	reservations: [],
}

describe.each(['en', 'ar'])(
	'KPI numbers with the %s locale active',
	(locale) => {
		beforeAll(() => {
			i18n.load(locale, {})
			i18n.activate(locale)
		})

		it('keeps the real numbers in each label as one string', () => {
			expect(partiesLabel(5)).toContain('5')
			expect(inNextMinutesLabel(3)).toContain('3')
			expect(tablesActiveLabel(4)).toContain('4')
			const attention = unassignedAndConflictsLabel(2, 7)
			expect(attention).toContain('2')
			expect(attention).toContain('7')
			expect(guestsCountLabel(18)).toBe('18 guests')
			expect(guestsRangeLabel(2, 6)).toBe('2-6 guests')
			expect(guestsRangeLabel(4, 4)).toBe('4 guests')
		})

		it('renders the Today KPIs from the real day feed, not zeros', () => {
			const stats = normalizeDayFeedResponse(SERVER_DAY).stats
			expect(stats.totalCovers).toBe(18)
			expect(stats.seatedCovers).toBe(4)
			expect(stats.totalParties).toBe(5)
			expect(partiesLabel(stats.totalParties)).toContain('5')
			expect(partiesLabel(stats.totalParties)).not.toMatch(/(^|\D)0(\D|$)/)
			expect(
				unassignedAndConflictsLabel(stats.unassignedCount, stats.conflictCount),
			).toContain('1')
		})
	},
)
