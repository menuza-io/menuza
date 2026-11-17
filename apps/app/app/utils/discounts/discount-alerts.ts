import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * What the owner hears about a discount (#392): its weekly budget ran out. The
 * in-app notification and the email come from the same copy; the notification's
 * payload is the organization slug, the discount id and the kind, never an
 * amount or a guest.
 */
export type DiscountAlertKind = 'budget_reached'

/** The `Notification.type` a discount alert is stored under. */
export const DISCOUNT_ALERT_TYPES: Record<DiscountAlertKind, string> = {
	budget_reached: 'discount_budget_reached',
}

const KINDS: Record<string, DiscountAlertKind> = {
	discount_budget_reached: 'budget_reached',
}

export function discountAlertKindFromNotificationType(
	type: string,
): DiscountAlertKind | null {
	return KINDS[type] ?? null
}

/** Where a discount alert leads: the discount's own page. */
export function discountAlertPath(discountId: string): string {
	return `/discounts/${encodeURIComponent(discountId)}`
}

export const DISCOUNT_ALERT_COPY: Record<
	DiscountAlertKind,
	{ subject: MessageDescriptor; body: MessageDescriptor }
> = {
	budget_reached: {
		subject: msg`**A discount reached its weekly budget**`,
		body: msg`It is paused and starts again next week. Open it to see the spend or change the budget.`,
	},
}

/**
 * The email for the same event, in plain English: a request from the region
 * carries no locale, like the gift card and staffing alerts. The discount's
 * name goes in the headline.
 */
export const DISCOUNT_EMAIL_EYEBROW = 'Discounts'
export const DISCOUNT_EMAIL_ACTION = 'Open the discount'
export function discountBudgetEmail(discountName: string) {
	return {
		subject: `${discountName}: weekly budget reached`,
		headline: `${discountName}: weekly budget reached`,
		detail:
			'It has given its whole weekly budget, so it is paused until next week. Orders already placed keep their discount. Open it to see the spend or change the budget.',
	}
}
