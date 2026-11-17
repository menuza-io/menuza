import { DAILY_DISH_MAX_UNITS } from '@repo/common/daily-dish-limits'
import { describe, expect, it } from 'vitest'
import {
	dailyLimitAllowance,
	parseDailyLimitTopUpForm,
} from './daily-limit-top-up.ts'

const base = { locationId: 'loc_1', key: 'item:abc' }

describe('parseDailyLimitTopUpForm', () => {
	it('reads an add', () => {
		expect(parseDailyLimitTopUpForm({ ...base, addUnits: '5' })).toEqual({
			ok: true,
			data: { ...base, change: { addUnits: 5 } },
		})
	})

	it('reads an amount left, including 0', () => {
		expect(parseDailyLimitTopUpForm({ ...base, amountLeft: '0' })).toEqual({
			ok: true,
			data: { ...base, change: { amountLeft: 0 } },
		})
		expect(
			parseDailyLimitTopUpForm({ ...base, amountLeft: '12' }),
		).toMatchObject({
			ok: true,
			data: { change: { amountLeft: 12 } },
		})
	})

	it('reads an option key as well as a dish key', () => {
		expect(
			parseDailyLimitTopUpForm({ ...base, key: 'option:o1', addUnits: '10' }),
		).toMatchObject({ ok: true })
	})

	it.each([
		['neither', {}],
		['both', { addUnits: '5', amountLeft: '3' }],
		['an add of 0', { addUnits: '0' }],
		['a negative add', { addUnits: '-5' }],
		['a fraction', { addUnits: '2.5' }],
		['text', { addUnits: 'ten' }],
		['too many', { amountLeft: String(DAILY_DISH_MAX_UNITS + 1) }],
	])('refuses %s', (_name, extra) => {
		expect(parseDailyLimitTopUpForm({ ...base, ...extra })).toEqual({
			ok: false,
		})
	})

	it('refuses a missing location, a missing key and a key that is not a limit key', () => {
		expect(parseDailyLimitTopUpForm({ key: base.key, addUnits: '5' })).toEqual({
			ok: false,
		})
		expect(
			parseDailyLimitTopUpForm({ locationId: base.locationId, addUnits: '5' }),
		).toEqual({ ok: false })
		expect(
			parseDailyLimitTopUpForm({ ...base, key: 'menu:abc', addUnits: '5' }),
		).toEqual({ ok: false })
	})

	it('treats an empty field as not sent', () => {
		expect(
			parseDailyLimitTopUpForm({ ...base, addUnits: '', amountLeft: '4' }),
		).toMatchObject({ ok: true, data: { change: { amountLeft: 4 } } })
	})
})

describe('dailyLimitAllowance', () => {
	it('is the limit plus what a manager added or took away, never below 0', () => {
		expect(dailyLimitAllowance({ limit: 20, toppedUpUnits: 5 })).toBe(25)
		expect(dailyLimitAllowance({ limit: 20, toppedUpUnits: -8 })).toBe(12)
		expect(dailyLimitAllowance({ limit: 20, toppedUpUnits: -50 })).toBe(0)
	})
})
