import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
	dailyDishKey,
	dailyDishRemaining,
	dailyDishShowsRemaining,
	dailySaleLimitForLocation,
	dailySaleLimitInputSchema,
	parseDailyDishKey,
	parseDailySaleLimit,
} from './daily-dish-limits.ts'
import { ModifierOptionInputSchema } from './menu-types.ts'

const form = z.object({ dailySaleLimit: dailySaleLimitInputSchema })

describe('daily sale limit input', () => {
	it('reads a JSON string from a form post', () => {
		const out = form.parse({
			dailySaleLimit: JSON.stringify({ limit: 20, showRemaining: true }),
		})
		expect(out.dailySaleLimit).toEqual({ limit: 20, showRemaining: true })
	})

	it('reads a parsed object (the modifier form posts nested JSON)', () => {
		const out = form.parse({ dailySaleLimit: { limit: 5 } })
		expect(out.dailySaleLimit).toEqual({ limit: 5, showRemaining: false })
	})

	it.each([undefined, null, '', '  ', 'null'])('clears on %j', (raw) => {
		expect(form.parse({ dailySaleLimit: raw }).dailySaleLimit).toBeNull()
		expect(form.parse({}).dailySaleLimit).toBeNull()
	})

	it('refuses a limit below 1, above the maximum and non-integers', () => {
		for (const bad of [0, -3, 10_001, 2.5]) {
			expect(form.safeParse({ dailySaleLimit: { limit: bad } }).success).toBe(
				false,
			)
		}
	})

	it('refuses broken JSON instead of dropping it silently', () => {
		const out = form.safeParse({ dailySaleLimit: '{not json' })
		expect(out.success).toBe(false)
	})

	it('refuses a config that sets no limit anywhere', () => {
		expect(
			form.safeParse({ dailySaleLimit: { limit: null, byLocation: {} } })
				.success,
		).toBe(false)
	})

	it('is part of the modifier option input, defaulting to no limit', () => {
		const option = ModifierOptionInputSchema.parse({ displayName: 'Dessert' })
		expect(option.dailySaleLimit).toBeNull()
		const limited = ModifierOptionInputSchema.parse({
			displayName: 'Dessert',
			dailySaleLimit: { limit: 12 },
		})
		expect(limited.dailySaleLimit?.limit).toBe(12)
	})
})

describe('per-location limit', () => {
	const config = parseDailySaleLimit({
		limit: 20,
		byLocation: { a: 8, b: null },
	})

	it('uses the location override, a null override lifts the limit', () => {
		expect(dailySaleLimitForLocation(config, 'a')).toBe(8)
		expect(dailySaleLimitForLocation(config, 'b')).toBeNull()
		expect(dailySaleLimitForLocation(config, 'c')).toBe(20)
		expect(dailySaleLimitForLocation(null, 'a')).toBeNull()
	})

	it('allows a location-only limit with no organization default', () => {
		const only = parseDailySaleLimit({ limit: null, byLocation: { a: 3 } })
		expect(dailySaleLimitForLocation(only, 'a')).toBe(3)
		expect(dailySaleLimitForLocation(only, 'z')).toBeNull()
	})
})

describe('keys and remaining', () => {
	it('round-trips counter keys', () => {
		expect(parseDailyDishKey(dailyDishKey('item', 'abc'))).toEqual({
			kind: 'item',
			id: 'abc',
		})
		expect(parseDailyDishKey(dailyDishKey('option', 'a:b'))).toEqual({
			kind: 'option',
			id: 'a:b',
		})
		expect(parseDailyDishKey('nope')).toBeNull()
		expect(parseDailyDishKey('menu:abc')).toBeNull()
	})

	it('counts the cap plus top-ups minus sold and held, never below zero', () => {
		expect(
			dailyDishRemaining({
				limit: 20,
				toppedUpUnits: 5,
				soldUnits: 18,
				heldUnits: 2,
			}),
		).toBe(5)
		expect(
			dailyDishRemaining({
				limit: 20,
				toppedUpUnits: 0,
				soldUnits: 25,
				heldUnits: 0,
			}),
		).toBe(0)
		expect(
			dailyDishRemaining({
				limit: 20,
				toppedUpUnits: -5,
				soldUnits: 10,
				heldUnits: 0,
			}),
		).toBe(5)
	})

	it('shows "only N left" only when enabled, positive and low', () => {
		expect(dailyDishShowsRemaining({ showRemaining: true, remaining: 3 })).toBe(
			true,
		)
		expect(dailyDishShowsRemaining({ showRemaining: true, remaining: 6 })).toBe(
			false,
		)
		expect(dailyDishShowsRemaining({ showRemaining: true, remaining: 0 })).toBe(
			false,
		)
		expect(
			dailyDishShowsRemaining({ showRemaining: false, remaining: 3 }),
		).toBe(false)
	})
})
