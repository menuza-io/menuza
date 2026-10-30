import { describe, expect, it, vi } from 'vitest'
import {
	createOrgLock,
	forEachWithBudget,
	OrgLockReentryError,
	runExclusive,
} from './concurrency.ts'

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
describe('org locks', () => {
	it('serializes operations for one organization and runs others alongside', async () => {
		const lock = createOrgLock()
		const order: string[] = []
		const slow = lock('org_a', async () => {
			order.push('a1 start')
			await new Promise((resolve) => setTimeout(resolve, 20))
			order.push('a1 end')
		})
		const other = lock('org_b', async () => {
			order.push('b')
		})
		const next = lock('org_a', async () => {
			order.push('a2')
		})
		await Promise.all([slow, other, next])
		expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1 end'))
		expect(order.indexOf('b')).toBeLessThan(order.indexOf('a1 end'))
	})

	it('throws on re-entry for the same organization instead of hanging', async () => {
		const lock = createOrgLock()
		const nested = lock('org_a', () => lock('org_a', async () => 'inner'))
		await expect(nested).rejects.toBeInstanceOf(OrgLockReentryError)
		// Another organization inside the lock is fine.
		await expect(
			lock('org_a', () => lock('org_b', async () => 'other')),
		).resolves.toBe('other')
		// And the lock is released after the refusal.
		await expect(lock('org_a', async () => 'again')).resolves.toBe('again')
	})

	it('lets work started inside the lock take it once the holder has finished', async () => {
		const lock = createOrgLock()
		let late: Promise<string> = Promise.resolve('')
		await lock('org_a', async () => {
			late = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
				lock('org_a', async () => 'late'),
			)
		})
		await expect(late).resolves.toBe('late')
	})

	it('releases the lock after a failed operation', async () => {
		const lock = createOrgLock()
		await expect(
			lock('org_a', async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		await expect(lock('org_a', async () => 'ok')).resolves.toBe('ok')
	})

	it('the shared runExclusive refuses re-entry too', async () => {
		await expect(
			runExclusive('org_shared', () =>
				runExclusive('org_shared', async () => 'inner'),
			),
		).rejects.toBeInstanceOf(OrgLockReentryError)
	})
})
