const DAY_MS = 86_400_000

/**
 * Whole days a subscription has been past due (#237), counted from the first
 * past-due event the App stored. Null when it is not past due or unknown.
 */
export function daysOverdue(
	status: string | null | undefined,
	pastDueSince: Date | string | number | null | undefined,
	now: Date = new Date(),
): number | null {
	if (status !== 'past_due' || !pastDueSince) return null
	const since = new Date(pastDueSince).getTime()
	if (!Number.isFinite(since)) return null
	return Math.max(0, Math.floor((now.getTime() - since) / DAY_MS))
}
