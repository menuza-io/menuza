/**
 * Which Reservations screen a pathname is, for the layout chrome: the page
 * header, the section tabs and the context bar. Pure so it can be tested
 * without rendering.
 */

export type ReservationsRouteKey =
	| 'today'
	| 'book'
	| 'timeline'
	| 'floor'
	| 'calendar'
	| 'overview'
	| 'waitlist'
	| 'guests'
	| 'experiences'
	| 'reports'
	| 'settings'
	| 'other'

/** Day views the host stand works in: they carry a date, service and area. */
export const HOST_ROUTE_KEYS: readonly ReservationsRouteKey[] = [
	'today',
	'book',
	'timeline',
	'floor',
	'calendar',
	'overview',
]

/**
 * Screens that render their own `PageHeader` (and detail pages with a back
 * link). The layout renders its header for every other route.
 */
export const SELF_HEADED_ROUTE_KEYS: readonly ReservationsRouteKey[] = [
	'waitlist',
	'guests',
	'experiences',
	'reports',
]

const KNOWN: ReadonlySet<string> = new Set([
	'today',
	'book',
	'timeline',
	'floor',
	'calendar',
	'overview',
	'waitlist',
	'guests',
	'experiences',
	'reports',
	'settings',
])

export function reservationsRouteKey(
	pathname: string,
	orgSlug: string,
): ReservationsRouteKey {
	const prefix = `/${orgSlug}/reservations/`
	if (!pathname.startsWith(prefix)) return 'other'
	const segment = pathname.slice(prefix.length).split(/[/?#]/)[0] ?? ''
	return KNOWN.has(segment) ? (segment as ReservationsRouteKey) : 'other'
}

export function isHostRoute(key: ReservationsRouteKey): boolean {
	return HOST_ROUTE_KEYS.includes(key)
}

/** The section tab a route belongs to: every day view sits under Today. */
export function reservationsSectionTab(
	key: ReservationsRouteKey,
):
	| 'today'
	| 'calendar'
	| 'waitlist'
	| 'guests'
	| 'experiences'
	| 'reports'
	| 'settings'
	| null {
	switch (key) {
		case 'today':
		case 'book':
		case 'timeline':
		case 'floor':
		case 'overview':
			return 'today'
		case 'calendar':
		case 'waitlist':
		case 'guests':
		case 'experiences':
		case 'reports':
		case 'settings':
			return key
		default:
			return null
	}
}
