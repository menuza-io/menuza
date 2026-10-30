import { describe, expect, it } from 'vitest'
import {
	loyaltyOperatorProgramResponseSchema,
	loyaltySaveProgramRequestSchema,
} from './operator.ts'

const config = {
	name: 'Program',
	unitLabel: 'points',
	currency: 'USD',
	timeZone: 'UTC',
	minimumSpendMinor: 0,
	earning: { method: 'spend', points: 5, perMinor: 100 },
	terms: 'Terms',
	labels: { items: {}, categories: {} },
}

const response = (stored: unknown) => ({
	program: {
		id: 'prog_1',
		status: 'active',
		version: 2,
		currencyLocked: true,
		current: {
			id: 'pv_2',
			version: 2,
			status: 'active',
			effectiveAt: 1000,
			config: stored,
			createdAt: 1000,
			createdBy: null,
		},
		history: [],
	},
})

describe('operator program schemas', () => {
	it('read and save the same config the same way', () => {
		expect(
			loyaltyOperatorProgramResponseSchema.safeParse(response(config)).success,
		).toBe(true)
		expect(
			loyaltySaveProgramRequestSchema.safeParse({ expectedVersion: 2, config })
				.success,
		).toBe(true)
		const bad = {
			...config,
			earning: { method: 'spend', points: 5, perMinor: 1 },
		}
		expect(
			loyaltyOperatorProgramResponseSchema.safeParse(response(bad)).success,
		).toBe(false)
		expect(
			loyaltySaveProgramRequestSchema.safeParse({
				expectedVersion: 2,
				config: bad,
			}).success,
		).toBe(false)
	})
})
