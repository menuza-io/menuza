import {
	getTenantDb,
	JOURNEY_GOAL_REACHED_REASON,
	journeyRuns,
	journeyStepExecutions,
} from '@repo/tenant-db'
import { and, eq, gte, sql } from 'drizzle-orm'

/**
 * The last N days of each automation (#100 "30-day results"): runs started,
 * messages delivered and guests who ordered (runs that ended on their goal).
 * Counts per journey id; nothing about a guest.
 */
export type JourneyResult = {
	runs: number
	messagesSent: number
	ordersByGoal: number
}

export async function journeyResults(
	orgId: string,
	options: { days?: number; now?: number } = {},
): Promise<Record<string, JourneyResult>> {
	const days = Math.min(Math.max(Math.floor(options.days ?? 30), 1), 365)
	const since = new Date((options.now ?? Date.now()) - days * 86_400_000)
	const db = await getTenantDb(orgId)
	const results: Record<string, JourneyResult> = {}
	const at = (id: string) =>
		(results[id] ??= { runs: 0, messagesSent: 0, ordersByGoal: 0 })

	const runs = await db
		.select({
			journeyId: journeyRuns.journeyId,
			runs: sql<number>`count(*)`,
			goal: sql<number>`sum(case when ${journeyRuns.status} = 'cancelled' and ${journeyRuns.errorMessage} = ${JOURNEY_GOAL_REACHED_REASON} then 1 else 0 end)`,
		})
		.from(journeyRuns)
		.where(
			and(
				gte(journeyRuns.startedAt, since),
				// Operator test runs are not results.
				sql`coalesce(json_extract(${journeyRuns.contextData}, '$.isTestRun'), 0) <> 1`,
			),
		)
		.groupBy(journeyRuns.journeyId)
	for (const row of runs) {
		at(row.journeyId).runs = Number(row.runs)
		at(row.journeyId).ordersByGoal = Number(row.goal ?? 0)
	}
	const sent = await db
		.select({
			journeyId: journeyStepExecutions.journeyId,
			n: sql<number>`count(*)`,
		})
		.from(journeyStepExecutions)
		.where(
			and(
				eq(journeyStepExecutions.status, 'delivered'),
				gte(journeyStepExecutions.executedAt, since),
			),
		)
		.groupBy(journeyStepExecutions.journeyId)
	for (const row of sent) {
		if (row.journeyId) at(row.journeyId).messagesSent = Number(row.n)
	}
	return results
}
