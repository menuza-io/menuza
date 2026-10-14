import { forEachWithBudget } from '../lib/concurrency.ts'
import {
	addToAggregate,
	emptyAggregate,
	type TickAggregate,
	type TickResult,
} from './staff-tick-service.ts'

/**
 * Runs the tick for many organizations with bounded concurrency and a time
 * budget, and folds the results into counts. It is shared by the Node runtime
 * (which runs each organization in-process) and the Workers edge (which forwards
 * each one to that organization's Durable Object): only `run` differs.
 *
 * An organization not reached before the deadline is counted as deferred, and
 * the next hourly tick (or the organization's own alarm) picks it up; every task
 * is idempotent, so a partial pass loses nothing.
 */
export async function fanOutStaffTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<TickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
}): Promise<TickAggregate> {
	const now = options.now ?? Date.now
	const total = emptyAggregate()
	const run = await forEachWithBudget(
		options.orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? 50_000),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors++
				return
			}
			addToAggregate(total, result)
		},
	)
	total.orgsDeferred = run.skipped
	return total
}
