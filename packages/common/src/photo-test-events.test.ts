import { describe, expect, it } from 'vitest'
import {
	foldPhotoTestEvents,
	photoTestEventsBodySchema,
	PHOTO_TEST_MAX_DAILY_ROWS,
} from './photo-test-events.ts'

const event = {
	testId: 'test_abcd1234',
	itemId: 'dish-1',
	variant: 'A',
	event: 'view',
	key: 'k'.repeat(32),
} as const

describe('photoTestEventsBodySchema', () => {
	it('needs the key the App signed', () => {
		const { key: _key, ...noKey } = event
		expect(
			photoTestEventsBodySchema.safeParse({ events: [noKey] }).success,
		).toBe(false)
		expect(
			photoTestEventsBodySchema.safeParse({ events: [{ ...event, key: 'x' }] })
				.success,
		).toBe(false)
	})

	it('accepts one event and the slug and host hints', () => {
		expect(
			photoTestEventsBodySchema.safeParse({
				slug: 'acme',
				host: 'acme.example',
				events: [event],
			}).success,
		).toBe(true)
	})

	it('refuses an empty batch and one over 50 events', () => {
		expect(photoTestEventsBodySchema.safeParse({ events: [] }).success).toBe(
			false,
		)
		expect(
			photoTestEventsBodySchema.safeParse({
				events: Array.from({ length: 50 }, () => event),
			}).success,
		).toBe(true)
		expect(
			photoTestEventsBodySchema.safeParse({
				events: Array.from({ length: 51 }, () => event),
			}).success,
		).toBe(false)
	})

	it('is strict: unknown keys anywhere are refused', () => {
		expect(
			photoTestEventsBodySchema.safeParse({ events: [event], visitorId: 'x' })
				.success,
		).toBe(false)
		expect(
			photoTestEventsBodySchema.safeParse({
				events: [{ ...event, clientId: 'x' }],
			}).success,
		).toBe(false)
	})

	it('refuses a bad variant, event, test id or dish id', () => {
		for (const bad of [
			{ variant: 'C' },
			{ event: 'order' },
			{ testId: 'short' },
			{ testId: 'has space in it' },
			{ itemId: '' },
			{ itemId: 'x'.repeat(101) },
		]) {
			expect(
				photoTestEventsBodySchema.safeParse({ events: [{ ...event, ...bad }] })
					.success,
			).toBe(false)
		}
	})

	it('keeps the abuse cap well above 20 tests x 2 photos a day', () => {
		expect(PHOTO_TEST_MAX_DAILY_ROWS).toBeGreaterThanOrEqual(40)
	})
})

describe('foldPhotoTestEvents', () => {
	it('adds views and adds per test, dish and photo', () => {
		const folded = foldPhotoTestEvents([
			event,
			event,
			{ ...event, event: 'add' },
			{ ...event, variant: 'B' },
			{ ...event, itemId: 'dish-2', event: 'add' },
		])
		expect(folded).toEqual([
			{
				testId: event.testId,
				itemId: 'dish-1',
				variant: 'A',
				views: 2,
				adds: 1,
			},
			{
				testId: event.testId,
				itemId: 'dish-1',
				variant: 'B',
				views: 1,
				adds: 0,
			},
			{
				testId: event.testId,
				itemId: 'dish-2',
				variant: 'A',
				views: 0,
				adds: 1,
			},
		])
	})
})
