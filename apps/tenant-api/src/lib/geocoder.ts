import { ENV } from 'varlock/env'

import { selectGeocoder, type Geocoder } from '@repo/geo'

import { syncEnvFromProcess } from './secrets.ts'

let override: Geocoder | null | undefined

function isProduction(): boolean {
	const nodeEnv =
		(typeof process !== 'undefined' ? process.env.NODE_ENV : undefined) ??
		(ENV as { NODE_ENV?: string }).NODE_ENV
	return nodeEnv === 'production'
}

/**
 * Geocoder for customer delivery addresses on this regional node. Google Maps
 * Platform when `GOOGLE_MAPS_API_KEY` is set; deterministic dev fixtures in
 * development/test; `null` in production without a key (quotes then answer
 * `unavailable/geocoding_unavailable`). Calls are plain `fetch`, so the same
 * code runs on the US Worker and the KSA Node runtime.
 */
export function getGeocoder(): Geocoder | null {
	if (override !== undefined) return override
	syncEnvFromProcess()
	let apiKey = ''
	try {
		apiKey = (ENV as { GOOGLE_MAPS_API_KEY?: string }).GOOGLE_MAPS_API_KEY ?? ''
	} catch {
		// Env resolved before the key joined the schema: treat as unset.
	}
	return selectGeocoder({
		apiKey,
		isProduction: isProduction(),
	})
}

export function isGeocodingAvailable(): boolean {
	return getGeocoder() !== null
}

/** Test hook: force a geocoder (or `null`); pass `undefined` to reset. */
export function setGeocoderForTesting(geocoder: Geocoder | null | undefined) {
	override = geocoder
}
