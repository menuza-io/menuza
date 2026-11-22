import { describe, expect, it } from 'vitest'
import { photoTestResultsRequestSchema } from './photo-test-results.ts'

const test = {
	testId: 'test_abcd1234',
	itemId: 'dish-1',
	startedAt: 1_700_000_000_000,
	endedAt: null,
}

describe('photoTestResultsRequestSchema', () => {
	it('accepts a running and an ended test', () => {
		expect(
			photoTestResultsRequestSchema.safeParse({
				tests: [test, { ...test, endedAt: test.startedAt + 1000 }],
			}).success,
		).toBe(true)
	})

	it('refuses an empty list, more than 20 tests and unknown keys', () => {
		expect(photoTestResultsRequestSchema.safeParse({ tests: [] }).success).toBe(
			false,
		)
		expect(
			photoTestResultsRequestSchema.safeParse({
				tests: Array.from({ length: 21 }, () => test),
			}).success,
		).toBe(false)
		expect(
			photoTestResultsRequestSchema.safeParse({ tests: [test], x: 1 }).success,
		).toBe(false)
		expect(
			photoTestResultsRequestSchema.safeParse({
				tests: [{ ...test, orgId: 'other' }],
			}).success,
		).toBe(false)
	})

	it('refuses a test that ends before it starts and non-integer times', () => {
		expect(
			photoTestResultsRequestSchema.safeParse({
				tests: [{ ...test, endedAt: test.startedAt - 1 }],
			}).success,
		).toBe(false)
		expect(
			photoTestResultsRequestSchema.safeParse({
				tests: [{ ...test, startedAt: 1.5 }],
			}).success,
		).toBe(false)
	})
})
