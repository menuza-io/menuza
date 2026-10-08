import { describe, expect, it, vi } from 'vitest'
import { forEachWithBudget } from './concurrency.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('forEachWithBudget', () => {
	it('runs every item with at most `concurrency` in flight', async () => {
		let inFlight = 0
		let maxInFlight = 0
		const seen: number[] = []
		const run = await forEachWithBudget(
			Array.from({ length: 25 }, (_, index) => index),
			{ concurrency: 8, deadline: Number.POSITIVE_INFINITY },
			async (item) => {
				inFlight++
				maxInFlight = Math.max(maxInFlight, inFlight)
				await tick()
				seen.push(item)
				inFlight--
			},
		)
		expect(run).toEqual({ started: 25, skipped: 0 })
		expect(maxInFlight).toBe(8)
		expect(seen.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 25 }, (_, index) => index),
		)
	})

	it('starts nothing new after the deadline and waits for tasks in flight', async () => {
		let clock = 0
		const finished: number[] = []
		const run = await forEachWithBudget(
			Array.from({ length: 10 }, (_, index) => index),
			{ concurrency: 2, deadline: 3, now: () => clock },
			async (item) => {
				clock++
				await tick()
				finished.push(item)
			},
		)
		// Items 0-2 start before the clock reaches the deadline.
		expect(run).toEqual({ started: 3, skipped: 7 })
		expect(finished.sort()).toEqual([0, 1, 2])
	})

	it('skips everything when the deadline has already passed', async () => {
		const task = vi.fn(async () => {})
		const run = await forEachWithBudget(
			[1, 2, 3],
			{ concurrency: 4, deadline: 0 },
			task,
		)
		expect(run).toEqual({ started: 0, skipped: 3 })
		expect(task).not.toHaveBeenCalled()
	})

	it('keeps going when a task throws', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const done: number[] = []
		const run = await forEachWithBudget(
			[1, 2, 3],
			{ concurrency: 1, deadline: Number.POSITIVE_INFINITY },
			async (item) => {
				if (item === 2) throw new Error('boom')
				done.push(item)
			},
		)
		expect(run).toEqual({ started: 3, skipped: 0 })
		expect(done).toEqual([1, 3])
		errors.mockRestore()
	})

	it('handles an empty list', async () => {
		expect(
			await forEachWithBudget(
				[],
				{ concurrency: 8, deadline: 0 },
				async () => {},
			),
		).toEqual({ started: 0, skipped: 0 })
	})
})
