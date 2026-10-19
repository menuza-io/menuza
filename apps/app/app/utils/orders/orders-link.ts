/** Where an order lives in the App: the Orders page, optionally opened on one order. */
export function ordersHref(
	orgSlug: string,
	options: { orderId?: string | null } = {},
): string {
	const base = `/${orgSlug}/orders`
	return options.orderId
		? `${base}?order=${encodeURIComponent(options.orderId)}`
		: base
}
