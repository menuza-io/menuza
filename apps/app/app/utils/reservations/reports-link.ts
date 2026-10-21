/**
 * Where Reservations "Reports" goes: the generic Reports page on its
 * Reservations category. The active location and the language ride along as
 * query parameters, so the templates open limited to that location and the
 * page keeps its language.
 */
export function reservationsReportsHref(
	orgSlug: string,
	options: { locationId?: string | null; lng?: string | null } = {},
): string {
	const query = new URLSearchParams({ category: 'Reservations' })
	if (options.locationId) query.set('location', options.locationId)
	if (options.lng) query.set('lng', options.lng)
	return `/${orgSlug}/reports?${query.toString()}`
}
