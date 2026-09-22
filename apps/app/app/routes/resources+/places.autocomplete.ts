import { type LoaderFunctionArgs } from 'react-router'
import { MOCK_PLACES } from '#app/utils/location/mock-places.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const url = new URL(request.url)
	const query = (url.searchParams.get('query') || '').trim().toLowerCase()
	const placeId = url.searchParams.get('placeId')

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
