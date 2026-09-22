import { HttpResponse, http, type HttpHandler } from 'msw'

export interface MockPlace {
	placeId: string
	description: string
	mainText: string
	secondaryText: string
	details: {
		formattedAddress: string
		streetNumber: string
		streetName: string
		unit?: string
		city: string
		state: string
		postalCode: string
		country: string
		lat: number
		lng: number
	}
}

export const MOCK_PLACES: MockPlace[] = [
	{
		placeId: 'place_ny_main_123',
		description: '123 Main Street, New York, NY 10001, USA',
		mainText: '123 Main Street',
		secondaryText: 'New York, NY 10001, USA',
		details: {
			formattedAddress: '123 Main Street, New York, NY 10001, USA',
			streetNumber: '123',
			streetName: 'Main Street',
			unit: '',
			city: 'New York',
			state: 'NY',
			postalCode: '10001',
			country: 'United States',
			lat: 40.7128,
			lng: -74.006,
		},
	},
	{
		placeId: 'place_sf_market_456',
		description: '456 Market Street, San Francisco, CA 94105, USA',
		mainText: '456 Market Street',
		secondaryText: 'San Francisco, CA 94105, USA',
		details: {
			formattedAddress: '456 Market Street, San Francisco, CA 94105, USA',
			streetNumber: '456',
			streetName: 'Market Street',
			unit: 'Ste 100',
			city: 'San Francisco',
			state: 'CA',
			postalCode: '94105',
			country: 'United States',
			lat: 37.7915,
			lng: -122.3999,
		},
	},
	{
		placeId: 'place_chi_michigan_789',
		description: '789 North Michigan Avenue, Chicago, IL 60611, USA',
		mainText: '789 North Michigan Avenue',
		secondaryText: 'Chicago, IL 60611, USA',
		details: {
			formattedAddress: '789 North Michigan Avenue, Chicago, IL 60611, USA',
			streetNumber: '789',
			streetName: 'North Michigan Avenue',
			unit: '',
			city: 'Chicago',
			state: 'IL',
			postalCode: '60611',
			country: 'United States',
			lat: 41.897,
			lng: -87.6244,
		},
	},
	{
		placeId: 'place_riyadh_olaya_2100',
		description: 'King Fahd Road, Al Olaya, Riyadh 12211, Saudi Arabia',
		mainText: 'King Fahd Road',
		secondaryText: 'Al Olaya, Riyadh 12211, Saudi Arabia',
		details: {
			formattedAddress: 'King Fahd Road, Al Olaya, Riyadh 12211, Saudi Arabia',
			streetNumber: '2100',
			streetName: 'King Fahd Road',
			unit: '',
			city: 'Riyadh',
			state: 'Riyadh Province',
			postalCode: '12211',
			country: 'Saudi Arabia',
			lat: 24.7136,
			lng: 46.6753,
		},
	},
	{
		placeId: 'place_toronto_king_100',
		description: '100 King Street West, Toronto, ON M5X 1A9, Canada',
		mainText: '100 King Street West',
		secondaryText: 'Toronto, ON M5X 1A9, Canada',
		details: {
			formattedAddress: '100 King Street West, Toronto, ON M5X 1A9, Canada',
			streetNumber: '100',
			streetName: 'King Street West',
			unit: 'Floor 1',
			city: 'Toronto',
			state: 'ON',
			postalCode: 'M5X 1A9',
			country: 'Canada',
			lat: 43.6487,
			lng: -79.3817,
		},
	},
	{
		placeId: 'place_london_downing_10',
		description: '10 Downing Street, London SW1A 2AA, United Kingdom',
		mainText: '10 Downing Street',
		secondaryText: 'London SW1A 2AA, United Kingdom',
		details: {
			formattedAddress: '10 Downing Street, London SW1A 2AA, United Kingdom',
			streetNumber: '10',
			streetName: 'Downing Street',
			unit: '',
			city: 'London',
			state: 'Greater London',
			postalCode: 'SW1A 2AA',
			country: 'United Kingdom',
			lat: 51.5034,
			lng: -0.1276,
		},
	},
]

export const handlers: Array<HttpHandler> = [
	http.get(
		'https://maps.googleapis.com/maps/api/place/autocomplete/json',
		({ request }) => {
			const url = new URL(request.url)
			const input = (url.searchParams.get('input') || '').toLowerCase().trim()

			const matches = input
				? MOCK_PLACES.filter(
						(p) =>
							p.description.toLowerCase().includes(input) ||
							p.details.city.toLowerCase().includes(input) ||
							p.details.postalCode.toLowerCase().includes(input),
					)
				: MOCK_PLACES

			return HttpResponse.json({
				status: 'OK',
				predictions: matches.map((m) => ({
					place_id: m.placeId,
					description: m.description,
					structured_formatting: {
						main_text: m.mainText,
						secondary_text: m.secondaryText,
					},
				})),
			})
		},
	),

	http.get(
		'https://maps.googleapis.com/maps/api/place/details/json',
		({ request }) => {
			const url = new URL(request.url)
			const placeId = url.searchParams.get('place_id')

			const match = MOCK_PLACES.find((p) => p.placeId === placeId)
			if (!match) {
				return HttpResponse.json(
					{ status: 'ZERO_RESULTS', result: null },
					{ status: 404 },
				)
			}

			return HttpResponse.json({
				status: 'OK',
				result: {
					place_id: match.placeId,
					formatted_address: match.details.formattedAddress,
					geometry: {
						location: {
							lat: match.details.lat,
							lng: match.details.lng,
						},
					},
					address_components: [
						{
							long_name: match.details.streetNumber,
							short_name: match.details.streetNumber,
							types: ['street_number'],
						},
						{
							long_name: match.details.streetName,
							short_name: match.details.streetName,
							types: ['route'],
						},
						{
							long_name: match.details.city,
							short_name: match.details.city,
							types: ['locality'],
						},
						{
							long_name: match.details.state,
							short_name: match.details.state,
							types: ['administrative_area_level_1'],
						},
						{
							long_name: match.details.country,
							short_name: match.details.country,
							types: ['country'],
						},
						{
							long_name: match.details.postalCode,
							short_name: match.details.postalCode,
							types: ['postal_code'],
						},
					],
				},
			})
		},
	),
]
