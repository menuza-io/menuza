import { errorLogFields } from '../lib/error-log.ts'
import { runBirthdayJourneys } from './birthday-journeys.ts'
import {
	evaluateOrderJourneys,
	pruneOrderEmissions,
	runLapsedJourneys,
} from './order-journeys.ts'

/**
 * The regional tick's marketing part: starts the journeys that have no event of
 * their own to start them. Runs once per organization per pass (the hourly cron
 * fan-out, the Node interval, the alarm). Each step is bounded, idempotent
 * (emission rows) and never throws, so one failing step never stops the next.
 *
 * - Order journeys that a missed hook left behind, and guests who went quiet
 *   (#99); birthdays coming up (#151).
 */
export async function runMarketingJourneyTick(
	orgId: string,
	options: { now?: number } = {},
): Promise<void> {
	const steps: Array<[string, () => Promise<unknown>]> = [
		['orders', () => evaluateOrderJourneys(orgId, options)],
		['lapsed', () => runLapsedJourneys(orgId, options)],
		['birthdays', () => runBirthdayJourneys(orgId, options)],
		['prune', () => pruneOrderEmissions(orgId, options)],
	]
	for (const [step, run] of steps) {
		try {
			await run()
		} catch (error) {
			console.error('Marketing journey tick step failed', {
				orgId,
				step,
				...errorLogFields(error),
			})
		}
	}
}
