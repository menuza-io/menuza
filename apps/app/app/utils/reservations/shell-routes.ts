/**
 * Which Reservations screen a pathname is, for the layout chrome: the page
 * header, the section tabs and the context bar. Pure so it can be tested
 * without rendering. Reports is not a Reservations screen: it is the generic
 * Reports page (see `reservationsReportsHref`), so it has no route key here.
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
 * Detail pages (a guest profile, an experience editor) are a focused task with
 * a back link and the record's own title, so they render their own
 * `PageHeader` and the layout adds no header and no section tabs. Every other
 * route gets the layout header, then one tab bar.
 */
const DETAIL_PARENTS: ReadonlySet<string> = new Set(['guests', 'experiences'])

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
		case 'settings':
			return key
		default:
			return null
	}
}

/** True for `guests/<id>` and `experiences/<id>`: the screen owns its header. */
export function isDetailRoute(pathname: string, orgSlug: string): boolean {
	const prefix = `/${orgSlug}/reservations/`
	if (!pathname.startsWith(prefix)) return false
	const [parent, child] = pathname
		.slice(prefix.length)
		.split(/[?#]/)[0]!
		.split('/')
	return Boolean(parent && child && DETAIL_PARENTS.has(parent))
}
