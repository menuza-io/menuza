import { type DiscountRefusalReason } from '@repo/discounts'

/**
 * A guest is only told a typed code "was not found" when the region refuses it
 * for being the wrong order type, location, channel or time (the region hides
 * those reasons so a code cannot be probed). The page cannot tell that from a
 * code that does not exist, so it holds such a code (stops sending it) and
 * tries it again once when the part of the order those reasons depend on
 * changes: pickup to delivery, another location, another time, another
 * address. A code that is truly unknown costs one more attempt per change.
 */

/** The held code and the order context it was refused in. */
export type HeldCoupon = {
	code: string
	reason: DiscountRefusalReason
	/**
	 * Set when the region refused the code (so `not_found` may be a hidden
	 * reason); left out when the page refused it itself, which no change fixes.
	 */
	contextKey?: string | null
}

/** The fields of an order a hidden refusal can depend on, as one string. */
export function couponContextKey(
	payload: Record<string, unknown> | null,
): string | null {
	if (!payload) return null
	const delivery =
		payload.delivery && typeof payload.delivery === 'object'
			? (payload.delivery as Record<string, unknown>).address
			: null
	return JSON.stringify([
		payload.fulfillment ?? null,
		payload.locationId ?? null,
		payload.scheduledFor ?? null,
		payload.dropSlug ?? null,
		delivery ?? null,
		payload.source ?? null,
	])
}

/** The attempts already made: one per code and order context. */
export function attemptKey(code: string, contextKey: string): string {
	return `${code.toLowerCase()}|${contextKey}`
}

/** Whether to send a held code again for the order as it is now. */
export function shouldRetryHeldCoupon(
	held: HeldCoupon | null,
	currentKey: string | null,
	tried: ReadonlySet<string>,
): boolean {
	if (!held || held.reason !== 'not_found') return false
	if (held.contextKey === undefined || currentKey === null) return false
	if (currentKey === held.contextKey) return false
	return !tried.has(attemptKey(held.code, currentKey))
}
