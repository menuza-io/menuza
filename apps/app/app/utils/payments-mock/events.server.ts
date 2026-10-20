import { type MockEventRow } from '@repo/payments/mock'

/**
 * Delivery state of one event for the dev API and the event log. The signed
 * body (which can hold the fake buyer details the page was filled with) only
 * leaves with an explicit `payload=1`.
 */
export function toEventSummary(event: MockEventRow, includePayload: boolean) {
	return {
		id: event.id,
		provider: event.provider,
		type: event.type,
		connect_account: event.connectAccount,
		created_at: new Date(event.createdAt).toISOString(),
		delivered_at:
			event.deliveredAt === null
				? null
				: new Date(event.deliveredAt).toISOString(),
		attempts: event.attempts,
		last_status: event.lastStatus,
		...(includePayload
			? { payload: JSON.parse(event.payload) as unknown }
			: {}),
	}
}
