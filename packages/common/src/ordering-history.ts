import { z } from 'zod'

/**
 * What the control plane tells the region about online ordering history
 * (#176, #405): per location, the scheduled online hours, the staff pauses and
 * the closures taken at short notice, as time windows (epoch ms). Times only:
 * no guest data. The region reads sales and sold-out history itself and does
 * the arithmetic; only these windows cross from the control plane.
 */

const windowSchema = z.object({ from: z.number(), to: z.number() })

export const ORDERING_HISTORY_MAX_RANGE_MS = 200 * 86_400_000

export const orderingHistorySchema = z.object({
	orgId: z.string().min(1).max(64),
	locations: z
		.array(
			z.object({
				id: z.string().min(1).max(100),
				name: z.string().max(300),
				timezone: z.string().max(80),
				/** The location's currency (an ISO code). */
				currency: z.string().max(8),
				/** Scheduled online hours; null: none configured, open all the time. */
				openWindows: z.array(windowSchema).max(5000).nullable(),
				/** Staff pauses; an open pause ends at the end of the range. */
				pauses: z.array(windowSchema).max(5000),
				/** Scheduled hours taken away at short notice. */
				closures: z.array(windowSchema).max(5000),
			}),
		)
		.max(500),
})
export type OrderingHistory = z.infer<typeof orderingHistorySchema>
export type OrderingHistoryLocation = OrderingHistory['locations'][number]
