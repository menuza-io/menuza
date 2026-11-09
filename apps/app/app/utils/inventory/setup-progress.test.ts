import { describe, expect, it } from 'vitest'
import {
	deriveInventorySetupSteps,
	inventorySetupProgress,
} from './setup-progress.ts'

const EMPTY = { items: 0, storageAreas: 0, approvedCounts: 0, deliveries: 0 }

describe('deriveInventorySetupSteps', () => {
	it('is unknown (loading) until the region answers', () => {
		const steps = deriveInventorySetupSteps(null)
		expect(steps.map((step) => step.status)).toEqual([
			'unknown',
			'unknown',
			'unknown',
			'unknown',
		])
		expect(steps.some((step) => step.next)).toBe(false)
		expect(inventorySetupProgress(steps)).toEqual({
			done: 0,
			total: 4,
			complete: false,
			loading: true,
		})
	})

	it('starts a new organization at Add your items', () => {
		const steps = deriveInventorySetupSteps(EMPTY)
		expect(steps.map((step) => [step.id, step.status, step.tab])).toEqual([
			['items', 'todo', 'stock'],
			['storage', 'todo', 'stock'],
			['count', 'todo', 'counts'],
			['delivery', 'todo', 'purchasing'],
		])
		expect(steps.find((step) => step.next)?.id).toBe('items')
		expect(inventorySetupProgress(steps)).toMatchObject({
			done: 0,
			complete: false,
			loading: false,
		})
	})

	it('marks the first step that is not done as next, in order', () => {
		const steps = deriveInventorySetupSteps({
			...EMPTY,
			items: 12,
			approvedCounts: 1,
		})
		expect(steps.map((step) => step.status)).toEqual([
			'done',
			'todo',
			'done',
			'todo',
		])
		expect(steps.filter((step) => step.next).map((step) => step.id)).toEqual([
			'storage',
		])
		expect(inventorySetupProgress(steps)).toMatchObject({ done: 2, total: 4 })
	})

	it('completes when every fact is above zero', () => {
		const steps = deriveInventorySetupSteps({
			items: 3,
			storageAreas: 2,
			approvedCounts: 1,
			deliveries: 4,
		})
		expect(steps.some((step) => step.next)).toBe(false)
		expect(inventorySetupProgress(steps)).toEqual({
			done: 4,
			total: 4,
			complete: true,
			loading: false,
		})
	})
})
