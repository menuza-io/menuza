import { describe, expect, it, vi } from 'vitest'

vi.mock('@repo/database', () => ({
	db: {
		select: vi.fn(),
	},
	and: (...args: unknown[]) => args,
	eq: () => ({}),
	OrganizationLocation: {
		id: 'id',
		name: 'name',
		organizationId: 'organizationId',
	},
	OrganizationSalesGoal: {
		organizationId: 'organizationId',
		locationId: 'locationId',
		month: 'month',
		goalMinor: 'goalMinor',
		currency: 'currency',
	},
}))

describe('sales goals', () => {
	it('projection module matches run rate', async () => {
		const { projectMonthlySales } =
			await import('@repo/common/sales-goal-projection')
		const result = projectMonthlySales({
			dayOfMonth: 10,
			daysInMonth: 30,
			actualMinor: 30_000,
			goalMinor: 90_000,
		})
		expect(result.kind).toBe('on_track')
	})
})
