import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/** Operator-facing names of restaurant order statuses. */
export const ORDER_STATUS_LABELS: Record<string, MessageDescriptor> = {
	// Manual acceptance (#107): placed, waiting for a person to accept it.
	pending_acceptance: msg`Waiting for acceptance`,
	accepted: msg`New order`,
	preparing: msg`Preparing`,
	ready: msg`Ready`,
	completed: msg`Completed`,
	cancelled: msg`Cancelled`,
	expired: msg`Expired`,
	payment_review: msg`Payment needs review`,
}
