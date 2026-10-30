import { type OrgTickModule } from './org-alarm.ts'

/** Sub-hourly timing for loyalty on the Durable Object runtime. */
export const LOYALTY_ALARM_INTERVAL_MS = 2 * 60 * 1000

/**
 * Requests that show an organization is using loyalty: customers, tills and
 * operators. Order traffic is left out on purpose: settling runs right after
 * the order commits, and the hourly tick retries what failed.
 */
export function isLoyaltyActivityPath(pathname: string): boolean {
	return (
		pathname === '/loyalty' ||
		pathname.startsWith('/loyalty/') ||
		pathname.startsWith('/pos/loyalty/') ||
		pathname === '/operator/loyalty' ||
		pathname.startsWith('/operator/loyalty/') ||
		pathname === '/api/loyalty/tick'
	)
}

type DeferredHandler = (dueAt: number) => void | Promise<void>

const deferredHandlers = new Map<string, DeferredHandler>()

/**
 * Lets the runtime hear when loyalty work for an organization was put off (a
 * source that failed to settle right after its sale), so it can wake up when
 * that work is due instead of at the next hourly cron. The Durable Object
 * arms its alarm here; the Node runtime has its interval tick and registers
 * nothing. Returns the unregister function.
 */
export function onLoyaltyDeferred(
	orgId: string,
	handler: DeferredHandler,
): () => void {
	deferredHandlers.set(orgId, handler)
	return () => {
		if (deferredHandlers.get(orgId) === handler) deferredHandlers.delete(orgId)
	}
}

/** Tells the runtime, if it listens, when deferred work is due. Never throws. */
export async function reportLoyaltyDeferred(
	orgId: string,
	dueAt: number,
): Promise<void> {
	const handler = deferredHandlers.get(orgId)
	if (!handler) return
	try {
		await handler(dueAt)
	} catch (error) {
		console.error(
			'Loyalty deferred work could not be scheduled',
			error instanceof Error ? error.name : 'unknown',
		)
	}
}

export function createLoyaltyTickModule(
	run: (
		orgId: string,
		now: number,
	) => Promise<{ needsFollowUp: boolean; nextDueAt: number | null }>,
): OrgTickModule {
	return {
		name: 'loyalty',
		tickPath: '/api/loyalty/tick',
		intervalMs: LOYALTY_ALARM_INTERVAL_MS,
		isActivityPath: isLoyaltyActivityPath,
		run: async (orgId, now) => {
			const result = await run(orgId, now)
			return {
				needsFollowUp: result.needsFollowUp,
				nextDueAt: result.nextDueAt,
			}
		},
	}
}
