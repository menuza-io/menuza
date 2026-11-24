import { describe, expect, it } from 'vitest'
import {
	approveCountSchema,
	countDeviceReportSchema,
	COUNT_DEVICE_SILENT_MS,
	createCountScheduleSchema,
	isNotCountedLately,
	NOT_COUNTED_MS,
	settleSecondCheckSchema,
	skipSecondCheckSchema,
	startCountSchema,
	updateCountScheduleSchema,
	updateItemSchema,
} from '../index.ts'

describe('count controls on the wire (#490, #491, #525, #474)', () => {
	it('a count starts as a full count unless it asks for a quick one', () => {
		const base = {
			clientId: 'client-12345678',
			locationId: 'main',
			listId: null,
		}
		expect(startCountSchema.parse(base).kind).toBeUndefined()
		expect(startCountSchema.parse({ ...base, kind: 'quick' }).kind).toBe(
			'quick',
		)
		expect(
			startCountSchema.safeParse({ ...base, kind: 'weekly' }).success,
		).toBe(false)
	})

	it('validates a schedule: a time of day, weekdays in order, an assignee', () => {
		const body = {
			clientId: 'client-12345678',
			locationId: 'main',
			kind: 'quick',
			listId: null,
			slot: 'close',
			timeLocal: '22:00',
			weekdays: [5, 1, 1, 3],
			assignee: { kind: 'staff', id: 'staff_1' },
		}
		expect(createCountScheduleSchema.parse(body).weekdays).toEqual([1, 3, 5])
		for (const bad of [
			{ timeLocal: '24:00' },
			{ timeLocal: '7:30' },
			{ weekdays: [] },
			{ weekdays: [7] },
			{ slot: 'noon' },
			{ assignee: { kind: 'robot', id: 'x' } },
		]) {
			expect(
				createCountScheduleSchema.safeParse({ ...body, ...bad }).success,
			).toBe(false)
		}
		expect(
			updateCountScheduleSchema.safeParse({
				expectedVersion: 2,
				assignee: null,
			}).success,
		).toBe(true)
	})

	it('reports a device with what it still holds, and refuses another device id shape', () => {
		expect(
			countDeviceReportSchema.parse({ id: 'tablet-kitchen-1', unsent: 3 }),
		).toEqual({ id: 'tablet-kitchen-1', unsent: 3 })
		expect(
			countDeviceReportSchema.safeParse({ id: 'x', unsent: 3 }).success,
		).toBe(false)
		expect(
			countDeviceReportSchema.safeParse({ id: 'tablet-1234', unsent: -1 })
				.success,
		).toBe(false)
		expect(COUNT_DEVICE_SILENT_MS).toBe(2 * 60 * 60 * 1000)
	})

	it('approves anyway only when asked', () => {
		expect(approveCountSchema.parse({ expectedVersion: 1 }).approveAnyway).toBe(
			false,
		)
		expect(
			approveCountSchema.parse({ expectedVersion: 1, approveAnyway: true })
				.approveAnyway,
		).toBe(true)
	})

	it('settles with the first or the second figure, and skips only with a reason', () => {
		expect(
			settleSecondCheckSchema.safeParse({
				expectedVersion: 1,
				resolutions: { item_1: 'second' },
			}).success,
		).toBe(true)
		expect(
			settleSecondCheckSchema.safeParse({
				expectedVersion: 1,
				resolutions: { item_1: 'both' },
			}).success,
		).toBe(false)
		expect(
			settleSecondCheckSchema.safeParse({ expectedVersion: 1, resolutions: {} })
				.success,
		).toBe(false)
		expect(
			skipSecondCheckSchema.safeParse({ expectedVersion: 1, reason: 'no' })
				.success,
		).toBe(false)
		expect(
			skipSecondCheckSchema.safeParse({
				expectedVersion: 1,
				reason: 'Nobody else is in',
			}).success,
		).toBe(true)
	})

	it('stars an item and gives it a bottle, never half a bottle spec', () => {
		expect(
			updateItemSchema.safeParse({ expectedVersion: 1, isKey: true }).success,
		).toBe(true)
		expect(
			updateItemSchema.safeParse({
				expectedVersion: 1,
				bottle: { sizeMl: 700, fullWeightG: 1300, emptyWeightG: 500 },
			}).success,
		).toBe(true)
		expect(
			updateItemSchema.safeParse({ expectedVersion: 1, bottle: null }).success,
		).toBe(true)
		expect(
			updateItemSchema.safeParse({
				expectedVersion: 1,
				bottle: { sizeMl: 0, fullWeightG: null, emptyWeightG: null },
			}).success,
		).toBe(false)
	})

	it('counts an item as not counted lately after 14 days, or never', () => {
		const now = 100 * 24 * 60 * 60 * 1000
		expect(isNotCountedLately(null, now)).toBe(true)
		expect(isNotCountedLately(now - NOT_COUNTED_MS, now)).toBe(false)
		expect(isNotCountedLately(now - NOT_COUNTED_MS - 1, now)).toBe(true)
		expect(isNotCountedLately(now - 1000, now)).toBe(false)
	})
})
