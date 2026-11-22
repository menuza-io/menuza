import { z } from 'zod'
import { PHOTO_TEST_KEY_PATTERN } from './photo-test-key.ts'
import { PHOTO_TEST_MAX_BATCH } from './photo-test.ts'

/**
 * The counter beacon of a dish photo test (#192): `POST /forms/dish-photo-events`
 * from the visitor's browser to the regional tenant-api. Ids and two words
 * only; the anonymous client id never leaves the browser.
 */

export const PHOTO_TEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,40}$/

/**
 * At most this many distinct (day, test, dish, photo) rows per organization
 * per day. A key past the cap is dropped silently; a key already counted keeps
 * counting. 20 tests x 2 photos is 40 rows a day, so this is only an abuse cap.
 */
export const PHOTO_TEST_MAX_DAILY_ROWS = 2000

/**
 * The most views plus adds one (day, test, dish, photo) row takes. The signed
 * key is public, so anyone could replay it: past this a row stops counting.
 * It bounds how far a replay can tilt a test; 20 000 a day is far above what a
 * single dish's photo gets.
 */
export const PHOTO_TEST_MAX_ROW_COUNT = 20_000

export const photoTestEventSchema = z.strictObject({
	testId: z.string().regex(PHOTO_TEST_ID_PATTERN),
	itemId: z.string().min(1).max(100),
	variant: z.enum(['A', 'B']),
	event: z.enum(['view', 'add']),
	/** Proves the test exists: signed by the App (`photo-test-key.ts`). */
	key: z.string().regex(PHOTO_TEST_KEY_PATTERN),
})
export type PhotoTestCounterEvent = z.infer<typeof photoTestEventSchema>

export const photoTestEventsBodySchema = z.strictObject({
	slug: z.string().max(100).optional(),
	host: z.string().max(255).optional(),
	events: z.array(photoTestEventSchema).min(1).max(PHOTO_TEST_MAX_BATCH),
})
export type PhotoTestEventsBody = z.infer<typeof photoTestEventsBodySchema>

export type PhotoTestCounterDelta = {
	testId: string
	itemId: string
	variant: 'A' | 'B'
	views: number
	adds: number
}

/** Folds a batch into one delta per (test, dish, photo). Order is kept. */
export function foldPhotoTestEvents(
	events: readonly PhotoTestCounterEvent[],
): PhotoTestCounterDelta[] {
	const folded = new Map<string, PhotoTestCounterDelta>()
	for (const event of events) {
		const key = `${event.testId}\u0000${event.itemId}\u0000${event.variant}`
		let delta = folded.get(key)
		if (!delta) {
			delta = {
				testId: event.testId,
				itemId: event.itemId,
				variant: event.variant,
				views: 0,
				adds: 0,
			}
			folded.set(key, delta)
		}
		if (event.event === 'view') delta.views += 1
		else delta.adds += 1
	}
	return [...folded.values()]
}
