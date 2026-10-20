/**
 * Where an order lives in the App: the Orders list, or one order's own page
 * (`/<org>/orders/<id>`). The old `/orders?order=<id>` form still redirects.
 */
export function ordersHref(
	orgSlug: string,
	options: { orderId?: string | null } = {},
): string {
	const base = `/${orgSlug}/orders`
	return options.orderId
		? `${base}/${encodeURIComponent(options.orderId)}`
		: base
}
