import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	type CancelReason,
	type CancelRequestKind,
} from '@repo/common/cancel-request'

/** What the owner reads for each reason and sub-reason, in their language (#379). */
export const CANCEL_KIND_TEXT: Record<
	CancelRequestKind,
	{ title: MessageDescriptor; description: MessageDescriptor }
> = {
	cancel_locations: {
		title: msg`Cancel some locations`,
		description: msg`Stop billing for the locations you choose. The rest stays as it is.`,
	},
	cancel_organization: {
		title: msg`Cancel everything`,
		description: msg`End the subscription for the whole organization.`,
	},
	downgrade: {
		title: msg`Move to a smaller plan`,
		description: msg`Keep your restaurant and switch to a plan that costs less.`,
	},
}

export const CANCEL_REASON_TEXT: Record<CancelReason, MessageDescriptor> = {
	too_expensive: msg`It costs too much`,
	missing_features: msg`Something I need is missing`,
	closing_or_seasonal: msg`I am closing or it is seasonal`,
	switching: msg`I am switching to something else`,
	service: msg`Service or reliability`,
	other: msg`Something else`,
}

export const CANCEL_SUB_REASON_TEXT: Record<string, MessageDescriptor> = {
	price_too_high: msg`The price is too high for us`,
	not_enough_sales: msg`Not enough sales to justify it`,
	found_cheaper: msg`I found something cheaper`,
	ordering: msg`Ordering features`,
	reports: msg`Reports`,
	integrations: msg`Integrations`,
	something_else: msg`Something else is missing`,
	closing_for_good: msg`Closing for good`,
	seasonal: msg`Seasonal: I will be back`,
	selling_the_business: msg`Selling the business`,
	other_platform: msg`Moving to another platform`,
	doing_it_in_house: msg`Doing it in house`,
	support: msg`Support`,
	reliability: msg`Reliability`,
	hard_to_use: msg`Hard to use`,
}

export const CANCEL_ERROR_TEXT: Record<string, MessageDescriptor> = {
	invalid: msg`Check the form: choose what you want to do, a reason, and confirm.`,
	no_subscription: msg`There is no active subscription to change.`,
	cutoff_unknown: msg`We could not read your billing date right now. Try again in a moment.`,
	already_requested: msg`You already have a request open. Withdraw it first to send a new one.`,
	invalid_locations: msg`Choose locations that belong to this organization.`,
	no_smaller_plan: msg`There is no smaller plan to move to.`,
}
