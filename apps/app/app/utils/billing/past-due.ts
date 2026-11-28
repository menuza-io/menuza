/**
 * Past-due subscription facts shared by the banner, the billing page and Admin
 * (#237). Pure: the state comes from the stored Stripe webhook status.
 */
export const PAST_DUE_STATUS = 'past_due'

export function isPastDueStatus(status: string | null | undefined): boolean {
	return status === PAST_DUE_STATUS
}

const DAY_MS = 86_400_000

/** Whole days since the subscription became past due; null when it is not. */
export function daysOverdue(
	pastDueSince: Date | string | number | null | undefined,
	now: Date = new Date(),
): number | null {
	if (pastDueSince === null || pastDueSince === undefined) return null
	const since = new Date(pastDueSince).getTime()
	if (!Number.isFinite(since)) return null
	return Math.max(0, Math.floor((now.getTime() - since) / DAY_MS))
}

/** The billing page of an organization, where the banner leads. */
export function billingPath(orgSlug: string): string {
	return `/${orgSlug}/settings/billing`
}

/** The self-serve cancel or downgrade request page (#379). */
export function cancelRequestPath(orgSlug: string): string {
	return `/${orgSlug}/settings/billing/cancel`
}
