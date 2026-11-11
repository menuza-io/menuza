import { describe, expect, it } from 'vitest'
import { computeMenuHealth, type MenuHealthItem } from './menu-health.ts'
import {
	buildMenuSuggestionCandidates,
	MENU_SUGGESTION_LIMITS,
	parseDescriptionReply,
	pickSuggestionBatch,
	sanitizeSuggestionText,
} from './menu-suggestions.ts'

const NOW = new Date('2026-11-11T12:00:00Z')
const OLD = new Date('2026-10-01T12:00:00Z')

function item(id: string, patch: Partial<MenuHealthItem> = {}): MenuHealthItem {
	return {
		id,
		displayName: JSON.stringify({ en: id, ar: `${id} (ar)` }),
		description: JSON.stringify({ en: `About ${id}`, ar: `عن ${id}` }),
		price: 10,
		imageKey: 'x.jpg',
		imageUrl: null,
		imageKeys: '[]',
		variations: null,
		allergens: '["gluten"]',
		calorieMin: null,
		calorieMax: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		updatedAt: NOW,
		...patch,
	}
}

function candidatesFor(
	items: MenuHealthItem[],
	locales: Array<'en' | 'ar' | 'fr'> = ['en', 'ar'],
	categories: Array<{
		id: string
		parentId: string | null
		availabilityStatus: string
	}> = [],
	filled: string[] = [],
) {
	const health = computeMenuHealth({
		items,
		categories,
		categoryIdsWithItems: filled,
		locales,
		defaultLocale: 'en',
		now: NOW,
	})
	return buildMenuSuggestionCandidates({
		health,
		items,
		locales,
		defaultLocale: 'en',
	})
}

describe('buildMenuSuggestionCandidates', () => {
	it('orders translation, description, empty category, then long unavailable', () => {
		const candidates = candidatesFor(
			[
				item('stale', { availabilityStatus: 'unavailable', updatedAt: OLD }),
				item('plain', { description: null }),
				item('untranslated', {
					displayName: '{"en":"Falafel"}',
					description: '{"en":"Crispy"}',
				}),
			],
			['en', 'ar'],
			[
				{ id: 'empty', parentId: null, availabilityStatus: 'available' },
				{ id: 'full', parentId: null, availabilityStatus: 'available' },
			],
			['full'],
		)
		expect(candidates.map((candidate) => candidate.id)).toEqual([
			'translation:untranslated:ar',
			'description:plain',
			'empty_category:empty',
			'long_unavailable:stale',
		])
		expect(candidates[0]).toMatchObject({
			needsName: true,
			needsDescription: true,
		})
	})

	it('offers no translations for a menu with one language', () => {
		const candidates = candidatesFor(
			[item('solo', { displayName: '{"en":"Solo"}', description: null })],
			['en'],
		)
		expect(candidates.map((candidate) => candidate.kind)).toEqual([
			'description',
		])
	})

	it('never suggests for hidden dishes, photos, prices or allergens', () => {
		const candidates = candidatesFor([
			item('hidden', {
				availabilityStatus: 'hidden',
				description: null,
				displayName: '{"en":"Hidden"}',
			}),
			item('bare', {
				imageKey: null,
				price: 0,
				allergens: '[]',
			}),
		])
		expect(candidates).toEqual([])
	})

	it('asks only for the Arabic name when there is no description', () => {
		const [candidate] = candidatesFor([
			item('plain', { displayName: '{"en":"Plain"}', description: null }),
		])
		expect(candidate).toMatchObject({
			id: 'translation:plain:ar',
			needsName: true,
			needsDescription: false,
		})
	})

	it('skips dishes without a name in the source language', () => {
		const candidates = candidatesFor([
			item('arabic-only', {
				displayName: '{"ar":"فلافل"}',
				description: null,
			}),
		])
		expect(candidates).toEqual([])
	})
})

describe('pickSuggestionBatch', () => {
	it('leaves out seen ids and counts what is left', () => {
		const candidates = Array.from({ length: 13 }, (_, index) => ({
			kind: 'description' as const,
			id: `description:${index}`,
			itemId: String(index),
		}))
		const first = pickSuggestionBatch(candidates, [])
		expect(first.batch).toHaveLength(10)
		expect(first).toMatchObject({ remaining: 3, total: 13 })
		const second = pickSuggestionBatch(
			candidates,
			first.batch.map((candidate) => candidate.id),
		)
		expect(second.batch.map((candidate) => candidate.id)).toEqual([
			'description:10',
			'description:11',
			'description:12',
		])
		expect(second).toMatchObject({ remaining: 0, total: 3 })
	})
})

describe('sanitizeSuggestionText', () => {
	it('strips tags, nested tag tricks and angle brackets', () => {
		expect(
			sanitizeSuggestionText(
				'<p>Crispy <b>falafel</b></p><scr<script>ipt>alert(1)</script>',
				300,
			),
		).toBe('Crispy falafel alert(1)')
		expect(
			sanitizeSuggestionText('a <img src=x onerror=alert(1)> b', 300),
		).toBe('a b')
		expect(sanitizeSuggestionText('5 > 4 and 3 < 4', 300)).toBe('5 4 and 3 4')
	})

	it('decodes harmless entities but never turns them into tags', () => {
		expect(
			sanitizeSuggestionText('Fish &amp; chips &#39;n&#39; peas', 300),
		).toBe("Fish & chips 'n' peas")
		expect(sanitizeSuggestionText('&lt;b&gt;bold&lt;/b&gt;', 300)).not.toMatch(
			/[<>]/,
		)
	})

	it('drops markdown, wrapping quotes, control and direction characters', () => {
		expect(
			sanitizeSuggestionText('"**Grilled** chicken‮ with\n\nrice"', 300),
		).toBe('Grilled chicken with rice')
	})

	it('caps the length at a word boundary', () => {
		const long = 'word '.repeat(100)
		const clean = sanitizeSuggestionText(long, 50)
		expect(clean.length).toBeLessThanOrEqual(50)
		expect(clean.endsWith('word')).toBe(true)
	})

	it('returns an empty string for nothing useful', () => {
		expect(sanitizeSuggestionText(undefined, 10)).toBe('')
		expect(sanitizeSuggestionText(42, 10)).toBe('')
		expect(sanitizeSuggestionText('<br/>', 10)).toBe('')
	})
})

describe('parseDescriptionReply', () => {
	const asked = new Set(['description:a', 'description:b'])

	it('reads a fenced JSON reply and cleans each description', () => {
		const reply = [
			'Here you go:',
			'```json',
			JSON.stringify({
				descriptions: [
					{ id: 'description:a', description: '<i>Warm</i> flatbread.' },
					{ id: 'description:b', description: 'Slow-cooked lentil soup.' },
				],
			}),
			'```',
		].join('\n')
		expect(Object.fromEntries(parseDescriptionReply(reply, asked))).toEqual({
			'description:a': 'Warm flatbread.',
			'description:b': 'Slow-cooked lentil soup.',
		})
	})

	it('ignores ids it did not ask about, duplicates and rambling answers', () => {
		const reply = JSON.stringify({
			descriptions: [
				{ id: 'description:other-org', description: 'Not yours.' },
				{ id: 'description:a', description: 'First.' },
				{ id: 'description:a', description: 'Second.' },
				{ id: 'description:b', description: 'word '.repeat(200) },
			],
		})
		expect(Object.fromEntries(parseDescriptionReply(reply, asked))).toEqual({
			'description:a': 'First.',
		})
	})

	it('caps a long description', () => {
		const reply = JSON.stringify({
			descriptions: [{ id: 'description:a', description: 'x'.repeat(1_000) }],
		})
		expect(
			parseDescriptionReply(reply, asked).get('description:a')?.length,
		).toBe(MENU_SUGGESTION_LIMITS.description)
	})

	it('returns nothing for malformed replies', () => {
		expect(parseDescriptionReply('no json here', asked).size).toBe(0)
		expect(parseDescriptionReply('{"descriptions": "nope"}', asked).size).toBe(
			0,
		)
		expect(parseDescriptionReply('{broken', asked).size).toBe(0)
	})
})
