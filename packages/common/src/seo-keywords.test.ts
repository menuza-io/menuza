import { describe, expect, it } from 'vitest'
import {
	MAX_KEYWORDS_PER_LOCATION,
	averageRank,
	buildRankGrid,
	cleanRank,
	isKeywordDue,
	keywordLocale,
	locationCoordinates,
	parseKeywordPageRef,
	suggestKeywords,
	validateKeyword,
} from './seo-keywords.ts'

describe('keywords', () => {
	it('lower-cases and refuses duplicates, short and long phrases', () => {
		expect(validateKeyword('  Shawarma   Near Me ', [])).toEqual({
			ok: true,
			phrase: 'shawarma near me',
		})
		expect(validateKeyword('SHAWARMA near me', ['shawarma near me'])).toEqual({
			ok: false,
			error: 'keyword_exists',
		})
		expect(validateKeyword('a', [])).toEqual({
			ok: false,
			error: 'keyword_too_short',
		})
		expect(validateKeyword('x'.repeat(81), [])).toEqual({
			ok: false,
			error: 'keyword_too_long',
		})
	})

	it('allows at most ten per location', () => {
		const existing = Array.from(
			{ length: MAX_KEYWORDS_PER_LOCATION },
			(_, i) => `keyword ${i}`,
		)
		expect(validateKeyword('one more', existing)).toEqual({
			ok: false,
			error: 'too_many_keywords',
		})
		expect(validateKeyword('one more', existing.slice(1))).toMatchObject({
			ok: true,
		})
	})

	it('detects the keyword language', () => {
		expect(keywordLocale('مطعم لبناني الرياض')).toBe('ar')
		expect(keywordLocale('lebanese restaurant')).toBe('en')
	})

	it('suggests phrases from cuisine, dishes and city', () => {
		const suggestions = suggestKeywords({
			cuisines: ['lebanese'],
			dishes: ['Shawarma'],
			city: 'Riyadh',
			includeArabic: true,
			existing: ['lebanese near me'],
		})
		expect(suggestions).toContain('lebanese restaurant riyadh')
		expect(suggestions).toContain('shawarma near me')
		expect(suggestions).toContain('مطعم لبناني riyadh')
		expect(suggestions).not.toContain('lebanese near me')
	})
})

describe('rank grid', () => {
	it('builds a 5 by 5 grid centred on the location, 1 km apart', () => {
		const grid = buildRankGrid({ lat: 24.7, lng: 46.7 })
		expect(grid).toHaveLength(25)
		expect(grid[12]).toEqual({ lat: 24.7, lng: 46.7 })
		// About 1 km per step north-south.
		expect((grid[7]!.lat - grid[12]!.lat) * 111_320).toBeCloseTo(1000, -1)
	})

	it('treats not found as 21 in the average, never 0', () => {
		expect(cleanRank(0)).toBeNull()
		expect(cleanRank(21)).toBeNull()
		expect(cleanRank(3)).toBe(3)
		expect(averageRank([{ rank: 1 }, { rank: 3 }])).toBe(2)
		expect(averageRank([{ rank: 1 }, { rank: null }])).toBe(11)
		expect(averageRank([])).toBeNull()
	})

	it('needs real coordinates', () => {
		expect(locationCoordinates('{"lat":24.7,"lng":46.7}')).toEqual({
			lat: 24.7,
			lng: 46.7,
		})
		expect(locationCoordinates('{"lat":0,"lng":0}')).toBeNull()
		expect(locationCoordinates({ city: 'Riyadh' })).toBeNull()
	})

	it('is due weekly', () => {
		const now = new Date('2026-11-19T00:00:00Z')
		expect(isKeywordDue(null, now)).toBe(true)
		expect(isKeywordDue(new Date('2026-11-15T00:00:00Z'), now)).toBe(false)
		expect(isKeywordDue(new Date('2026-11-12T00:00:00Z'), now)).toBe(true)
	})

	it('parses page links', () => {
		expect(parseKeywordPageRef('home')).toEqual({ kind: 'home' })
		expect(parseKeywordPageRef('dish:abc')).toEqual({ kind: 'dish', id: 'abc' })
		expect(parseKeywordPageRef('evil:abc')).toBeNull()
	})
})
