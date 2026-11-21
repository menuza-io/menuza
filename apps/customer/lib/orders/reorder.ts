import {
	encodeReorderPayload,
	REORDER_PAYLOAD_PARAM,
	type ReorderResponse,
} from '@repo/common/customer-orders'

/**
 * "Order again" in the app (#112): the app has no cart, so it opens the
 * website's menu with the order's catalog ids in the URL FRAGMENT (ids and
 * counts only: never a price, a name or a note, and never sent to a server).
 * The website prices the cart again from the live menu, leaves out any dish
 * that cannot be made exactly as ordered, says how many, and opens the cart.
 */
export function reorderWebsiteUrl(
	menuUrl: string,
	reorder: ReorderResponse,
): string | null {
	const payload = encodeReorderPayload(reorder)
	if (!payload) return null
	try {
		const url = new URL(menuUrl)
		url.searchParams.set('location', reorder.locationId)
		url.hash = `${REORDER_PAYLOAD_PARAM}=${payload}`
		return url.toString()
	} catch {
		return null
	}
}
