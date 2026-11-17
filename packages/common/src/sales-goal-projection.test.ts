import { describe, expect, it } from 'vitest'
import { projectMonthlySales } from './sales-goal-projection.ts'

describe('sales goal projection', () => {
	it('projects from daily run rate', () => {
		const result = projectMonthlySales({
			dayOfMonth: 10,
			daysInMonth: 30,
			actualMinor: 50_000,
			goalMinor: 200_000,
		})
		expect(result.kind).toBe('on_track')
		if (result.kind === 'on_track') {
			expect(result.runRateMinor).toBe(5_000)
			expect(result.projectedMinor).toBe(150_000)
			expect(result.percentOfGoal).toBeCloseTo(0.75)
		}
	})

	it('says too early at start of month', () => {
		expect(
			projectMonthlySales({
				dayOfMonth: 1,
				daysInMonth: 30,
				actualMinor: 10_000,
				goalMinor: 100_000,
			}).kind,
		).toBe('too_early')
	})
})
