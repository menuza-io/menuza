import { GROUP_ORDER_FLAG } from './group-orders.ts'
import { ORDER_PROBLEMS_FLAG } from './order-problems.ts'
import { TEST_ORDER_FLAG } from './test-orders.ts'

/**
 * The three guest-ordering switches (#119, #191, #170) as the App folds them
 * into the order context (`guestOrdering`) for the region. Each defaults off
 * and only a literal `true` turns it on, so a missing or malformed value, or an
 * App that predates it, reads as off.
 */
export const GUEST_ORDERING_FLAG_KEYS = {
	testOrders: TEST_ORDER_FLAG,
	problemReports: ORDER_PROBLEMS_FLAG,
	group: GROUP_ORDER_FLAG,
} as const

export type GuestOrderingFeatures = {
	/** `launch.test_order`: operators may place free test orders. */
	testOrders: boolean
	/** `ordering.problem_reports`: guests may report a problem with an order. */
	problemReports: boolean
	/** `ordering.group`: a host may start a group order. */
	group: boolean
}

export const GUEST_ORDERING_OFF: GuestOrderingFeatures = {
	testOrders: false,
	problemReports: false,
	group: false,
}

export function readGuestOrderingFeatures(raw: unknown): GuestOrderingFeatures {
	if (!raw || typeof raw !== 'object') return GUEST_ORDERING_OFF
	const value = raw as Record<string, unknown>
	return {
		testOrders: value.testOrders === true,
		problemReports: value.problemReports === true,
		group: value.group === true,
	}
}
