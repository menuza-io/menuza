import { projectMonthlySales } from '@repo/common/sales-goal-projection'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationSalesGoal,
} from '@repo/database'

export type LocationGoalProgress = {
	locationId: string
	locationName: string
	goalMinor: number | null
	actualMinor: number
	currency: string
	projection: ReturnType<typeof projectMonthlySales>
}

export async function loadLocationGoalProgress(input: {
	organizationId: string
	month: string
	actualByLocation: ReadonlyMap<string, number>
}): Promise<LocationGoalProgress[]> {
	const [locations, goals] = await Promise.all([
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, input.organizationId)),
		db
			.select()
			.from(OrganizationSalesGoal)
			.where(
				and(
					eq(OrganizationSalesGoal.organizationId, input.organizationId),
					eq(OrganizationSalesGoal.month, input.month),
				),
			),
	])
	const goalByLocation = new Map(goals.map((g) => [g.locationId, g]))
	const day = new Date().getDate()
	const daysInMonth = new Date(
		Number(input.month.slice(0, 4)),
		Number(input.month.slice(5, 7)),
		0,
	).getDate()
	return locations.map((location) => {
		const goal = goalByLocation.get(location.id)
		const actualMinor = input.actualByLocation.get(location.id) ?? 0
		const goalMinor = goal?.goalMinor ?? null
		return {
			locationId: location.id,
			locationName: location.name,
			goalMinor,
			actualMinor,
			currency: goal?.currency ?? 'USD',
			projection:
				goalMinor === null
					? { kind: 'too_early' as const }
					: projectMonthlySales({
							dayOfMonth: day,
							daysInMonth,
							actualMinor,
							goalMinor,
						}),
		}
	})
}
