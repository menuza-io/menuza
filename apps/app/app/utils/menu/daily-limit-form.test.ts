import {
	DAILY_DISH_MAX_UNITS,
	dailySaleLimitSchema,
	parseDailySaleLimit,
} from '@repo/common/daily-dish-limits'
import { describe, expect, it } from 'vitest'
import {
	dailyLimitFormErrors,
	dailyLimitFormFromConfig,
	dailyLimitFormToConfig,
	dailyLimitFormToJson,
	emptyDailyLimitForm,
	parseDailyLimitUnits,
} from './daily-limit-form.ts'

describe('parseDailyLimitUnits', () => {
	it('reads a whole number from 1 to the largest limit', () => {
		expect(parseDailyLimitUnits('20')).toBe(20)
		expect(parseDailyLimitUnits(' 7 ')).toBe(7)
		expect(parseDailyLimitUnits(String(DAILY_DISH_MAX_UNITS))).toBe(
			DAILY_DISH_MAX_UNITS,
		)
	})

	it.each([
		'',
		'0',
		'-3',
		'2.5',
		'abc',
		'1e3',
		String(DAILY_DISH_MAX_UNITS + 1),
	])('refuses %j', (text) => {
		expect(parseDailyLimitUnits(text)).toBeNull()
	})
})

describe('dailyLimitFormFromConfig', () => {
	it('is an empty form without a limit', () => {
		expect(dailyLimitFormFromConfig(null)).toEqual(emptyDailyLimitForm())
		expect(dailyLimitFormFromConfig(undefined)).toEqual(emptyDailyLimitForm())
	})

	it('shows the limit, the setting and each location choice', () => {
		const form = dailyLimitFormFromConfig(
			parseDailySaleLimit({
				limit: 20,
				showRemaining: true,
				byLocation: { a: 8, b: null },
			}),
		)
		expect(form).toEqual({
			limit: '20',
			showRemaining: true,
			byLocation: {
				a: { mode: 'limit', limit: '8' },
				b: { mode: 'none', limit: '' },
			},
		})
	})

	it('shows a limit that only some locations have as an empty organization limit', () => {
		const form = dailyLimitFormFromConfig(
			parseDailySaleLimit({ limit: null, byLocation: { a: 3 } }),
		)
		expect(form.limit).toBe('')
		expect(form.byLocation.a).toEqual({ mode: 'limit', limit: '3' })
	})
})

describe('dailyLimitFormToConfig', () => {
	it('round-trips every shape the server accepts', () => {
		for (const raw of [
			{ limit: 20, showRemaining: false },
			{ limit: 20, showRemaining: true },
			{ limit: 20, showRemaining: false, byLocation: { a: 8, b: null } },
			{ limit: null, showRemaining: true, byLocation: { a: 3 } },
		]) {
			const config = parseDailySaleLimit(raw)!
			expect(dailyLimitFormToConfig(dailyLimitFormFromConfig(config))).toEqual(
				config,
			)
		}
	})

	it('is no limit when nothing is set, so the stored limit is cleared', () => {
		expect(dailyLimitFormToConfig(emptyDailyLimitForm())).toBeNull()
		expect(dailyLimitFormToJson(emptyDailyLimitForm())).toBe('')
	})

	it('treats "no limit here" everywhere with no limit above as no limit at all', () => {
		const form = {
			...emptyDailyLimitForm(),
			byLocation: { a: { mode: 'none' as const, limit: '' } },
		}
		expect(dailyLimitFormToConfig(form)).toBeNull()
	})

	it("leaves out a location that is not the organization's any more", () => {
		const form = {
			...emptyDailyLimitForm(),
			limit: '10',
			byLocation: { gone: { mode: 'limit' as const, limit: '2' } },
		}
		expect(dailyLimitFormToConfig(form, ['a', 'b'])).toEqual({
			limit: 10,
			showRemaining: false,
		})
	})

	it('produces JSON the server schema accepts', () => {
		const json = dailyLimitFormToJson({
			limit: '20',
			showRemaining: true,
			byLocation: { a: { mode: 'limit', limit: '5' } },
		})
		expect(dailySaleLimitSchema.safeParse(JSON.parse(json)).success).toBe(true)
	})
})

describe('invalid input fails the save instead of clearing the limit', () => {
	it('flags a typed limit that is not a whole number in range', () => {
		const state = { ...emptyDailyLimitForm(), limit: '2.5' }
		expect(dailyLimitFormErrors(state)).toEqual({ limit: true, locations: [] })
	})

	it('flags a location whose own limit is not valid', () => {
		const state = {
			...emptyDailyLimitForm(),
			byLocation: { a: { mode: 'limit' as const, limit: 'x' } },
		}
		expect(dailyLimitFormErrors(state)).toEqual({
			limit: false,
			locations: ['a'],
		})
	})

	it('posts a limit of 0, which the server refuses, while an entry is invalid', () => {
		const json = dailyLimitFormToJson({
			...emptyDailyLimitForm(),
			limit: 'abc',
		})
		expect(json).not.toBe('')
		expect(dailySaleLimitSchema.safeParse(JSON.parse(json)).success).toBe(false)
	})

	it('has no error for an empty or a valid form', () => {
		expect(dailyLimitFormErrors(emptyDailyLimitForm())).toEqual({
			limit: false,
			locations: [],
		})
		expect(
			dailyLimitFormErrors({ ...emptyDailyLimitForm(), limit: '12' }).limit,
		).toBe(false)
	})
})
