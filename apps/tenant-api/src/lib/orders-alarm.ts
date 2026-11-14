import { type OrgTickModule } from './org-alarm.ts'

export const ORDER_MESSAGES_TICK_PATH = '/api/order-messages/tick'

/**
 * Sub-hourly timing for guest order messages on the Durable Object runtime:
 * retries of a receipt or status message whose send failed. Order activity
 * (placing an order, a payment event, a status change at the till, kitchen or
 * App) arms the shared alarm; the alarm runs the tick, which asks for a
 * follow-up only while queued rows exist, so an organization with nothing
 * waiting goes quiet.
 */
export const ORDER_MESSAGES_ALARM_INTERVAL_MS = 2 * 60 * 1000

/**
 * Requests that can queue an order message: placing an order, a payment event,
 * and the status writes of the App, Station's Orders app and the kitchen.
 * Read paths a page or a screen polls (a receipt, the kitchen feed, order
 * lists) are left out so polling never keeps the alarm busy.
 */
export function isOrderMessagesActivityPath(pathname: string): boolean {
	return (
		pathname === '/orders' ||
		pathname === '/api/orders/payment-status' ||
		/^\/operator\/orders\/[^/]+$/.test(pathname) ||
		/^\/pos\/online-orders\/[^/]+\/command$/.test(pathname) ||
		pathname === '/pos/kds/command'
	)
}

export function createOrderMessagesTickModule(
	run: (
		orgId: string,
		now: number,
	) => Promise<{ needsFollowUp: boolean; nextDueAt: number | null }>,
): OrgTickModule {
	return {
		name: 'orders',
		tickPath: ORDER_MESSAGES_TICK_PATH,
		intervalMs: ORDER_MESSAGES_ALARM_INTERVAL_MS,
		isActivityPath: isOrderMessagesActivityPath,
		run: async (orgId, now) => {
			const result = await run(orgId, now)
			return {
				needsFollowUp: result.needsFollowUp,
				nextDueAt: result.nextDueAt,
			}
		},
	}
}
