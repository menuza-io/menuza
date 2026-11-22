import { describe, expect, it } from 'vitest'
import {
	addDays,
	AUTO_SCHEDULE_LEAD_DAYS,
	getOccasion,
	nthWeekdayOfMonth,
	occasionCopy,
	occasionDates,
	OCCASION_KEYS,
	OCCASION_NAMES,
	OCCASION_TITLES,
	OCCASIONS,
	occasionsBetween,
	occasionsForMarket,
	resolveOccasionMarket,
	suggestedOccasions,
} from './occasions.ts'
import { SITE_CONTENT_LOCALES } from '@repo/common/site-locales'

const dates = (key: string, year: number) =>
	occasionDates(getOccasion(key)!, year).map((entry) => entry.date)

describe('the catalogue', () => {
	it("lists the issue's US and KSA occasions, each once", () => {
		expect(occasionsForMarket('us').map((o) => o.key)).toEqual([
			'us_new_year',
			'us_valentines_day',
			'us_super_bowl',
			'us_st_patricks_day',
			'us_mothers_day',
			'us_fathers_day',
			'us_independence_day',
			'us_labor_day',
			'us_halloween',
			'us_thanksgiving',
			'us_christmas',
		])
		expect(occasionsForMarket('ksa').map((o) => o.key)).toEqual([
			'ksa_ramadan_start',
			'ksa_last_ten_nights',
			'ksa_eid_al_fitr',
			'ksa_eid_al_adha',
			'ksa_founding_day',
			'ksa_national_day',
		])
		expect(new Set(OCCASIONS.map((o) => o.key)).size).toBe(OCCASIONS.length)
		expect(OCCASIONS.map((o) => o.key).sort()).toEqual(
			[...OCCASION_KEYS].sort(),
		)
	})

	it('has a name, a title and ready-made words in every site language', () => {
		for (const key of OCCASION_KEYS) {
			for (const locale of SITE_CONTENT_LOCALES) {
				expect(OCCASION_NAMES[key][locale], `${key} ${locale}`).toBeTruthy()
				expect(OCCASION_TITLES[key][locale], `${key} ${locale}`).toBeTruthy()
				const copy = occasionCopy(key, locale, {
					restaurant: 'Casa Verde',
					link: 'https://casa-verde.menuza.site/menu',
				})
				for (const text of [
					copy.subject,
					copy.headline,
					copy.body,
					copy.sms,
					copy.social,
					copy.buttonLabel,
				]) {
					expect(text).toBeTruthy()
					// Every placeholder was filled.
					expect(text).not.toMatch(/\{\w+\}/)
				}
				expect(copy.sms).toContain('Casa Verde')
				expect(copy.sms).toContain('https://casa-verde.menuza.site/menu')
			}
		}
	})
})

describe('moving US holidays', () => {
	it.each([
		['us_thanksgiving', 2026, '2026-11-26'],
		['us_thanksgiving', 2027, '2027-11-25'],
		['us_mothers_day', 2026, '2026-05-10'],
		['us_mothers_day', 2027, '2027-05-09'],
		['us_fathers_day', 2026, '2026-06-21'],
		['us_labor_day', 2026, '2026-09-07'],
		['us_labor_day', 2027, '2027-09-06'],
		['us_super_bowl', 2026, '2026-02-08'],
		['us_super_bowl', 2027, '2027-02-14'],
	])('%s in %i is %s', (key, year, date) => {
		expect(dates(key, year)).toEqual([date])
	})

	it('fixed days do not move, and only the game day is marked expected', () => {
		expect(dates('us_valentines_day', 2026)).toEqual(['2026-02-14'])
		expect(dates('us_christmas', 2030)).toEqual(['2030-12-25'])
		expect(dates('us_independence_day', 2026)).toEqual(['2026-07-04'])
		const expected = OCCASIONS.filter((o) =>
			occasionDates(o, 2026).some((d) => d.expected),
		).map((o) => o.key)
		expect(expected).toEqual([
			'us_super_bowl',
			'ksa_ramadan_start',
			'ksa_last_ten_nights',
			'ksa_eid_al_fitr',
			'ksa_eid_al_adha',
		])
	})

	it('nthWeekdayOfMonth', () => {
		expect(nthWeekdayOfMonth(2026, 11, 4, 4)).toBe('2026-11-26')
		expect(nthWeekdayOfMonth(2026, 3, 0, 1)).toBe('2026-03-01')
	})
})

describe('Hijri occasions (Umm al-Qura, expected)', () => {
	it('are computed from the Hijri calendar and are always marked expected', () => {
		expect(dates('ksa_ramadan_start', 2026)).toEqual(['2026-02-18'])
		expect(dates('ksa_last_ten_nights', 2026)).toEqual(['2026-03-10'])
		expect(dates('ksa_eid_al_fitr', 2026)).toEqual(['2026-03-20'])
		expect(dates('ksa_eid_al_adha', 2026)).toEqual(['2026-05-27'])
		for (const key of [
			'ksa_ramadan_start',
			'ksa_eid_al_fitr',
			'ksa_eid_al_adha',
		]) {
			for (const entry of occasionDates(getOccasion(key)!, 2026)) {
				expect(entry.expected).toBe(true)
			}
		}
	})

	it('shift about 11 days earlier each year, and can fall twice in a Gregorian year', () => {
		expect(dates('ksa_ramadan_start', 2027)).toEqual(['2027-02-08'])
		expect(dates('ksa_ramadan_start', 2028)).toEqual(['2028-01-28'])
		// Ramadan 1 fell on 2030-01-05 and again on 2030-12-26.
		expect(dates('ksa_ramadan_start', 2030)).toHaveLength(2)
	})

	it('fixed KSA days are fixed', () => {
		expect(dates('ksa_founding_day', 2026)).toEqual(['2026-02-22'])
		expect(dates('ksa_national_day', 2026)).toEqual(['2026-09-23'])
		expect(
			occasionDates(getOccasion('ksa_national_day')!, 2026)[0]!.expected,
		).toBe(false)
	})
})

describe('what to suggest', () => {
	it("lists the market's occasions four weeks ahead, soonest first, with the recommended send date", () => {
		const list = suggestedOccasions('us', '2026-04-20')
		expect(list.map((o) => [o.key, o.date])).toEqual([
			['us_mothers_day', '2026-05-10'],
		])
		expect(list[0]!.sendDate).toBe(addDays('2026-05-10', -10))
		expect(suggestedOccasions('us', '2026-04-01').map((o) => o.key)).toEqual([])
	})

	it('crosses a year end', () => {
		expect(
			occasionsBetween('us', '2026-12-10', '2027-01-10').map((o) => [
				o.key,
				o.date,
			]),
		).toEqual([
			['us_christmas', '2026-12-25'],
			['us_new_year', '2027-01-01'],
		])
	})

	it('KSA shows the Hijri occasions with their expected dates', () => {
		const list = suggestedOccasions('ksa', '2026-02-01')
		expect(list.map((o) => [o.key, o.date, o.expected])).toEqual([
			['ksa_ramadan_start', '2026-02-18', true],
			['ksa_founding_day', '2026-02-22', false],
		])
	})

	it('auto-schedule works 14 days ahead of the day, ahead of the recommended send', () => {
		expect(AUTO_SCHEDULE_LEAD_DAYS).toBe(14)
		for (const occasion of OCCASIONS) {
			expect(occasion.sendLeadDays).toBeLessThanOrEqual(AUTO_SCHEDULE_LEAD_DAYS)
		}
	})
})

describe('the market', () => {
	it('follows the data region, and an override wins', () => {
		expect(resolveOccasionMarket({ dataRegion: 'ksa' })).toBe('ksa')
		expect(resolveOccasionMarket({ dataRegion: 'us' })).toBe('us')
		expect(resolveOccasionMarket({})).toBe('us')
		expect(resolveOccasionMarket({ dataRegion: 'us', override: 'ksa' })).toBe(
			'ksa',
		)
		expect(
			resolveOccasionMarket({ dataRegion: 'ksa', override: 'nonsense' }),
		).toBe('ksa')
	})
})
