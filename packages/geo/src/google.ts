import { z } from 'zod'

import {
	GeocoderError,
	type FetchLike,
	type GeoAddress,
	type Geocoder,
	type PlacePrediction,
} from './types.ts'

/**
 * Google Maps Platform provider over plain `fetch` (Workers + Node).
 *
 * - Autocomplete + details: Places API (New), with session tokens so a typed
 *   search and its final details lookup bill as one session.
 * - Free-text geocode: Geocoding API.
 *
 * Responses are validated with Zod and normalized to `GeoAddress`.
 */

const PLACES_BASE_URL = 'https://places.googleapis.com/v1'
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const REQUEST_TIMEOUT_MS = 5_000
const BIAS_RADIUS_METERS = 30_000
const MAX_PREDICTIONS = 5
const PLACE_ID_REGEX = /^[A-Za-z0-9_-]{1,512}$/

const textSchema = z.object({ text: z.string() }).partial()

const autocompleteResponseSchema = z.object({
	suggestions: z
		.array(
			z.object({
				placePrediction: z
					.object({
						placeId: z.string(),
						text: textSchema.optional(),
						structuredFormat: z
							.object({
								mainText: textSchema.optional(),
								secondaryText: textSchema.optional(),
							})
							.optional(),
					})
					.optional(),
			}),
		)
		.default([]),
})

const placeComponentSchema = z.object({
	longText: z.string().default(''),
	shortText: z.string().default(''),
	types: z.array(z.string()).default([]),
})

const placeDetailsResponseSchema = z.object({
	id: z.string(),
	formattedAddress: z.string().default(''),
	location: z.object({ latitude: z.number(), longitude: z.number() }),
	addressComponents: z.array(placeComponentSchema).default([]),
})

const geocodeComponentSchema = z.object({
	long_name: z.string().default(''),
	short_name: z.string().default(''),
	types: z.array(z.string()).default([]),
})

const geocodeResponseSchema = z.object({
	status: z.string(),
	error_message: z.string().optional(),
	results: z
		.array(
			z.object({
				place_id: z.string().default(''),
				formatted_address: z.string().default(''),
				geometry: z.object({
					location: z.object({ lat: z.number(), lng: z.number() }),
				}),
				address_components: z.array(geocodeComponentSchema).default([]),
			}),
		)
		.default([]),
})

type AddressComponent = { long: string; short: string; types: string[] }

function pick(
	components: AddressComponent[],
	type: string,
	form: 'long' | 'short' = 'long',
): string {
	const found = components.find((component) => component.types.includes(type))
	return found ? found[form].trim() : ''
}

/** Builds a normalized `GeoAddress` from provider address components. */
export function normalizeAddressComponents(input: {
	placeId: string
	formatted: string
	lat: number
	lng: number
	components: AddressComponent[]
}): GeoAddress {
	const { components } = input
	const streetNumber = pick(components, 'street_number')
	const route = pick(components, 'route')
	const premise = pick(components, 'premise')
	const firstSegment = input.formatted.split(',')[0]?.trim() ?? ''
	const line1 =
		[streetNumber, route].filter(Boolean).join(' ') ||
		premise ||
		route ||
		firstSegment
	const city =
		pick(components, 'locality') ||
		pick(components, 'postal_town') ||
		pick(components, 'sublocality_level_1') ||
		pick(components, 'sublocality') ||
		pick(components, 'administrative_area_level_2') ||
		pick(components, 'administrative_area_level_1')
	return {
		formatted: input.formatted || line1,
		line1,
		city,
		state: pick(components, 'administrative_area_level_1', 'short'),
		postalCode: pick(components, 'postal_code'),
		country: pick(components, 'country', 'short').toUpperCase(),
		lat: input.lat,
		lng: input.lng,
		placeId: input.placeId,
		...(streetNumber ? { streetNumber } : {}),
		...(route ? { route } : {}),
	}
}

async function readJson(response: Response, label: string): Promise<unknown> {
	try {
		return await response.json()
	} catch {
		throw new GeocoderError(`${label}: invalid JSON response`, {
			status: response.status,
		})
	}
}

export function createGoogleGeocoder(options: {
	apiKey: string
	fetch?: FetchLike
	timeoutMs?: number
}): Geocoder {
	const apiKey = options.apiKey.trim()
	if (!apiKey) throw new Error('createGoogleGeocoder requires an apiKey')
	const doFetch: FetchLike =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init))
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

	async function request(
		url: string,
		init: RequestInit,
		label: string,
	): Promise<Response> {
		let response: Response
		try {
			response = await doFetch(url, {
				...init,
				redirect: 'error',
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (error) {
			throw new GeocoderError(
				`${label}: request failed (${error instanceof Error ? error.message : 'network error'})`,
			)
		}
		return response
	}

	return {
		name: 'google',

		async autocomplete(query, { sessionToken, bias, country, language }) {
			const input = query.trim()
			if (input.length < 3) return []
			const body: Record<string, unknown> = {
				input,
				languageCode: language,
			}
			if (sessionToken) body.sessionToken = sessionToken
			if (country) body.includedRegionCodes = [country.toLowerCase()]
			if (bias) {
				body.locationBias = {
					circle: {
						center: { latitude: bias.lat, longitude: bias.lng },
						radius: BIAS_RADIUS_METERS,
					},
				}
			}
			const response = await request(
				`${PLACES_BASE_URL}/places:autocomplete`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Goog-Api-Key': apiKey,
						'X-Goog-FieldMask':
							'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
					},
					body: JSON.stringify(body),
				},
				'places:autocomplete',
			)
			if (!response.ok) {
				throw new GeocoderError(
					`places:autocomplete failed with HTTP ${response.status}`,
					{ status: response.status },
				)
			}
			const parsed = autocompleteResponseSchema.safeParse(
				await readJson(response, 'places:autocomplete'),
			)
			if (!parsed.success) {
				throw new GeocoderError('places:autocomplete: unexpected response')
			}
			const predictions: PlacePrediction[] = []
			for (const suggestion of parsed.data.suggestions) {
				const prediction = suggestion.placePrediction
				if (!prediction?.placeId) continue
				const full = prediction.text?.text ?? ''
				const mainText =
					prediction.structuredFormat?.mainText?.text ??
					full.split(',')[0]?.trim() ??
					full
				const secondaryText =
					prediction.structuredFormat?.secondaryText?.text ??
					full.split(',').slice(1).join(',').trim()
				predictions.push({
					placeId: prediction.placeId,
					mainText,
					secondaryText,
				})
				if (predictions.length >= MAX_PREDICTIONS) break
			}
			return predictions
		},

		async placeDetails(placeId, { sessionToken, language }) {
			if (!PLACE_ID_REGEX.test(placeId)) return null
			const params = new URLSearchParams({ languageCode: language })
			if (sessionToken) params.set('sessionToken', sessionToken)
			const response = await request(
				`${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}?${params.toString()}`,
				{
					method: 'GET',
					headers: {
						'X-Goog-Api-Key': apiKey,
						'X-Goog-FieldMask':
							'id,formattedAddress,addressComponents,location',
					},
				},
				'places:details',
			)
			if (response.status === 404 || response.status === 400) return null
			if (!response.ok) {
				throw new GeocoderError(
					`places:details failed with HTTP ${response.status}`,
					{ status: response.status },
				)
			}
			const parsed = placeDetailsResponseSchema.safeParse(
				await readJson(response, 'places:details'),
			)
			if (!parsed.success) return null
			const place = parsed.data
			return normalizeAddressComponents({
				placeId: place.id,
				formatted: place.formattedAddress,
				lat: place.location.latitude,
				lng: place.location.longitude,
				components: place.addressComponents.map((component) => ({
					long: component.longText,
					short: component.shortText,
					types: component.types,
				})),
			})
		},

		async geocode(text, { country, language }) {
			const address = text.trim()
			if (address.length < 3) return null
			const params = new URLSearchParams({ address, key: apiKey, language })
			if (country) {
				params.set('components', `country:${country.toUpperCase()}`)
				params.set('region', country.toLowerCase())
			}
			const response = await request(
				`${GEOCODE_URL}?${params.toString()}`,
				{ method: 'GET', headers: { Accept: 'application/json' } },
				'geocode',
			)
			if (!response.ok) {
				throw new GeocoderError(`geocode failed with HTTP ${response.status}`, {
					status: response.status,
				})
			}
			const parsed = geocodeResponseSchema.safeParse(
				await readJson(response, 'geocode'),
			)
			if (!parsed.success) {
				throw new GeocoderError('geocode: unexpected response')
			}
			if (parsed.data.status === 'ZERO_RESULTS') return null
			if (parsed.data.status !== 'OK') {
				throw new GeocoderError(
					`geocode failed with status ${parsed.data.status}`,
				)
			}
			const result = parsed.data.results[0]
			if (!result) return null
			return normalizeAddressComponents({
				placeId: result.place_id,
				formatted: result.formatted_address,
				lat: result.geometry.location.lat,
				lng: result.geometry.location.lng,
				components: result.address_components.map((component) => ({
					long: component.long_name,
					short: component.short_name,
					types: component.types,
				})),
			})
		},
	}
}
