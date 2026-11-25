/**
 * Geocoder contract shared by the Google provider and the dev fixtures.
 * Server-only: customer addresses go browser → regional tenant-api →
 * provider, never through Sites SSR.
 */

export type GeoAddress = {
	/** Full single-line address as the provider formats it. */
	formatted: string
	/** Street line ("123 Main St"); falls back to the first formatted segment. */
	line1: string
	city: string
	/** Region / state short code when available ("IL", "Riyadh Province"). */
	state: string
	postalCode: string
	/** ISO 3166-1 alpha-2, uppercase ("US", "SA"); empty when unknown. */
	country: string
	lat: number
	lng: number
	placeId: string
	/** Optional structured street parts (App location form). */
	streetNumber?: string
	route?: string
}

export type PlacePrediction = {
	placeId: string
	mainText: string
	secondaryText: string
}

export type AutocompleteOptions = {
	sessionToken?: string
	bias?: { lat: number; lng: number } | null
	/** ISO 3166-1 alpha-2 country to restrict results to. */
	country?: string | null
	language: string
}

export type PlaceDetailsOptions = {
	sessionToken?: string
	language: string
}

export type GeocodeOptions = {
	country?: string | null
	language: string
}

export interface Geocoder {
	/** Provider name for logs ("google" | "dev"). */
	readonly name: string
	autocomplete(
		query: string,
		options: AutocompleteOptions,
	): Promise<PlacePrediction[]>
	placeDetails(
		placeId: string,
		options: PlaceDetailsOptions,
	): Promise<GeoAddress | null>
	geocode(text: string, options: GeocodeOptions): Promise<GeoAddress | null>
}

/**
 * Thrown when the provider itself fails (network, quota, auth, malformed
 * response) as opposed to "no result". Callers map it to
 * `geocoding_unavailable` rather than `not_found`.
 */
export class GeocoderError extends Error {
	readonly status: number | null
	constructor(message: string, options: { status?: number | null } = {}) {
		super(message)
		this.name = 'GeocoderError'
		this.status = options.status ?? null
	}
}

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

/**
 * Driving distance between two points (#421). Server-only like the geocoder:
 * the customer's coordinates go browser to regional tenant-api to the routing
 * provider, and the result is never logged or stored beyond the signed quote.
 */
export type DrivingRoute = {
	/** Road distance in meters. */
	meters: number
	/** Estimated drive time, when the provider says. */
	seconds: number | null
}

export interface Router {
	/** Provider name for logs ("google" | "dev"). */
	readonly name: string
	/**
	 * The road route between two points, or `null` when the provider found no
	 * route. Throws `RouterError` when the provider itself fails; callers fall
	 * back to the straight-line distance.
	 */
	drivingDistance(
		from: { lat: number; lng: number },
		to: { lat: number; lng: number },
	): Promise<DrivingRoute | null>
}

/** The routing provider failed (network, quota, auth, malformed response). */
export class RouterError extends Error {
	readonly status: number | null
	constructor(message: string, options: { status?: number | null } = {}) {
		super(message)
		this.name = 'RouterError'
		this.status = options.status ?? null
	}
}
