import { toAsciiDigits } from './coverage.ts'
import {
	type GeoAddress,
	type Geocoder,
	type PlacePrediction,
} from './types.ts'

/**
 * Deterministic geocoder for local development and tests. Never used in
 * production: callers only reach for it when no `GOOGLE_MAPS_API_KEY` is set
 * and `NODE_ENV !== 'production'`.
 *
 * Fixtures sit around the seeded acme store ("123 Demo Street, Chicago, IL
 * 60601" → 41.8853,-87.6229, 5-mile radius zone) so both in-zone and
 * out-of-zone flows can be demoed, plus a couple of Saudi addresses for the
 * KSA node.
 */

export type DevGeocoderFixture = {
	address: GeoAddress
	mainText: string
	secondaryText: string
	/** Extra lowercase phrases that should match this fixture. */
	aliases?: string[]
}

function fixture(
	placeId: string,
	line1: string,
	city: string,
	state: string,
	postalCode: string,
	country: string,
	lat: number,
	lng: number,
	aliases: string[] = [],
): DevGeocoderFixture {
	const countryName =
		country === 'US' ? 'USA' : country === 'SA' ? 'Saudi Arabia' : country
	const locality = [city, [state, postalCode].filter(Boolean).join(' ')]
		.filter(Boolean)
		.join(', ')
	return {
		address: {
			formatted: `${line1}, ${locality}, ${countryName}`,
			line1,
			city,
			state,
			postalCode,
			country,
			lat,
			lng,
			placeId,
		},
		mainText: line1,
		secondaryText: `${locality}, ${countryName}`,
		aliases,
	}
}

export const DEV_GEOCODER_FIXTURES: DevGeocoderFixture[] = [
	// --- Near the acme demo store (Chicago Loop) --------------------------
	fixture(
		'dev_chi_demo_street_123',
		'123 Demo Street',
		'Chicago',
		'IL',
		'60601',
		'US',
		41.8853,
		-87.6229,
		['123 demo st', 'menuza demo bistro'],
	),
	fixture(
		'dev_chi_michigan_789',
		'789 North Michigan Avenue',
		'Chicago',
		'IL',
		'60611',
		'US',
		41.897,
		-87.6244,
		['789 n michigan ave', '789 michigan'],
	),
	fixture(
		'dev_chi_wacker_233',
		'233 South Wacker Drive',
		'Chicago',
		'IL',
		'60606',
		'US',
		41.8789,
		-87.6359,
		['willis tower', '233 s wacker dr'],
	),
	fixture(
		'dev_chi_grand_600',
		'600 East Grand Avenue',
		'Chicago',
		'IL',
		'60611',
		'US',
		41.8917,
		-87.6086,
		['navy pier', '600 e grand ave'],
	),
	// ~7.5 km / 4.7 mi: just inside a 5-mile radius.
	fixture(
		'dev_chi_addison_1060',
		'1060 West Addison Street',
		'Chicago',
		'IL',
		'60613',
		'US',
		41.9484,
		-87.6553,
		['wrigley field', '1060 w addison st'],
	),
	// --- Out of range ------------------------------------------------------
	// ~10.9 km / 6.8 mi: just outside a 5-mile radius.
	fixture(
		'dev_chi_ellis_5801',
		'5801 South Ellis Avenue',
		'Chicago',
		'IL',
		'60637',
		'US',
		41.7886,
		-87.5987,
		['university of chicago', '5801 s ellis ave', 'hyde park'],
	),
	// ~18 km: Evanston.
	fixture(
		'dev_evanston_orrington_1603',
		'1603 Orrington Avenue',
		'Evanston',
		'IL',
		'60201',
		'US',
		42.0473,
		-87.6815,
		['1603 orrington ave'],
	),
	fixture(
		'dev_milwaukee_wells_800',
		'800 West Wells Street',
		'Milwaukee',
		'WI',
		'53233',
		'US',
		43.0401,
		-87.9214,
		['800 w wells st'],
	),
	fixture(
		'dev_nyc_fifth_350',
		'350 5th Avenue',
		'New York',
		'NY',
		'10118',
		'US',
		40.7484,
		-73.9857,
		['empire state building', '350 fifth avenue', '350 5th ave'],
	),
	// --- Saudi Arabia (KSA node) -------------------------------------------
	fixture(
		'dev_riyadh_king_fahd_kingdom_centre',
		'King Fahd Road, Kingdom Centre',
		'Riyadh',
		'Riyadh Province',
		'12214',
		'SA',
		24.7113,
		46.6744,
		['kingdom centre', 'king fahd road', 'al olaya'],
	),
	fixture(
		'dev_riyadh_tahlia_olaya',
		'Prince Mohammed Bin Abdulaziz Road',
		'Riyadh',
		'Riyadh Province',
		'12241',
		'SA',
		24.6958,
		46.6849,
		['tahlia street', 'prince mohammed bin abdulaziz'],
	),
	fixture(
		'dev_jeddah_corniche',
		'Corniche Road, Al Hamra',
		'Jeddah',
		'Makkah Province',
		'23323',
		'SA',
		21.5433,
		39.1728,
		['jeddah corniche', 'corniche road'],
	),
]

function normalize(value: string): string {
	return toAsciiDigits(value)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/\b(st)\b/g, 'street')
		.replace(/\b(ave)\b/g, 'avenue')
		.replace(/\b(dr)\b/g, 'drive')
		.replace(/\b(rd)\b/g, 'road')
		.replace(/[^a-z0-9؀-ۿ]+/g, ' ')
		.trim()
}

function searchableText(entry: DevGeocoderFixture): string {
	return normalize(
		[
			entry.address.formatted,
			entry.address.country,
			...(entry.aliases ?? []),
		].join(' '),
	)
}

function countryMatches(entry: DevGeocoderFixture, country?: string | null) {
	return !country || entry.address.country === country.toUpperCase()
}

/**
 * Matches when every query token appears in the fixture text, or when the
 * fixture's street line is contained in the query (full-address geocode).
 */
function matches(entry: DevGeocoderFixture, query: string): boolean {
	const normalizedQuery = normalize(query)
	if (!normalizedQuery) return false
	const haystack = searchableText(entry)
	const tokens = normalizedQuery.split(' ').filter(Boolean)
	if (tokens.every((token) => haystack.includes(token))) return true
	const line1 = normalize(entry.address.line1)
	if (line1 && normalizedQuery.includes(line1)) return true
	return (entry.aliases ?? []).some((alias) =>
		normalizedQuery.includes(normalize(alias)),
	)
}

export function createDevGeocoder(
	fixtures: DevGeocoderFixture[] = DEV_GEOCODER_FIXTURES,
): Geocoder {
	return {
		name: 'dev',

		async autocomplete(query, { country }) {
			if (query.trim().length < 3) return []
			const predictions: PlacePrediction[] = fixtures
				.filter(
					(entry) => countryMatches(entry, country) && matches(entry, query),
				)
				.slice(0, 5)
				.map((entry) => ({
					placeId: entry.address.placeId,
					mainText: entry.mainText,
					secondaryText: entry.secondaryText,
				}))
			return predictions
		},

		async placeDetails(placeId) {
			const entry = fixtures.find(
				(candidate) => candidate.address.placeId === placeId,
			)
			return entry ? { ...entry.address } : null
		},

		async geocode(text, { country }) {
			const entry = fixtures.find(
				(candidate) =>
					countryMatches(candidate, country) && matches(candidate, text),
			)
			return entry ? { ...entry.address } : null
		},
	}
}
