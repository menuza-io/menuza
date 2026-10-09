import { createDevGeocoder } from './dev.ts'
import { createGoogleGeocoder } from './google.ts'
import { type FetchLike, type Geocoder } from './types.ts'

export {
	haversineMeters,
	hasRealCoordinates,
	normalizePostalCode,
	pointInPolygon,
	resolveZoneForPoint,
	toAsciiDigits,
	type CoverageFailureReason,
	type CoverageLocation,
	type CoveragePoint,
	type CoverageZone,
	type LatLng,
	type ZoneResolution,
} from './coverage.ts'
export {
	createDevGeocoder,
	DEV_GEOCODER_FIXTURES,
	type DevGeocoderFixture,
} from './dev.ts'
export { createGoogleGeocoder, normalizeAddressComponents } from './google.ts'
export {
	GeocoderError,
	type AutocompleteOptions,
	type FetchLike,
	type GeoAddress,
	type Geocoder,
	type GeocodeOptions,
	type PlaceDetailsOptions,
	type PlacePrediction,
} from './types.ts'

/**
 * Picks the geocoder for a server runtime: Google when a key is configured,
 * the deterministic dev fixtures outside production, otherwise none (callers
 * then report `geocoding_unavailable`).
 */
export function selectGeocoder(options: {
	apiKey?: string | null
	isProduction: boolean
	fetch?: FetchLike
}): Geocoder | null {
	const apiKey = options.apiKey?.trim()
	if (apiKey) return createGoogleGeocoder({ apiKey, fetch: options.fetch })
	if (!options.isProduction) return createDevGeocoder()
	return null
}
