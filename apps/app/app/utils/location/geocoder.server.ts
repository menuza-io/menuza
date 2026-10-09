import { hasRealCoordinates, selectGeocoder, type Geocoder } from '@repo/geo'
import { ENV } from 'varlock/env'

/**
 * Store-address geocoding for the App (operator side). Google Maps Platform
 * when `GOOGLE_MAPS_API_KEY` is set; deterministic dev fixtures outside
 * production; nothing in production without a key.
 *
 * Only store addresses are geocoded here — customer delivery addresses are
 * geocoded by the regional tenant-api, never by the App.
 */
function googleMapsApiKey(): string {
	try {
		return ENV.GOOGLE_MAPS_API_KEY?.trim() ?? ''
	} catch {
		// Older resolved env (process started before the key joined the schema).
		return ''
	}
}

export function getAppGeocoder(): Geocoder | null {
	return selectGeocoder({
		apiKey: googleMapsApiKey(),
		isProduction: process.env.NODE_ENV === 'production',
	})
}

/** True when a real Google key is configured (not the dev fixtures). */
export function hasGoogleMapsKey(): boolean {
	return googleMapsApiKey() !== ''
}

function countryHint(country: unknown): string | null {
	const value = typeof country === 'string' ? country.trim().toUpperCase() : ''
	if (['SA', 'SAU', 'SAUDI ARABIA'].includes(value)) return 'SA'
	if (['CA', 'CAN', 'CANADA'].includes(value)) return 'CA'
	if (['US', 'USA', 'UNITED STATES'].includes(value)) return 'US'
	return /^[A-Z]{2}$/.test(value) ? value : null
}

/** Single-line text for a stored `LocationAddress`-shaped object. */
export function addressQueryText(address: Record<string, unknown>): string {
	const formatted =
		typeof address.formattedAddress === 'string'
			? address.formattedAddress.trim()
			: ''
	if (formatted) return formatted
	return [
		'streetNumber',
		'streetName',
		'city',
		'state',
		'postalCode',
		'country',
	]
		.map((key) => address[key])
		.filter((part): part is string => typeof part === 'string' && part !== '')
		.join(', ')
}

export type EnsureCoordinatesResult = {
	/** Address JSON to store (unchanged when nothing was geocoded). */
	address: string | null
	status: 'unchanged' | 'geocoded' | 'not_found' | 'unavailable' | 'error'
	lat?: number
	lng?: number
}

/**
 * When a stored location address has no real coordinates (missing or 0,0),
 * geocodes it and writes lat/lng into the JSON. Best effort: a failure keeps
 * the original address so saving a location never breaks on the geocoder.
 */
export async function ensureLocationCoordinates(
	addressJson: string | null | undefined,
	geocoder: Geocoder | null = getAppGeocoder(),
): Promise<EnsureCoordinatesResult> {
	if (!addressJson) return { address: addressJson ?? null, status: 'unchanged' }
	let address: Record<string, unknown>
	try {
		const parsed: unknown = JSON.parse(addressJson)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { address: addressJson, status: 'unchanged' }
		}
		address = parsed as Record<string, unknown>
	} catch {
		return { address: addressJson, status: 'unchanged' }
	}
	if (
		hasRealCoordinates({
			lat: typeof address.lat === 'number' ? address.lat : null,
			lng: typeof address.lng === 'number' ? address.lng : null,
		})
	) {
		return { address: addressJson, status: 'unchanged' }
	}
	const text = addressQueryText(address)
	if (text.length < 3) return { address: addressJson, status: 'unchanged' }
	if (!geocoder) return { address: addressJson, status: 'unavailable' }
	try {
		const result = await geocoder.geocode(text, {
			country: countryHint(address.country),
			language: 'en',
		})
		if (!result || !hasRealCoordinates(result)) {
			return { address: addressJson, status: 'not_found' }
		}
		return {
			address: JSON.stringify({ ...address, lat: result.lat, lng: result.lng }),
			status: 'geocoded',
			lat: result.lat,
			lng: result.lng,
		}
	} catch (error) {
		console.warn(
			'Store address geocoding failed:',
			error instanceof Error ? error.message : error,
		)
		return { address: addressJson, status: 'error' }
	}
}
