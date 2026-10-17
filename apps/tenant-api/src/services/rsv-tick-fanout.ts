import { forEachWithBudget } from '../lib/concurrency.ts'
import {
	addToReservationsAggregate,
	emptyReservationsAggregate,
	type ReservationsTickAggregate,
	type ReservationsTickResult,
} from './rsv-tick-service.ts'

/**
 * Runs the reservations tick for many organizations with bounded concurrency
 * and a time budget. Shared by the Node runtime (each organization runs
 * in-process) and the Workers edge (each is forwarded to its Durable Object);
 * only `run` differs. An organization not reached before the deadline is
 * counted as deferred and picked up by the next tick.
 */
export async function fanOutReservationsTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<ReservationsTickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
}): Promise<ReservationsTickAggregate> {
	const now = options.now ?? Date.now
	const total = emptyReservationsAggregate()
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
			addToReservationsAggregate(total, result)
		},
	)
	total.orgsDeferred = run.skipped
	return total
}
