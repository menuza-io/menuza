import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs } from 'react-router'
import { MOCK_PLACES } from '#app/utils/location/mock-places.ts'

// The real Google Places provider is not implemented yet. Until it is, this
// route must never fall back to the bundled mock addresses in production:
// returning fake data is misleading, and wiring in a real key would turn this
// route into an unauthenticated proxy for a billable third-party API.
const mocksEnabled =
	process.env.NODE_ENV !== 'production' || process['env'].MOCKS === 'true'

export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserId(request)

	const url = new URL(request.url)
	const query = (url.searchParams.get('query') || '').trim().toLowerCase()
	const placeId = url.searchParams.get('placeId')

	// In production there is no provider yet, so serve nothing rather than fakes.
	if (!mocksEnabled) {
		return placeId
			? Response.json({ error: 'Place not found' }, { status: 404 })
			: Response.json({ predictions: [] })
	}

	// If placeId requested, return single place details
	if (placeId) {
		const match = MOCK_PLACES.find((p) => p.placeId === placeId)
		if (match) {
			return Response.json({ place: match.details })
		}
		return Response.json({ error: 'Place not found' }, { status: 404 })
	}

	if (!query) {
		return Response.json({ predictions: [] })
	}

	// Filter mock places
	const matches = MOCK_PLACES.filter(
		(p) =>
			p.description.toLowerCase().includes(query) ||
			p.details.city.toLowerCase().includes(query) ||
			p.details.postalCode.toLowerCase().includes(query),
	)

	const predictions = matches.map((m) => ({
		placeId: m.placeId,
		description: m.description,
		mainText: m.mainText,
		secondaryText: m.secondaryText,
		details: m.details,
	}))

	return Response.json({ predictions })
}
