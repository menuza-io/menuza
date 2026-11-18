import { createId } from '@paralleldrive/cuid2'
import { projectMonthlySales } from '@repo/common/sales-goal-projection'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationSalesGoal,
	sql,
} from '@repo/database'

import {
	type LocationGoalProgress,
	GOAL_BENCHMARK_CANCELLATION_RATE,
} from './goals.ts'

export type { LocationGoalProgress }
export { GOAL_BENCHMARK_CANCELLATION_RATE }

export async function upsertSalesGoal(input: {
	organizationId: string
	locationId: string
	month: string
	goalMinor: number
	currency: string
}) {
	const now = new Date()
	const existing = await db.query.OrganizationSalesGoal.findFirst({
		where: and(
			eq(OrganizationSalesGoal.organizationId, input.organizationId),
			eq(OrganizationSalesGoal.locationId, input.locationId),
			eq(OrganizationSalesGoal.month, input.month),
		),
		columns: { id: true },
	})
	if (existing) {
		await db
			.update(OrganizationSalesGoal)
			.set({
				goalMinor: input.goalMinor,
				currency: input.currency,
				updatedAt: now,
			})
			.where(eq(OrganizationSalesGoal.id, existing.id))
		return existing.id
	}
	const id = createId()
	await db.insert(OrganizationSalesGoal).values({
		id,
		organizationId: input.organizationId,
		locationId: input.locationId,
		month: input.month,
		goalMinor: input.goalMinor,
		currency: input.currency,
		createdAt: now,
		updatedAt: now,
	})
	return id
}

export async function loadLocationGoalProgress(input: {
	organizationId: string
	month: string
	actualByLocation: ReadonlyMap<string, number>
	locationIds?: readonly string[] | null
}): Promise<LocationGoalProgress[]> {
	const locationFilter =
		input.locationIds === null || input.locationIds === undefined
			? eq(OrganizationLocation.organizationId, input.organizationId)
			: and(
					eq(OrganizationLocation.organizationId, input.organizationId),
					...(input.locationIds.length === 0
						? [sql`0`]
						: [inArray(OrganizationLocation.id, [...input.locationIds])]),
				)
	const [locations, goals] = await Promise.all([
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(locationFilter),
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
