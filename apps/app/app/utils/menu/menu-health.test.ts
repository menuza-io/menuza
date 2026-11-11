import { describe, expect, test } from 'vitest'
import {
	computeMenuHealth,
	getMenuHealthFixes,
	MENU_HEALTH_WEIGHTS,
	type MenuHealthCategory,
	type MenuHealthInput,
	type MenuHealthItem,
	parseMenuHealthCheckKey,
} from './menu-health.ts'

const NOW = new Date('2026-11-11T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function item(overrides: Partial<MenuHealthItem> = {}): MenuHealthItem {
	return {
		id: 'item',
		displayName: JSON.stringify({ en: 'Hummus', ar: 'حمص' }),
		description: JSON.stringify({ en: 'Chickpeas', ar: 'حمص بالطحينة' }),
		price: 8,
		imageKey: 'menu/hummus.jpg',
		imageUrl: null,
		imageKeys: '[]',
		variations: '{"groups":[],"variants":[]}',
		allergens: '["sesame"]',
		calorieMin: null,
		calorieMax: null,
		availabilityStatus: 'available',
		unavailableUntil: null,
		updatedAt: new Date(NOW.getTime() - 30 * DAY),
		...overrides,
	}
}

function category(
	overrides: Partial<MenuHealthCategory> = {},
): MenuHealthCategory {
	return {
		id: 'cat',
		parentId: null,
		availabilityStatus: 'available',
		...overrides,
	}
}

function run(overrides: Partial<MenuHealthInput> = {}) {
	return computeMenuHealth({
		items: [item()],
		categories: [category()],
		categoryIdsWithItems: ['cat'],
		locales: ['en'],
		defaultLocale: 'en',
		now: NOW,
		...overrides,
	})
}

function check(health: ReturnType<typeof run>, key: string) {
	return health.checks.find((c) => c.key === key)
}

describe('computeMenuHealth', () => {
	test('a complete menu scores 100 with nothing to fix', () => {
		const health = run()
		expect(health.score).toBe(100)
		expect(getMenuHealthFixes(health)).toEqual([])
	})

	test('an empty menu has no checks and no item count', () => {
		const health = run({ items: [], categories: [], categoryIdsWithItems: [] })
		expect(health).toEqual({ score: 100, checks: [], itemCount: 0 })
	})

	test('counts dishes with no photo, accepting any of the three image fields', () => {
		const health = run({
			items: [
				item({ id: 'a', imageKey: null }),
				item({ id: 'b', imageKey: null, imageUrl: 'https://x/y.jpg' }),
				item({ id: 'c', imageKey: null, imageKeys: '["k1"]' }),
				item({ id: 'd', imageKey: '  ', imageKeys: 'not json' }),
			],
		})
		expect(check(health, 'no_photo')).toMatchObject({
			count: 2,
			total: 4,
			itemIds: ['a', 'd'],
			severity: 'warning',
		})
	})

	test('a plain-string or localized description counts; blank does not', () => {
		const health = run({
			items: [
				item({ id: 'plain', description: 'Legacy text' }),
				item({ id: 'blank', description: JSON.stringify({ en: '  ' }) }),
				item({ id: 'null', description: null }),
			],
		})
		expect(check(health, 'no_description')?.itemIds).toEqual(['blank', 'null'])
	})

	test('a zero base price is fine when a variant has a price', () => {
		const health = run({
			items: [
				item({ id: 'free', price: 0 }),
				item({
					id: 'sized',
					price: 0,
					variations: JSON.stringify({
						groups: [],
						variants: [{ id: 'v', valueIds: ['s'], price: 5 }],
					}),
				}),
			],
		})
		expect(check(health, 'zero_price')).toMatchObject({
			count: 1,
			itemIds: ['free'],
			severity: 'error',
		})
	})

	test('one zero price costs at least half its weight', () => {
		const items = Array.from({ length: 100 }, (_, i) => item({ id: `i${i}` }))
		items[0] = item({ id: 'i0', price: 0 })
		const health = run({ items })
		const totalWeight = Object.values(MENU_HEALTH_WEIGHTS).reduce(
			(a, b) => a + b,
			0,
		)
		// Translation is skipped (English only), so its weight is left out.
		const applicable = totalWeight - MENU_HEALTH_WEIGHTS.missing_translation
		const expected = Math.round(
			(100 * (applicable - MENU_HEALTH_WEIGHTS.zero_price * 0.505)) /
				applicable,
		)
		expect(health.score).toBe(expected)
		expect(health.score).toBeLessThan(93)
	})

	test('photos and descriptions weigh most', () => {
		const noPhotos = run({
			items: [item({ imageKey: null })],
		})
		const noAllergens = run({
			items: [item({ allergens: '[]' })],
		})
		expect(noPhotos.score).toBeLessThan(noAllergens.score)
	})

	test('a menu with any problem never rounds up to 100', () => {
		const items = Array.from({ length: 500 }, (_, i) => item({ id: `i${i}` }))
		items[0] = item({ id: 'i0', allergens: '[]' })
		expect(run({ items }).score).toBe(99)
	})

	describe('translations', () => {
		test('skipped when the site has one locale', () => {
			const health = run({
				items: [item({ displayName: 'Hummus', description: 'Chickpeas' })],
			})
			expect(check(health, 'missing_translation')).toBeUndefined()
		})

		test('counts a missing Arabic name or description when Arabic is on', () => {
			const health = run({
				locales: ['en', 'ar'],
				items: [
					item({ id: 'ok' }),
					item({ id: 'plain', displayName: 'Hummus' }),
					item({
						id: 'no-ar-desc',
						description: JSON.stringify({ en: 'Chickpeas' }),
					}),
					item({
						id: 'no-desc-at-all',
						description: null,
					}),
				],
			})
			expect(check(health, 'missing_translation')).toMatchObject({
				locales: ['ar'],
				itemIds: ['plain', 'no-ar-desc'],
			})
		})

		test('checks the other locales when Arabic is the default', () => {
			const health = run({
				locales: ['ar', 'en'],
				defaultLocale: 'ar',
				items: [item({ id: 'ar-only', displayName: 'حمص', description: null })],
			})
			expect(check(health, 'missing_translation')).toMatchObject({
				locales: ['en'],
				itemIds: ['ar-only'],
			})
		})
	})

	test('allergens or calories: either one is enough', () => {
		const health = run({
			items: [
				item({ id: 'none', allergens: '[]' }),
				item({ id: 'cal', allergens: '[]', calorieMin: 300 }),
				item({ id: 'bad-json', allergens: 'oops' }),
			],
		})
		expect(check(health, 'no_allergens_or_calories')).toMatchObject({
			severity: 'info',
			itemIds: ['none', 'bad-json'],
		})
	})

	test('long unavailable: off for over a week with no return soon', () => {
		const old = new Date(NOW.getTime() - 10 * DAY)
		const health = run({
			items: [
				item({ id: 'off', availabilityStatus: 'unavailable', updatedAt: old }),
				item({
					id: 'recent',
					availabilityStatus: 'unavailable',
					updatedAt: new Date(NOW.getTime() - 2 * DAY),
				}),
				item({
					id: 'until-future',
					availabilityStatus: 'unavailable_until',
					unavailableUntil: new Date(NOW.getTime() + DAY),
					updatedAt: old,
				}),
				item({
					id: 'until-past',
					availabilityStatus: 'unavailable_until',
					unavailableUntil: new Date(NOW.getTime() - DAY),
					updatedAt: old,
				}),
				item({
					id: 'tomorrow',
					availabilityStatus: 'unavailable_until_tomorrow',
					updatedAt: old,
				}),
			],
		})
		expect(check(health, 'long_unavailable')?.itemIds).toEqual([
			'off',
			'until-future',
		])
	})

	test('hidden dishes are left out of every check', () => {
		const health = run({
			items: [
				item({ id: 'shown' }),
				item({ id: 'hidden', availabilityStatus: 'hidden', price: 0 }),
			],
		})
		expect(health.itemCount).toBe(1)
		expect(check(health, 'zero_price')).toMatchObject({ count: 0, total: 1 })
	})

	test('empty categories: no items and no subcategories', () => {
		const health = run({
			categories: [
				category({ id: 'full' }),
				category({ id: 'parent' }),
				category({ id: 'child', parentId: 'parent' }),
				category({ id: 'empty' }),
				category({ id: 'hidden', availabilityStatus: 'hidden' }),
			],
			categoryIdsWithItems: ['full', 'child'],
		})
		expect(check(health, 'empty_category')).toMatchObject({
			count: 1,
			total: 4,
			categoryIds: ['empty'],
		})
	})

	test('fixes are ordered errors first, then by weight', () => {
		const health = run({
			items: [
				item({
					price: 0,
					imageKey: null,
					description: null,
					allergens: '[]',
				}),
			],
			categories: [category(), category({ id: 'empty' })],
		})
		expect(getMenuHealthFixes(health).map((c) => c.key)).toEqual([
			'zero_price',
			'no_photo',
			'no_description',
			'empty_category',
			'no_allergens_or_calories',
		])
	})
})

test('parseMenuHealthCheckKey accepts known keys only', () => {
	expect(parseMenuHealthCheckKey('no_photo')).toBe('no_photo')
	expect(parseMenuHealthCheckKey('nope')).toBeNull()
	expect(parseMenuHealthCheckKey(null)).toBeNull()
})
