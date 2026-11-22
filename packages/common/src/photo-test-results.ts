import { z } from 'zod'
import { PHOTO_TEST_ID_PATTERN } from './photo-test-events.ts'
import { PHOTO_TEST_MAX_ACTIVE, type PhotoVariantCounts } from './photo-test.ts'

/**
 * `POST /operator/photo-tests/results` (#192): the App asks the region for the
 * counters of the tests it knows (the control plane owns the tests, the region
 * only counts). Times are epoch milliseconds.
 */

export const photoTestResultsRequestSchema = z.strictObject({
	tests: z
		.array(
			z.strictObject({
				testId: z.string().regex(PHOTO_TEST_ID_PATTERN),
				itemId: z.string().min(1).max(100),
				startedAt: z.number().int().nonnegative(),
				endedAt: z.number().int().nonnegative().nullable(),
			}),
		)
		.min(1)
		.max(PHOTO_TEST_MAX_ACTIVE)
		.superRefine((tests, context) => {
			tests.forEach((test, index) => {
				if (test.endedAt !== null && test.endedAt < test.startedAt) {
					context.addIssue({
						code: 'custom',
						message: 'range',
						path: [index, 'endedAt'],
					})
				}
			})
		}),
})
export type PhotoTestResultsRequest = z.infer<
	typeof photoTestResultsRequestSchema
>

export type PhotoTestResult = {
	testId: string
	itemId: string
	A: PhotoVariantCounts
	B: PhotoVariantCounts
}

export type PhotoTestResultsResponse = { results: PhotoTestResult[] }
