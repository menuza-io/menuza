import { type OrgTickModule } from './org-alarm.ts'

/**
 * Sub-hourly timing for inventory on the Durable Object runtime. The hourly
 * cron does the daily digests; the alarm is only for retrying alerts the App
 * could not take, so it is armed by a tick that still has some waiting
 * (`needsFollowUp`) and never by plain activity.
 */
export const INVENTORY_ALARM_INTERVAL_MS = 5 * 60 * 1000

export function createInventoryTickModule(
	run: (
		orgId: string,
		now: number,
	) => Promise<{ needsFollowUp: boolean; nextDueAt: number | null }>,
): OrgTickModule {
	return {
		name: 'inventory',
		tickPath: '/api/inventory/tick',
		intervalMs: INVENTORY_ALARM_INTERVAL_MS,
		isActivityPath: () => false,
		run: async (orgId, now) => {
			const result = await run(orgId, now)
			return {
				needsFollowUp: result.needsFollowUp,
				nextDueAt: result.nextDueAt,
			}
		},
	}
}
