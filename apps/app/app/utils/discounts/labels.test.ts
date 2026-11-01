import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	amountEach,
	ANNOUNCE,
	discountDisplayState,
	appliesSummary,
	listText,
	localNowText,
	percentText,
	perCustomerSummary,
	type Translate,
	valueSummary,
	whenSummary,
	zonedNowText,
} from './labels.ts'

beforeAll(() => {
	i18n.loadAndActivate({ locale: 'en', messages: {} })
})

const tx: Translate = (descriptor) => i18n._(descriptor)

const OPEN = {
	status: 'active',
	startsAt: null,
	endsAt: null,
	totalLimit: null,
	uses: 0,
}

describe('discountDisplayState', () => {
	it('keeps a paused or archived status as it is', () => {
		expect(
			discountDisplayState(
				{ ...OPEN, status: 'paused', endsAt: '2020-01-01T00:00' },
				'2026-11-01T10:00',
			),
		).toBe('paused')
		expect(discountDisplayState({ ...OPEN, status: 'archived' }, null)).toBe(
			'archived',
		)
	})

	it('shows an active discount past its end as ended', () => {
		expect(
			discountDisplayState(
				{ ...OPEN, endsAt: '2026-10-31T23:59' },
				'2026-11-01T00:00',
			),
		).toBe('ended')
		// The end is exclusive: at the end minute itself the discount is over.
		expect(
			discountDisplayState(
				{ ...OPEN, endsAt: '2026-11-01T00:00' },
				'2026-11-01T00:00',
			),
		).toBe('ended')
		expect(
			discountDisplayState(
				{ ...OPEN, endsAt: '2026-11-01T00:01' },
				'2026-11-01T00:00',
			),
		).toBe('active')
	})

	it('shows an active discount that has not started as scheduled', () => {
		expect(
			discountDisplayState(
				{ ...OPEN, startsAt: '2026-11-02T00:00' },
				'2026-11-01T10:00',
			),
		).toBe('scheduled')
	})

	it('shows a discount that used up its limit as limit reached', () => {
		expect(
			discountDisplayState({ ...OPEN, totalLimit: 10, uses: 10 }, null),
		).toBe('limit_reached')
		expect(
			discountDisplayState({ ...OPEN, totalLimit: 10, uses: 9 }, null),
		).toBe('active')
	})

	it('does not judge a lifetime limit by a count for a date range', () => {
		expect(
			discountDisplayState({ ...OPEN, totalLimit: 10, uses: null }, null),
		).toBe('active')
	})

	it('waits for the clock before judging dates', () => {
		expect(
			discountDisplayState({ ...OPEN, endsAt: '2020-01-01T00:00' }, null),
		).toBe('active')
	})

	it('judges the dates in every zone the discount runs in', () => {
		const ends = { ...OPEN, endsAt: '2026-11-01T01:00' }
		// Ended in one zone but still open in another: not ended.
		expect(
			discountDisplayState(ends, ['2026-11-01T02:00', '2026-10-31T23:00']),
		).toBe('active')
		expect(
			discountDisplayState(ends, ['2026-11-01T02:00', '2026-11-01T03:00']),
		).toBe('ended')
		const starts = { ...OPEN, startsAt: '2026-11-01T09:00' }
		expect(
			discountDisplayState(starts, ['2026-11-01T08:00', '2026-11-01T10:00']),
		).toBe('active')
		expect(
			discountDisplayState(starts, ['2026-11-01T08:00', '2026-11-01T07:00']),
		).toBe('scheduled')
	})

	it('reads the clock in a location time zone', () => {
		const instant = new Date('2026-11-01T12:30:00Z')
		expect(zonedNowText(instant, 'UTC')).toBe('2026-11-01T12:30')
		expect(zonedNowText(instant, 'Asia/Riyadh')).toBe('2026-11-01T15:30')
		expect(zonedNowText(instant, 'Not/AZone')).toBeNull()
		// Midnight is 00, never 24.
		expect(zonedNowText(new Date('2026-11-01T00:05:00Z'), 'UTC')).toBe(
			'2026-11-01T00:05',
		)
	})

	it('reads the clock as a local date-time', () => {
		expect(localNowText(new Date(2026, 10, 1, 9, 5))).toBe('2026-11-01T09:05')
	})
})

describe('whenSummary', () => {
	it('shows times, so midnight is not read as a whole day', () => {
		const text = whenSummary(
			{
				schedule: null,
				startsAt: '2026-11-01T10:00',
				endsAt: '2026-11-30T00:00',
			},
			tx,
			'en',
		)
		expect(text).toContain('10:00')
		expect(text).toMatch(/12:00\sAM/)
		expect(text).toContain('Nov 30')
	})

	it('says always when nothing limits it', () => {
		expect(
			whenSummary({ schedule: null, startsAt: null, endsAt: null }, tx, 'en'),
		).toBe('Always')
	})
})

describe('valueSummary and each', () => {
	const fixed = {
		valueType: 'fixed' as const,
		percentBp: null,
		amountMinor: 500,
		currency: 'USD',
		maxDiscountMinor: null,
	}

	it('says each where an amount comes off every item', () => {
		expect(valueSummary(fixed, tx, 'en', 'USD', 'item')).toBe(
			'$5.00 off each item',
		)
		expect(valueSummary(fixed, tx, 'en', 'USD', null)).toBe('$5.00 off')
		expect(
			valueSummary(
				{ ...fixed, valueType: 'percent', percentBp: 1000, amountMinor: null },
				tx,
				'en',
				'USD',
				'item',
			),
		).toBe('10% off')
	})

	it('knows which scopes take an amount off each', () => {
		expect(amountEach('order', 'none')).toBeNull()
		expect(amountEach('items', 'none')).toBe('item')
		expect(amountEach('categories', 'minimum')).toBe('item')
		expect(amountEach('modifiers', 'per_item')).toBe('choice')
		expect(amountEach('order', 'buy_get')).toBe('got_item')
		expect(amountEach('order', 'bundle')).toBe('deal')
	})
})

describe('locale formatting', () => {
	it('prints a percentage with the digits and sign of the language', () => {
		expect(percentText(1000, 'en')).toBe('10%')
		expect(percentText(1250, 'en')).toBe('12.5%')
		// Egyptian Arabic uses Arabic-Indic digits and the Arabic percent sign.
		expect(percentText(1000, 'ar-EG')).toContain('١٠')
		expect(percentText(1000, 'ar-EG')).not.toContain('%')
	})

	it('joins a list with the separator of the language', () => {
		expect(listText(['Pizza', 'Wings'], 'en')).toBe('Pizza, Wings')
		// Arabic joins with its own conjunction, not an ASCII comma.
		expect(listText(['Pizza', 'Wings'], 'ar')).not.toContain(',')
		expect(listText(['A', 'B', 'C'], 'ar')).toContain('،')
		expect(listText([], 'en')).toBe('')
	})
})

describe('plural phrases', () => {
	const bundle = (quantity: number) => ({
		target: {
			scope: 'order' as const,
			itemIds: [],
			categoryIds: [],
			excludeItemIds: [],
			excludeCategoryIds: [],
		},
		valueType: 'percent' as const,
		quantityRule: {
			kind: 'bundle' as const,
			slots: [{ quantity, itemIds: ['a'], categoryIds: [] }],
		},
	})

	it('never says "1 items" for a meal deal', () => {
		expect(appliesSummary(bundle(1) as never, tx)).toBe('Meal deal of 1 item')
		expect(appliesSummary(bundle(3) as never, tx)).toBe('Meal deal of 3 items')
	})
})

describe('per customer and announcements', () => {
	it('words the per-customer limit with a plural and a period', () => {
		expect(perCustomerSummary({ count: 1, period: 'day' }, tx)).toBe(
			'1 use per customer per day',
		)
		expect(perCustomerSummary({ count: 3, period: 'lifetime' }, tx)).toBe(
			'3 uses per customer in total',
		)
	})

	it('never says "1 codes", "1 tiers" or "1 groups"', () => {
		expect(ANNOUNCE.codeAdded(1, tx)).toBe('Code added. 1 code.')
		expect(ANNOUNCE.codeAdded(2, tx)).toBe('Code added. 2 codes.')
		expect(ANNOUNCE.codeRemoved(1, tx)).toBe('Code removed. 1 code left.')
		expect(ANNOUNCE.singleUseAdded(1, 1, tx)).toBe(
			'1 single-use code added. 1 code in all.',
		)
		expect(ANNOUNCE.singleUseAdded(10, 12, tx)).toBe(
			'10 single-use codes added. 12 codes in all.',
		)
		expect(ANNOUNCE.tierAdded(1, tx)).toBe('Tier added. 1 tier.')
		expect(ANNOUNCE.tierRemoved(3, tx)).toBe('Tier removed. 3 tiers.')
		expect(ANNOUNCE.groupAdded(1, tx)).toBe('Group added. 1 group.')
		expect(ANNOUNCE.groupRemoved(0, tx)).toBe('Group removed. 0 groups.')
	})
})
