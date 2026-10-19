/**
 * Where a person lives in the App: the Customers list, or one profile
 * (`personKey` is `c_<customerId>` or `g_<guestId>`). The language rides along
 * so the page keeps it.
 */
export function customersHref(
	orgSlug: string,
	options: { personKey?: string | null; lng?: string | null } = {},
): string {
	const base = `/${orgSlug}/customers${
		options.personKey ? `/${encodeURIComponent(options.personKey)}` : ''
	}`
	return options.lng ? `${base}?lng=${encodeURIComponent(options.lng)}` : base
}
