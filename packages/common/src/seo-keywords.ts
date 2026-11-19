/**
 * Local search keywords and rank checks (#182, part 2). Pure: the App stores
 * keywords and checks, the rank provider fetches positions, and this module
 * holds the rules both share. Business data only, never guest data.
 */
import { cuisineLabel, getCuisine } from './cuisines.ts'

export const MAX_KEYWORDS_PER_LOCATION = 10
export const KEYWORD_MIN_LENGTH = 2
export const KEYWORD_MAX_LENGTH = 80
/** A rank past this is "not in the top 20", never 0. */
export const RANK_DEPTH = 20
/** Default grid: 5 by 5 points, 1 km apart. */
export const DEFAULT_GRID_SIZE = 5
export const DEFAULT_GRID_SPACING_METERS = 1000
/** Days between two checks of one keyword (weekly). */
export const RANK_CHECK_INTERVAL_DAYS = 7
/** Checks (one keyword, one grid) an organization may run per month. */
export const DEFAULT_MONTHLY_CHECK_BUDGET = 50
/** History of a removed keyword is kept this long, then purged. */
export const REMOVED_KEYWORD_RETENTION_DAYS = 90

export type KeywordLocale = 'en' | 'ar'

export type KeywordError =
	| 'keyword_too_short'
	| 'keyword_too_long'
	| 'keyword_exists'
	| 'too_many_keywords'

/** Lower-cased, single spaces, trimmed. */
export function normalizeKeyword(value: string): string {
	return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

const ARABIC = /[؀-ۿݐ-ݿ]/

/** The language a check runs in: Arabic when the phrase has Arabic letters. */
export function keywordLocale(phrase: string): KeywordLocale {
	return ARABIC.test(phrase) ? 'ar' : 'en'
}

export function validateKeyword(
	phrase: string,
	existing: readonly string[],
): { ok: true; phrase: string } | { ok: false; error: KeywordError } {
	const normalized = normalizeKeyword(phrase)
	if ([...normalized].length < KEYWORD_MIN_LENGTH)
		return { ok: false, error: 'keyword_too_short' }
	if ([...normalized].length > KEYWORD_MAX_LENGTH)
		return { ok: false, error: 'keyword_too_long' }
	const taken = new Set(existing.map(normalizeKeyword))
	if (taken.has(normalized)) return { ok: false, error: 'keyword_exists' }
	if (existing.length >= MAX_KEYWORDS_PER_LOCATION)
		return { ok: false, error: 'too_many_keywords' }
	return { ok: true, phrase: normalized }
}

/**
 * Suggested phrases from what the restaurant serves, its dishes and its city
 * ("lebanese restaurant riyadh", "shawarma near me"), in English and, when
 * the site speaks Arabic, Arabic. Already-added phrases are left out.
 */
export function suggestKeywords(input: {
	cuisines: readonly string[]
	dishes: readonly string[]
	city?: string | null
	area?: string | null
	includeArabic?: boolean
	existing?: readonly string[]
	limit?: number
}): string[] {
	const out: string[] = []
	const add = (phrase: string) => {
		const normalized = normalizeKeyword(phrase)
		if (
			normalized.length >= KEYWORD_MIN_LENGTH &&
			normalized.length <= KEYWORD_MAX_LENGTH &&
			!out.includes(normalized)
		) {
			out.push(normalized)
		}
	}
	const city = input.city?.trim()
	const area = input.area?.trim()
	for (const key of input.cuisines) {
		const cuisine = getCuisine(key)
		if (!cuisine) continue
		const name = cuisine.en.toLowerCase()
		if (city) add(`${name} restaurant ${city}`)
		if (area) add(`best ${name} in ${area}`)
		add(`${name} near me`)
		if (input.includeArabic) {
			const ar = cuisineLabel(key, 'ar')
			add(city ? `مطعم ${ar} ${city}` : `مطعم ${ar} قريب`)
		}
	}
	for (const dish of input.dishes.slice(0, 5)) {
		add(`${dish} near me`)
		if (city) add(`${dish} ${city}`)
	}
	if (city) add(`restaurants in ${city}`)
	const taken = new Set((input.existing ?? []).map(normalizeKeyword))
	return out.filter((phrase) => !taken.has(phrase)).slice(0, input.limit ?? 12)
}

export type GridPoint = { lat: number; lng: number }
export type RankedPoint = GridPoint & {
	/** 1 to 20, or null: not in the top 20. */
	rank: number | null
}

const METERS_PER_DEGREE_LAT = 111_320

/**
 * A square grid of points centred on the location, `size` by `size`,
 * `spacingMeters` apart, row by row from the north-west corner.
 */
export function buildRankGrid(
	center: GridPoint,
	size = DEFAULT_GRID_SIZE,
	spacingMeters = DEFAULT_GRID_SPACING_METERS,
): GridPoint[] {
	const half = (size - 1) / 2
	const dLat = spacingMeters / METERS_PER_DEGREE_LAT
	const dLng =
		spacingMeters /
		(METERS_PER_DEGREE_LAT *
			Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01))
	const points: GridPoint[] = []
	for (let row = 0; row < size; row++) {
		for (let col = 0; col < size; col++) {
			points.push({
				lat: round6(center.lat + (half - row) * dLat),
				lng: round6(center.lng + (col - half) * dLng),
			})
		}
	}
	return points
}

function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6
}

/** A provider rank, cleaned: 1 to 20, anything else is "not found" (null). */
export function cleanRank(value: unknown): number | null {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= RANK_DEPTH
		? value
		: null
}

/**
 * The average rank across the grid. A point where the location is not in the
 * top 20 counts as 21, so a grid that is mostly "not found" never looks
 * better than one where it shows up. Null when there are no points.
 */
export function averageRank(
	points: readonly { rank: number | null }[],
): number | null {
	if (!points.length) return null
	const total = points.reduce(
		(sum, point) => sum + (cleanRank(point.rank) ?? RANK_DEPTH + 1),
		0,
	)
	return Math.round((total / points.length) * 10) / 10
}

/** `YYYY-MM` in UTC: the budget month. */
export function budgetMonth(at: Date): string {
	return at.toISOString().slice(0, 7)
}

/**
 * Whether a keyword is due: never checked, or its last check (run or skipped)
 * is at least a week old.
 */
export function isKeywordDue(lastCheckedAt: Date | null, now: Date): boolean {
	if (!lastCheckedAt) return true
	return (
		now.getTime() - lastCheckedAt.getTime() >=
		RANK_CHECK_INTERVAL_DAYS * 86_400_000 - 60 * 60_000
	)
}

/** Coordinates a check can use, or null (`location_missing_coordinates`). */
export function locationCoordinates(address: unknown): GridPoint | null {
	let value = address
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== 'object') return null
	const { lat, lng } = value as { lat?: unknown; lng?: unknown }
	if (
		typeof lat !== 'number' ||
		typeof lng !== 'number' ||
		!Number.isFinite(lat) ||
		!Number.isFinite(lng) ||
		Math.abs(lat) > 90 ||
		Math.abs(lng) > 180 ||
		(lat === 0 && lng === 0)
	) {
		return null
	}
	return { lat, lng }
}

/**
 * Where a keyword points: the home page, a location page, a dish page or a
 * website page. Stored as text on `SeoKeyword.pageRef`.
 */
export type KeywordPageRef =
	| { kind: 'home' }
	| { kind: 'location'; id: string }
	| { kind: 'dish'; id: string }
	| { kind: 'page'; id: string }

export function parseKeywordPageRef(value: unknown): KeywordPageRef | null {
	if (typeof value !== 'string' || !value) return null
	if (value === 'home') return { kind: 'home' }
	const match = /^(location|dish|page):([A-Za-z0-9_-]{1,64})$/.exec(value)
	if (!match) return null
	return { kind: match[1] as 'location' | 'dish' | 'page', id: match[2]! }
}

export function formatKeywordPageRef(ref: KeywordPageRef): string {
	return ref.kind === 'home' ? 'home' : `${ref.kind}:${ref.id}`
}
