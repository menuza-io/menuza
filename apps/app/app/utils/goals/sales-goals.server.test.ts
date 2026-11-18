import { db, OrganizationLocation } from '@repo/database'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { loadLocationGoalProgress } from './sales-goals.server.ts'

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

	it('scoped managers see only their locations', async () => {
		const user = await createTestUser()
		const organization = await createTestOrganization(user.id, 'admin')
		const [locA] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'North',
				slug: 'north',
				timezone: 'America/New_York',
				isActive: true,
				isDefault: true,
			})
			.returning({ id: OrganizationLocation.id })
		const [locB] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'South',
				slug: 'south',
				timezone: 'America/New_York',
				isActive: true,
				isDefault: false,
			})
			.returning({ id: OrganizationLocation.id })
		const month = '2026-03'
		const all = await loadLocationGoalProgress({
			organizationId: organization.id,
			month,
			actualByLocation: new Map(),
		})
		expect(all.map((row) => row.locationId).sort()).toEqual(
			[locA!.id, locB!.id].sort(),
		)
		const scoped = await loadLocationGoalProgress({
			organizationId: organization.id,
			month,
			actualByLocation: new Map(),
			locationIds: [locA!.id],
		})
		expect(scoped).toHaveLength(1)
		expect(scoped[0]!.locationId).toBe(locA!.id)
	})
})
