import { describe, expect, it } from 'vitest'
import {
	forecastQuerySchema,
	laborRangeDays,
	laborRangeQuerySchema,
	laborSettingsUpdateSchema,
	LABOR_MAX_RANGE_DAYS,
	salesBulkSchema,
	salesEntryPutSchema,
	salesSourceCoversAllSales,
	salesSourceUsesOrders,
	targetColoringAllowed,
	tipPoolSettingsUpdateSchema,
} from './labor-api.ts'

describe('sales source rules', () => {
	it('only judges a target when the sales are complete', () => {
		expect(targetColoringAllowed('online_orders')).toBe(false)
		expect(targetColoringAllowed('online_only')).toBe(true)
		expect(targetColoringAllowed('manual')).toBe(true)
		expect(salesSourceCoversAllSales('online_orders')).toBe(false)
	})
	it('knows which sources read orders', () => {
		expect(salesSourceUsesOrders('online_orders')).toBe(true)
		expect(salesSourceUsesOrders('online_only')).toBe(true)
		expect(salesSourceUsesOrders('manual')).toBe(false)
	})
})

describe('laborRangeQuerySchema', () => {
	const base = { scopeId: 'loc_1', from: '2026-03-02', to: '2026-03-08' }
	it('accepts a week and counts its days', () => {
		expect(laborRangeQuerySchema.safeParse(base).success).toBe(true)
		expect(laborRangeDays('2026-03-02', '2026-03-08')).toBe(7)
		expect(laborRangeDays('2026-03-02', '2026-03-02')).toBe(1)
	})
	it('refuses a backwards, oversized, or unreal range and unknown keys', () => {
		expect(
			laborRangeQuerySchema.safeParse({ ...base, to: '2026-03-01' }).success,
		).toBe(false)
		expect(
			laborRangeQuerySchema.safeParse({ ...base, to: '2026-09-01' }).success,
		).toBe(false)
		expect(
			laborRangeQuerySchema.safeParse({ ...base, from: '2026-02-30' }).success,
		).toBe(false)
		expect(laborRangeQuerySchema.safeParse({ ...base, extra: 1 }).success).toBe(
			false,
		)
		expect(
			laborRangeQuerySchema.safeParse({ ...base, scopeId: '../x' }).success,
		).toBe(false)
	})
	it('allows exactly the maximum span', () => {
		// 2026-01-01 plus 92 days is 2026-04-03: 93 days inclusive.
		expect(LABOR_MAX_RANGE_DAYS).toBe(93)
		expect(
			laborRangeQuerySchema.safeParse({
				...base,
				from: '2026-01-01',
				to: '2026-04-03',
			}).success,
		).toBe(true)
		expect(
			laborRangeQuerySchema.safeParse({
				...base,
				from: '2026-01-01',
				to: '2026-04-04',
			}).success,
		).toBe(false)
	})
})

describe('laborSettingsUpdateSchema', () => {
	it('needs something to change and keeps standards sane', () => {
		expect(laborSettingsUpdateSchema.safeParse({ scopeId: 'l' }).success).toBe(
			false,
		)
		expect(
			laborSettingsUpdateSchema.safeParse({
				scopeId: 'l',
				salesSource: 'manual',
			}).success,
		).toBe(true)
		expect(
			laborSettingsUpdateSchema.safeParse({
				scopeId: 'l',
				salesSource: 'pos',
			}).success,
		).toBe(false)
		const ok = (v: number) =>
			laborSettingsUpdateSchema.safeParse({
				scopeId: 'l',
				ordersPerLaborHour: { cook: v },
			}).success
		expect(ok(12)).toBe(true)
		expect(ok(12.5)).toBe(true)
		expect(ok(12.55)).toBe(false)
		expect(ok(0)).toBe(false)
		expect(ok(201)).toBe(false)
		expect(ok(Number.NaN)).toBe(false)
	})
})

describe('sales entry schemas', () => {
	it('takes integer minor units in a known currency', () => {
		const base = {
			scopeId: 'l',
			date: '2026-03-02',
			netSalesMinor: 12_345,
			currency: 'USD',
		}
		expect(salesEntryPutSchema.safeParse(base).success).toBe(true)
		expect(
			salesEntryPutSchema.safeParse({ ...base, netSalesMinor: 12.5 }).success,
		).toBe(false)
		expect(
			salesEntryPutSchema.safeParse({ ...base, netSalesMinor: -1 }).success,
		).toBe(false)
		expect(
			salesEntryPutSchema.safeParse({ ...base, currency: 'EUR' }).success,
		).toBe(false)
		expect(
			salesEntryPutSchema.safeParse({ ...base, note: 'x'.repeat(201) }).success,
		).toBe(false)
	})
	it('refuses a bulk save with a repeated date, no rows, or too many', () => {
		const row = (date: string) => ({ date, netSalesMinor: 1 })
		const bulk = (entries: unknown[]) =>
			salesBulkSchema.safeParse({ scopeId: 'l', currency: 'USD', entries })
				.success
		expect(bulk([row('2026-03-02'), row('2026-03-03')])).toBe(true)
		expect(bulk([row('2026-03-02'), row('2026-03-02')])).toBe(false)
		expect(bulk([])).toBe(false)
		const many = Array.from({ length: 367 }, (_, i) =>
			row(
				`2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
			),
		)
		expect(bulk(many)).toBe(false)
	})
})

describe('tipPoolSettingsUpdateSchema', () => {
	const base = {
		scopeId: 'l',
		splitBasis: 'hours',
		cadence: 'period',
		cardFeeBp: 290,
		fulfillment: ['pickup'],
		positionPercentBp: {},
	}
	it('accepts the defaults and a capped card fee', () => {
		expect(tipPoolSettingsUpdateSchema.safeParse(base).success).toBe(true)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({ ...base, cardFeeBp: 1000 })
				.success,
		).toBe(true)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({ ...base, cardFeeBp: 1001 })
				.success,
		).toBe(false)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({ ...base, cardFeeBp: 1.5 })
				.success,
		).toBe(false)
	})
	it('lets online tips stay out entirely, but not repeat a type', () => {
		expect(
			tipPoolSettingsUpdateSchema.safeParse({ ...base, fulfillment: [] })
				.success,
		).toBe(true)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({
				...base,
				fulfillment: ['pickup', 'pickup'],
			}).success,
		).toBe(false)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({
				...base,
				fulfillment: ['dine_in'],
			}).success,
		).toBe(false)
	})
	it('needs position percentages to add up to 100 for a position split', () => {
		const split = { ...base, splitBasis: 'position_percent' }
		expect(
			tipPoolSettingsUpdateSchema.safeParse({
				...split,
				positionPercentBp: { a: 6000, b: 4000 },
			}).success,
		).toBe(true)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({
				...split,
				positionPercentBp: { a: 6000, b: 3000 },
			}).success,
		).toBe(false)
		expect(
			tipPoolSettingsUpdateSchema.safeParse({ ...split, positionPercentBp: {} })
				.success,
		).toBe(false)
		// An hours split ignores stale percentages.
		expect(
			tipPoolSettingsUpdateSchema.safeParse({
				...base,
				positionPercentBp: { a: 1 },
			}).success,
		).toBe(true)
	})
})

describe('forecastQuerySchema', () => {
	it('takes a scope and a date, nothing else', () => {
		expect(
			forecastQuerySchema.safeParse({ scopeId: 'l', date: '2026-03-02' })
				.success,
		).toBe(true)
		expect(forecastQuerySchema.safeParse({ scopeId: 'l' }).success).toBe(false)
		expect(
			forecastQuerySchema.safeParse({
				scopeId: 'l',
				date: '2026-03-02',
				x: 1,
			}).success,
		).toBe(false)
	})
})
