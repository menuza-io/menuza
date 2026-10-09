import { requireUserId } from '@repo/auth'
import { GeocoderError, type GeoAddress } from '@repo/geo'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	getAppGeocoder,
	hasGoogleMapsKey,
} from '#app/utils/location/geocoder.server.ts'
import { MOCK_PLACES } from '#app/utils/location/mock-places.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

/**
 * Operator address search for store locations (App only; customer delivery
 * addresses go through the regional tenant-api instead).
 *
 * - `GOOGLE_MAPS_API_KEY` set → Google Maps Platform via `@repo/geo`.
 * - No key, and MOCKS=true or non-production → bundled mock addresses.
 * - Production without a key → empty results (never fake data).
 *
 * `?query=` returns predictions (with inline `details` only for mocks);
 * `?placeId=` returns `{ place }` details for one prediction.
 */
const mocksEnabled = () =>
	process.env.NODE_ENV !== 'production' || process.env.MOCKS === 'true'

const querySchema = z.object({
	query: z.string().trim().max(200).default(''),
	placeId: z.string().trim().min(1).max(512).optional(),
	sessionToken: z.string().trim().min(1).max(100).optional(),
	language: z
		.string()
		.regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/)
		.optional(),
})

/** The App's `LocationAddress` shape (as used by the location form). */
function toLocationDetails(place: GeoAddress) {
	return {
		formattedAddress: place.formatted,
		streetNumber: place.streetNumber ?? '',
		streetName: place.route ?? place.line1,
		unit: '',
		city: place.city,
		state: place.state,
		postalCode: place.postalCode,
		country: place.country,
		lat: place.lat,
		lng: place.lng,
	}
}

function mockResponse(query: string, placeId: string | undefined) {
	if (placeId) {
		const match = MOCK_PLACES.find((p) => p.placeId === placeId)
		return match
			? Response.json({ place: match.details })
			: Response.json({ error: 'Place not found' }, { status: 404 })
	}
	const needle = query.toLowerCase()
	if (!needle) return Response.json({ predictions: [] })
	const predictions = MOCK_PLACES.filter(
		(p) =>
			p.description.toLowerCase().includes(needle) ||
			p.details.city.toLowerCase().includes(needle) ||
			p.details.postalCode.toLowerCase().includes(needle),
	).map((m) => ({
		placeId: m.placeId,
		description: m.description,
		mainText: m.mainText,
		secondaryText: m.secondaryText,
		details: m.details,
	}))
	return Response.json({ predictions })
}

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid request' }, { status: 400 })
	}
	const { query, placeId, sessionToken } = parsed.data
	const language = parsed.data.language ?? 'en'

	if (!hasGoogleMapsKey()) {
		if (mocksEnabled()) return mockResponse(query, placeId)
		return placeId
			? Response.json({ error: 'Place not found' }, { status: 404 })
			: Response.json({ predictions: [] })
	}

	// Each lookup is a billed Google request: cap per operator.
	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		{ scope: 'places-autocomplete', maxRequests: 120, windowMs: 60 * 1000 },
	)
	if (!limit.allowed) {
		return Response.json({ error: 'Too many requests' }, { status: 429 })
	}

	const geocoder = getAppGeocoder()
	if (!geocoder) return Response.json({ predictions: [] })
	try {
		if (placeId) {
			const place = await geocoder.placeDetails(placeId, {
				sessionToken,
				language,
			})
			return place
				? Response.json({ place: toLocationDetails(place) })
				: Response.json({ error: 'Place not found' }, { status: 404 })
		}
		if (query.length < 3) return Response.json({ predictions: [] })
		const predictions = await geocoder.autocomplete(query, {
			sessionToken,
			language,
		})
		return Response.json({
			predictions: predictions.map((prediction) => ({
				...prediction,
				description: [prediction.mainText, prediction.secondaryText]
					.filter(Boolean)
					.join(', '),
			})),
		})
	} catch (error) {
		console.error(
			'Places lookup failed:',
			error instanceof GeocoderError ? error.message : 'unexpected error',
		)
		return Response.json(
			{ error: 'Address search is unavailable' },
			{ status: 503 },
		)
	}
}
