import { describe, expect, test } from 'vitest'
import {
	computeMenuHealth,
	normalizeMenuName,
	getMenuHealthFixes,
	MENU_HEALTH_DEDUCTION_CHECKS,
	MENU_HEALTH_WEIGHTS,
	menuHealthEntityType,
	menuHealthFingerprint,
	menuHealthGrade,
	menuHealthMeetsGrade,
	nameIsAllCaps,
	nameIsTooLong,
	parseMenuHealthCheckKey,
	summarizeMenuHealth,
	type MenuHealthCategory,
	type MenuHealthDismissal,
	type MenuHealthInput,
	type MenuHealthItem,
	type MenuHealthModifierGroup,
} from './menu-health.ts'

const NOW = new Date('2026-11-11T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function item(overrides: Partial<MenuHealthItem> = {}): MenuHealthItem {
	return {
		id: 'item',
		// Unique per id, or a list of identical dishes would be duplicates.
		displayName: JSON.stringify({
			en: `Hummus ${overrides.id ?? 'item'}`,
			ar: 'حمص',
		}),
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
		expect(health).toEqual({
			score: 100,
			grade: 'A',
			fixCount: 0,
			checks: [],
			itemCount: 0,
			staleDismissals: [],
		})
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
		// Deduction checks never add to the total weight.
		const totalWeight = Object.entries(MENU_HEALTH_WEIGHTS)
			.filter(([key]) => !MENU_HEALTH_DEDUCTION_CHECKS.has(key as never))
			.reduce((a, [, b]) => a + b, 0)
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

function group(
	overrides: Partial<MenuHealthModifierGroup> = {},
): MenuHealthModifierGroup {
	return {
		id: 'g',
		selectionType: 'multiple',
		minSelections: 0,
		maxSelections: null,
		availabilityStatus: 'available',
		...overrides,
	}
}

function opts(groupId: string, n: number, hidden = 0) {
	return [
		...Array.from({ length: n }, () => ({
			modifierGroupId: groupId,
			availabilityStatus: 'available',
		})),
		...Array.from({ length: hidden }, () => ({
			modifierGroupId: groupId,
			availabilityStatus: 'hidden',
		})),
	]
}

/** One dish `item` with `g` attached and `n` visible options. */
function runGroup(g: MenuHealthModifierGroup, n: number, hidden = 0) {
	return run({
		modifierGroups: [g],
		itemModifierGroups: [{ itemId: 'item', modifierGroupId: g.id }],
		modifierGroupOptions: opts(g.id, n, hidden),
	})
}

describe('name_all_caps', () => {
	test.each([
		['BBQ', false],
		['BBQ Wings', false],
		['KFC BBQ', false],
		['BBQ WINGS', true],
		['CHICKEN 65', true],
		['12345', false],
		['حمص بالطحينة', false],
	])('nameIsAllCaps(%s) is %s', (name, expected) => {
		expect(nameIsAllCaps(name)).toBe(expected)
	})

	test('flags dishes and never an Arabic name', () => {
		const health = run({
			items: [
				item({ id: 'a', displayName: JSON.stringify({ en: 'BBQ WINGS' }) }),
				item({ id: 'b', displayName: JSON.stringify({ en: 'BBQ Wings' }) }),
				item({
					id: 'c',
					displayName: JSON.stringify({ en: 'Hummus', ar: 'حمص حمص' }),
				}),
			],
			locales: ['en', 'ar'],
			defaultLocale: 'en',
		})
		expect(check(health, 'name_all_caps')).toMatchObject({
			itemIds: ['a'],
			count: 1,
			total: 3,
			severity: 'info',
		})
	})

	test('a name in another enabled locale counts too', () => {
		const health = run({
			locales: ['en', 'fr'],
			items: [
				item({
					displayName: JSON.stringify({ en: 'Soup', fr: 'SOUPE A OIGNON' }),
				}),
			],
		})
		expect(check(health, 'name_all_caps')?.itemIds).toEqual(['item'])
	})
})

describe('name_too_long', () => {
	test('60 characters pass and 61 fail', () => {
		expect(nameIsTooLong('a'.repeat(60))).toBe(false)
		expect(nameIsTooLong('a'.repeat(61))).toBe(true)
		expect(nameIsTooLong(`  ${'a'.repeat(60)}  `)).toBe(false)
	})

	test('counts code points, not UTF-16 units', () => {
		// 59 + one emoji = 60 code points but 61 UTF-16 units.
		expect(nameIsTooLong(`${'a'.repeat(59)}😀`)).toBe(false)
		expect(nameIsTooLong(`${'a'.repeat(60)}😀`)).toBe(true)
		expect('😀').toHaveLength(2)
	})

	test('flags a long name in any enabled locale', () => {
		const health = run({
			locales: ['en', 'ar'],
			items: [
				item({ id: 'ok' }),
				item({
					id: 'long-ar',
					displayName: JSON.stringify({ en: 'Hummus', ar: 'ح'.repeat(61) }),
				}),
				item({
					id: 'long-en',
					displayName: JSON.stringify({ en: 'a'.repeat(61), ar: 'حمص' }),
				}),
			],
		})
		expect(check(health, 'name_too_long')?.itemIds).toEqual([
			'long-ar',
			'long-en',
		])
	})
})

describe('option group checks', () => {
	test('not run without modifierGroups input', () => {
		const health = run()
		expect(check(health, 'empty_option_group')).toBeUndefined()
		expect(check(health, 'impossible_minimum')).toBeUndefined()
	})

	test('a group with no options, or only hidden ones, is empty', () => {
		for (const hidden of [0, 2]) {
			const health = runGroup(group(), 0, hidden)
			expect(check(health, 'empty_option_group')).toMatchObject({
				count: 1,
				total: 1,
				modifierGroupIds: ['g'],
			})
			// An empty group is not also reported as impossible.
			expect(
				runGroup(group({ minSelections: 2 }), 0, hidden).checks.find(
					(c) => c.key === 'impossible_minimum',
				)?.count,
			).toBe(0)
		}
		expect(check(runGroup(group(), 1), 'empty_option_group')?.count).toBe(0)
	})

	test('minimum above the visible options is impossible', () => {
		const health = runGroup(group({ minSelections: 3 }), 2, 5)
		expect(check(health, 'impossible_minimum')).toMatchObject({
			count: 1,
			modifierGroupIds: ['g'],
			severity: 'error',
		})
		expect(
			check(runGroup(group({ minSelections: 2 }), 2), 'impossible_minimum')
				?.count,
		).toBe(0)
	})

	test('minimum above the maximum is impossible', () => {
		const health = runGroup(group({ minSelections: 3, maxSelections: 2 }), 5)
		expect(check(health, 'impossible_minimum')?.count).toBe(1)
		expect(
			check(
				runGroup(group({ minSelections: 2, maxSelections: 2 }), 5),
				'impossible_minimum',
			)?.count,
		).toBe(0)
	})

	test('single choice allows one pick whatever the options', () => {
		expect(
			check(
				runGroup(group({ selectionType: 'single', minSelections: 2 }), 3),
				'impossible_minimum',
			)?.count,
		).toBe(1)
		expect(
			check(
				runGroup(group({ selectionType: 'single', minSelections: 1 }), 3),
				'impossible_minimum',
			)?.count,
		).toBe(0)
	})

	test('pizza allows two picks per option', () => {
		const pizza = (min: number, n: number, max: number | null = null) =>
			check(
				runGroup(
					group({
						selectionType: 'pizza',
						minSelections: min,
						maxSelections: max,
					}),
					n,
				),
				'impossible_minimum',
			)?.count
		expect(pizza(2, 1)).toBe(0)
		expect(pizza(3, 1)).toBe(1)
		expect(pizza(4, 2)).toBe(0)
		expect(pizza(5, 2)).toBe(1)
		expect(pizza(4, 2, 3)).toBe(1)
	})

	test('quantity can repeat an option: unlimited with no maximum', () => {
		const quantity = (min: number, max: number | null) =>
			check(
				runGroup(
					group({
						selectionType: 'quantity',
						minSelections: min,
						maxSelections: max,
					}),
					1,
				),
				'impossible_minimum',
			)?.count
		expect(quantity(5, null)).toBe(0)
		expect(quantity(5, 10)).toBe(0)
		expect(quantity(5, 3)).toBe(1)
	})

	test('groups only on a hidden dish, or hidden groups, are ignored', () => {
		const base = {
			items: [
				item({ id: 'shown' }),
				item({ id: 'hidden-dish', availabilityStatus: 'hidden' }),
			],
		}
		const onHiddenDish = run({
			...base,
			modifierGroups: [group()],
			itemModifierGroups: [{ itemId: 'hidden-dish', modifierGroupId: 'g' }],
			modifierGroupOptions: [],
		})
		expect(check(onHiddenDish, 'empty_option_group')).toBeUndefined()
		const hiddenGroup = run({
			...base,
			modifierGroups: [group({ availabilityStatus: 'hidden' })],
			itemModifierGroups: [{ itemId: 'shown', modifierGroupId: 'g' }],
			modifierGroupOptions: [],
		})
		expect(check(hiddenGroup, 'empty_option_group')).toBeUndefined()
		// Unattached group: ignored too.
		const unattached = run({
			modifierGroups: [group()],
			itemModifierGroups: [],
			modifierGroupOptions: [],
		})
		expect(check(unattached, 'empty_option_group')).toBeUndefined()
	})

	test('entity types', () => {
		expect(menuHealthEntityType('empty_option_group')).toBe('modifier_group')
		expect(menuHealthEntityType('impossible_minimum')).toBe('modifier_group')
		expect(menuHealthEntityType('empty_category')).toBe('category')
		expect(menuHealthEntityType('duplicate_item')).toBe('item')
	})
})

describe('duplicate_item', () => {
	const named = (id: string, name: string, price = 8, variations?: string) =>
		item({
			id,
			price,
			displayName: JSON.stringify({ en: name }),
			...(variations ? { variations } : {}),
		})

	test('needs the same name and the same price', () => {
		const health = run({
			items: [
				named('a', 'Falafel'),
				named('b', 'Falafel'),
				named('c', 'Falafel', 9),
				named('d', 'Shawarma'),
			],
		})
		expect(check(health, 'duplicate_item')).toMatchObject({
			itemIds: ['a', 'b'],
			count: 2,
			total: 4,
		})
	})

	test('ignores case, punctuation and extra spaces', () => {
		const health = run({
			items: [
				named('a', 'Mac & Cheese!'),
				named('b', 'mac  cheese'),
				named('c', 'Chicken-Wings'),
				named('d', 'chicken wings'),
			],
		})
		// "Chicken-Wings" -> "chickenwings" differs from "chicken wings".
		expect(check(health, 'duplicate_item')?.itemIds).toEqual(['a', 'b'])
	})

	test('variant prices count as part of the price', () => {
		const sized = (price: number) =>
			JSON.stringify({
				groups: [],
				variants: [{ id: 'v', valueIds: [], price }],
			})
		const health = run({
			items: [
				named('a', 'Pizza', 0, sized(5)),
				named('b', 'Pizza', 0, sized(5)),
				named('c', 'Pizza', 0, sized(6)),
			],
		})
		expect(check(health, 'duplicate_item')?.itemIds).toEqual(['a', 'b'])
	})

	test('hidden dishes are not duplicates', () => {
		const health = run({
			items: [
				named('a', 'Falafel'),
				{ ...named('b', 'Falafel'), availabilityStatus: 'hidden' },
			],
		})
		expect(check(health, 'duplicate_item')?.count).toBe(0)
	})
})

describe('grades', () => {
	test.each([
		[0, 'F'],
		[59, 'F'],
		[60, 'D'],
		[69, 'D'],
		[70, 'C'],
		[79, 'C'],
		[80, 'B'],
		[89, 'B'],
		[90, 'A'],
		[99, 'A'],
		[100, 'A'],
	] as const)('score %i is %s', (score, grade) => {
		expect(menuHealthGrade(score)).toBe(grade)
	})

	test('computeMenuHealth derives the grade from the score', () => {
		const health = run({ items: [item({ imageKey: null })] })
		expect(health.grade).toBe(menuHealthGrade(health.score))
	})

	test('menuHealthMeetsGrade', () => {
		expect(menuHealthMeetsGrade({ score: 90 }, 'A')).toBe(true)
		expect(menuHealthMeetsGrade({ score: 89 }, 'A')).toBe(false)
		expect(menuHealthMeetsGrade({ score: 89 }, 'B')).toBe(true)
		expect(menuHealthMeetsGrade({ score: 59 }, 'D')).toBe(false)
		expect(menuHealthMeetsGrade({ score: 0 }, 'F')).toBe(true)
		expect(menuHealthMeetsGrade({ score: 100 }, 'F')).toBe(true)
	})
})

describe('legacy-only score is unchanged', () => {
	const noGroups = {
		modifierGroups: [] as MenuHealthModifierGroup[],
		itemModifierGroups: [],
		modifierGroupOptions: [],
	}

	test('one dish without a photo', () => {
		// Applicable: zero_price 15, no_photo 30, no_description 25,
		// no_allergens 10, long_unavailable 5, empty_category 5 (the default
		// category is on) = 90. Lost: 30 (1 of 1).
		const expected = Math.round((100 * (90 - 30)) / 90)
		expect(expected).toBe(67)
		expect(run({ items: [item({ imageKey: null })] }).score).toBe(expected)
	})

	test('four dishes, two without photo, one free, one empty category', () => {
		// Applicable adds empty_category 5 = 90. Lost: zero_price (error, 1 of 4)
		// 15 x (0.5 + 0.25/2) = 9.375; no_photo 30 x 2/4 = 15; empty_category
		// 5 x 1/2 = 2.5. Total 26.875.
		const items = [
			item({ id: 'a', price: 0 }),
			item({ id: 'b', imageKey: null }),
			item({ id: 'c', imageKey: null }),
			item({ id: 'd' }),
		]
		const expected = Math.round((100 * (90 - 26.875)) / 90)
		expect(expected).toBe(70)
		const input = {
			items,
			categories: [category({ id: 'full' }), category({ id: 'empty' })],
			categoryIdsWithItems: ['full'],
		}
		expect(run(input).score).toBe(expected)
		expect(run({ ...input, ...noGroups }).score).toBe(expected)
	})

	test('two languages: translation, allergens and descriptions', () => {
		// Applicable: 15 + 30 + 25 + 10 + 10 + 5 (no categories, so no empty
		// category) = 95. Three dishes: one missing the Arabic name (1/3 of 10),
		// one with no description (25 x 1/3), one with no allergens (10 x 1/3).
		// The no-description dish also lacks the Arabic description check only
		// when it has a description, so it is not a translation miss.
		const items = [
			item({ id: 'a', displayName: JSON.stringify({ en: 'Hummus' }) }),
			item({ id: 'b', description: null }),
			item({ id: 'c', allergens: '[]' }),
		]
		const lost = (10 + 25 + 10) / 3
		const expected = Math.round((100 * (95 - lost)) / 95)
		const input = {
			items,
			categories: [],
			categoryIdsWithItems: [],
			locales: ['en', 'ar'] as const,
		}
		expect(run({ ...input, locales: [...input.locales] }).score).toBe(expected)
	})

	test('passing groups, long-name-free names and no duplicates change nothing', () => {
		const items = [item({ id: 'a', imageKey: null }), item({ id: 'b' })]
		const before = run({ items }).score
		const withGroups = run({
			items,
			modifierGroups: [
				group({ id: 'g1' }),
				group({ id: 'g2', minSelections: 1 }),
			],
			itemModifierGroups: [
				{ itemId: 'a', modifierGroupId: 'g1' },
				{ itemId: 'b', modifierGroupId: 'g2' },
			],
			modifierGroupOptions: [...opts('g1', 2), ...opts('g2', 3)],
		})
		expect(withGroups.score).toBe(before)
		expect(check(withGroups, 'empty_option_group')?.count).toBe(0)
	})

	test('a failing deduction check lowers the score below the legacy value', () => {
		const items = [item({ id: 'a' })]
		const legacy = run({ items }).score
		expect(legacy).toBe(100)
		const health = run({
			items: [
				item({ id: 'a', displayName: JSON.stringify({ en: 'BBQ WINGS' }) }),
			],
		})
		expect(health.score).toBeLessThan(100)
		expect(health.fixCount).toBe(1)
	})
})

describe('score ceiling', () => {
	test('any failing, non-dismissed check keeps the score at 99 or below', () => {
		const items = Array.from({ length: 3000 }, (_, i) =>
			item({ id: `i${i}`, displayName: JSON.stringify({ en: `Dish ${i}` }) }),
		)
		items[0] = item({
			id: 'i0',
			displayName: JSON.stringify({ en: 'BBQ WINGS' }),
		})
		const health = run({ items })
		expect(health.fixCount).toBe(1)
		expect(health.score).toBeLessThanOrEqual(99)
	})
})

describe('dismissals', () => {
	function fingerprints(overrides: Partial<MenuHealthInput>) {
		const health = run({ ...overrides, includeFingerprints: true })
		return (key: string, id: string): MenuHealthDismissal => ({
			entityId: id,
			checkKey: key,
			fingerprint: check(health, key)!.fingerprints![id]!,
		})
	}

	const items = [
		item({ id: 'a', imageKey: null }),
		item({ id: 'b', imageKey: null }),
		item({ id: 'c' }),
	]

	test('a matching dismissal leaves count, score, grade and fixCount', () => {
		const before = run({ items })
		const dismiss = fingerprints({ items })('no_photo', 'a')
		const after = run({ items, dismissals: [dismiss] })
		expect(check(after, 'no_photo')).toMatchObject({
			count: 1,
			total: 3,
			itemIds: ['b'],
			dismissedIds: ['a'],
		})
		expect(after.fixCount).toBe(before.fixCount - 1)
		expect(after.score).toBeGreaterThan(before.score)
		expect(after.grade).toBe(menuHealthGrade(after.score))
		expect(after.staleDismissals).toEqual([])
		expect(after.itemCount).toBe(3)
	})

	test('dismissedIds is always set, empty by default', () => {
		for (const c of run({ items }).checks) expect(c.dismissedIds).toEqual([])
	})

	test('a dismissal with another fingerprint does not apply and is stale', () => {
		const after = run({
			items,
			dismissals: [
				{ entityId: 'a', checkKey: 'no_photo', fingerprint: 'beef' },
			],
		})
		expect(check(after, 'no_photo')?.itemIds).toEqual(['a', 'b'])
		expect(check(after, 'no_photo')?.dismissedIds).toEqual([])
		expect(after.staleDismissals).toEqual([
			expect.objectContaining({ entityId: 'a', checkKey: 'no_photo' }),
		])
	})

	test('a dismissal for a passing record is stale', () => {
		const after = run({
			items,
			dismissals: [
				{
					entityId: 'c',
					checkKey: 'no_photo',
					fingerprint: menuHealthFingerprint({ key: 'no_photo' }),
				},
			],
		})
		expect(after.staleDismissals).toEqual([
			expect.objectContaining({ entityId: 'c', checkKey: 'no_photo' }),
		])
	})

	test('a dismissal of a hidden dish is kept, not stale', () => {
		const dismiss = fingerprints({ items })('no_photo', 'a')
		const hidden = [
			item({ id: 'a', imageKey: null, availabilityStatus: 'hidden' }),
			item({ id: 'c' }),
		]
		const after = run({ items: hidden, dismissals: [dismiss] })
		expect(after.staleDismissals).toEqual([])
		// Shown again, it is still dismissed.
		const shown = run({ items, dismissals: [dismiss] })
		expect(check(shown, 'no_photo')?.dismissedIds).toEqual(['a'])
		expect(shown.staleDismissals).toEqual([])
	})

	test('a dismissal of a missing dish is not reported stale here', () => {
		const after = run({
			items,
			dismissals: [
				{ entityId: 'gone', checkKey: 'no_photo', fingerprint: 'beef' },
			],
		})
		expect(after.staleDismissals).toEqual([])
	})

	test('a stale dismissal carries its stored fingerprint', () => {
		const after = run({
			items,
			dismissals: [
				{ entityId: 'c', checkKey: 'no_photo', fingerprint: 'cafe0000' },
			],
		})
		expect(after.staleDismissals).toEqual([
			{ entityId: 'c', checkKey: 'no_photo', fingerprint: 'cafe0000' },
		])
	})

	test('a dismissal of a check that did not run is not stale', () => {
		const after = run({
			items,
			dismissals: [
				{ entityId: 'x', checkKey: 'empty_option_group', fingerprint: 'beef' },
			],
		})
		expect(after.staleDismissals).toEqual([])
	})

	test('card: rows and unknown keys are ignored and never stale', () => {
		const before = run({ items })
		const after = run({
			items,
			dismissals: [
				{ entityId: 'a', checkKey: 'card:translation', fingerprint: 'x' },
				{ entityId: 'a', checkKey: 'made_up', fingerprint: 'x' },
			],
		})
		expect(after.staleDismissals).toEqual([])
		expect(after.fixCount).toBe(before.fixCount)
		expect(after.score).toBe(before.score)
	})

	test('a group dismissal follows the group fingerprint', () => {
		const g = group({ minSelections: 3 })
		const base = {
			modifierGroups: [g],
			itemModifierGroups: [{ itemId: 'item', modifierGroupId: 'g' }],
			modifierGroupOptions: opts('g', 2),
		}
		const dismiss = fingerprints(base)('impossible_minimum', 'g')
		const dismissed = run({ ...base, dismissals: [dismiss] })
		expect(check(dismissed, 'impossible_minimum')).toMatchObject({
			count: 0,
			dismissedIds: ['g'],
		})
		// Adding an option changes the fingerprint (still impossible: 3 > 2? no,
		// 3 options makes it possible), so use a larger minimum instead.
		const edited = run({
			...base,
			modifierGroups: [group({ minSelections: 4 })],
			dismissals: [dismiss],
		})
		expect(check(edited, 'impossible_minimum')?.count).toBe(1)
		expect(edited.staleDismissals).toEqual([
			expect.objectContaining({
				entityId: 'g',
				checkKey: 'impossible_minimum',
			}),
		])
	})

	test('renaming to another ALL-CAPS name revives the check', () => {
		const caps = (name: string) =>
			item({ id: 'a', displayName: JSON.stringify({ en: name }) })
		const dismiss = fingerprints({ items: [caps('BBQ WINGS')] })(
			'name_all_caps',
			'a',
		)
		expect(
			check(
				run({ items: [caps('BBQ WINGS')], dismissals: [dismiss] }),
				'name_all_caps',
			)?.count,
		).toBe(0)
		const renamed = run({ items: [caps('BBQ RIBS')], dismissals: [dismiss] })
		expect(check(renamed, 'name_all_caps')?.count).toBe(1)
		expect(renamed.staleDismissals).toEqual([
			expect.objectContaining({ entityId: 'a', checkKey: 'name_all_caps' }),
		])
	})

	test('a menu with every problem dismissed can score 100', () => {
		const one = [item({ id: 'a', imageKey: null })]
		const dismiss = fingerprints({ items: one })('no_photo', 'a')
		const health = run({ items: one, dismissals: [dismiss] })
		expect(health.fixCount).toBe(0)
		expect(health.score).toBe(100)
		expect(health.grade).toBe('A')
	})

	test('summarizeMenuHealth names failing and dismissed records', () => {
		const dismiss = fingerprints({ items })('no_photo', 'a')
		const health = run({
			items,
			dismissals: [dismiss],
			includeFingerprints: true,
		})
		const summary = summarizeMenuHealth(health, (type, id) => `${type}:${id}`)
		const photo = summary.checks.find((c) => c.key === 'no_photo')!
		expect(photo).toMatchObject({
			entityType: 'item',
			count: 1,
			dismissedCount: 1,
			records: [{ id: 'b', name: 'item:b' }],
			dismissed: [{ id: 'a', name: 'item:a' }],
		})
		expect(photo).not.toHaveProperty('fingerprints')
		expect(summary.grade).toBe(health.grade)
		expect(summary.fixCount).toBe(health.fixCount)
	})
})

describe('performance', () => {
	// Guards against an accidental quadratic pass, not against a slow machine:
	// this takes a few milliseconds, and a quadratic version takes seconds. The
	// budget is wide and the best of several runs counts, so a loaded CI runner
	// with coverage on cannot fail it (50 ms did, at 75 ms).
	test('2,000 dishes, 200 groups and 100 dismissals stay fast', () => {
		const items = Array.from({ length: 2000 }, (_, i) =>
			item({
				id: `i${i}`,
				imageKey: i % 3 === 0 ? null : 'k',
				displayName: JSON.stringify({
					en: `Dish number ${i % 1500}`,
					ar: `طبق ${i}`,
				}),
			}),
		)
		const groups = Array.from({ length: 200 }, (_, i) =>
			group({ id: `g${i}`, minSelections: i % 5 }),
		)
		const input: Partial<MenuHealthInput> = {
			items,
			locales: ['en', 'ar'],
			modifierGroups: groups,
			itemModifierGroups: groups.map((g, i) => ({
				itemId: `i${i}`,
				modifierGroupId: g.id,
			})),
			modifierGroupOptions: groups.flatMap((g) => opts(g.id, 3)),
		}
		const fp = run({ ...input, includeFingerprints: true })
		const dismissals: MenuHealthDismissal[] = fp.checks
			.find((c) => c.key === 'no_photo')!
			.itemIds!.slice(0, 100)
			.map((id) => ({
				entityId: id,
				checkKey: 'no_photo',
				fingerprint: menuHealthFingerprint({ key: 'no_photo' }),
			}))
		expect(dismissals).toHaveLength(100)
		const full = { ...input, dismissals }
		run(full) // warm-up
		let best = Infinity
		for (let i = 0; i < 5; i++) {
			const start = performance.now()
			run(full)
			best = Math.min(best, performance.now() - start)
		}
		expect(best).toBeLessThan(250)
	})
})

describe('option availability and quantity caps', () => {
	const row = (over: object = {}) => ({
		modifierGroupId: 'g',
		availabilityStatus: 'available',
		...over,
	})
	const runWith = (g: MenuHealthModifierGroup, rows: object[]) =>
		run({
			modifierGroups: [g],
			itemModifierGroups: [{ itemId: 'item', modifierGroupId: g.id }],
			modifierGroupOptions: rows as never,
		})

	test('min 2 with 3 options of which 2 are unavailable is impossible', () => {
		const health = runWith(group({ minSelections: 2 }), [
			row(),
			row({ availabilityStatus: 'unavailable' }),
			row({ availabilityStatus: 'unavailable' }),
		])
		expect(check(health, 'impossible_minimum')?.modifierGroupIds).toEqual(['g'])
	})

	test('unavailable_until counts only once its date has passed', () => {
		const rows = (until: Date) => [
			row(),
			row({ availabilityStatus: 'unavailable_until', unavailableUntil: until }),
		]
		const g = group({ minSelections: 2 })
		expect(
			check(
				runWith(g, rows(new Date(NOW.getTime() + DAY))),
				'impossible_minimum',
			)?.count,
		).toBe(1)
		expect(
			check(
				runWith(g, rows(new Date(NOW.getTime() - DAY))),
				'impossible_minimum',
			)?.count,
		).toBe(0)
	})

	test('a group whose only options are unavailable is empty', () => {
		const health = runWith(group(), [
			row({ availabilityStatus: 'unavailable' }),
			row({ availabilityStatus: 'hidden' }),
		])
		expect(check(health, 'empty_option_group')?.modifierGroupIds).toEqual(['g'])
	})

	test('quantity min 5 with two options capped at 2 is impossible', () => {
		const g = group({ selectionType: 'quantity', minSelections: 5 })
		const capped = runWith(g, [
			row({ optionMaxSelections: 2 }),
			row({ optionMaxSelections: 2 }),
		])
		expect(check(capped, 'impossible_minimum')?.count).toBe(1)
		// One uncapped option, or caps that add up, is fine.
		expect(
			check(
				runWith(g, [row({ optionMaxSelections: 2 }), row()]),
				'impossible_minimum',
			)?.count,
		).toBe(0)
		expect(
			check(
				runWith(g, [
					row({ optionMaxSelections: 3 }),
					row({ optionMaxSelections: 2 }),
				]),
				'impossible_minimum',
			)?.count,
		).toBe(0)
	})
})

describe('Arabic names', () => {
	test('a mixed Arabic and Latin name is not all caps', () => {
		expect(nameIsAllCaps('بيبسي PEPSI')).toBe(false)
		expect(nameIsAllCaps('PEPSI MAX')).toBe(true)
		expect(nameIsAllCaps('PEPSI MAX CHICKEN بيبسي')).toBe(true)
	})

	test('combining marks do not count toward the length', () => {
		const vowelled = 'بَ'.repeat(37)
		expect(Array.from(vowelled)).toHaveLength(74)
		expect(nameIsTooLong(vowelled)).toBe(false)
		expect(nameIsTooLong('ب'.repeat(61))).toBe(true)
		expect(nameIsTooLong('بَ'.repeat(61))).toBe(true)
	})

	test('normalizeMenuName folds tatweel, harakat and alef forms', () => {
		expect(normalizeMenuName('شاورمـا')).toBe(normalizeMenuName('شاورما'))
		expect(normalizeMenuName('شَاوَرْما')).toBe(normalizeMenuName('شاورما'))
		expect(normalizeMenuName('أكل')).toBe(normalizeMenuName('اكل'))
		expect(normalizeMenuName('إيدام')).toBe(normalizeMenuName('ايدام'))
		expect(normalizeMenuName('Chicken, Wings')).toBe('chicken wings')
	})
})

describe('weak_photo (#145)', () => {
	const weak = (score: number | null, issues: string[] = []) =>
		item({
			primaryPhoto: { assetId: 'asset', score, issues: issues as never },
		})

	test('a dish whose primary photo scores under 50 is a weak dish photo', () => {
		const health = run({
			photoQuality: true,
			items: [
				{ ...weak(32, ['too_dark']), id: 'a' },
				{ ...weak(50), id: 'b' },
				{ ...weak(88), id: 'c' },
			],
		})
		expect(check(health, 'weak_photo')).toMatchObject({
			count: 1,
			itemIds: ['a'],
			severity: 'warning',
		})
		// no_photo is a different check and is not replaced.
		expect(check(health, 'no_photo')?.count).toBe(0)
	})

	test('too small is weak without a score; an unscored clean photo is not', () => {
		const health = run({
			photoQuality: true,
			items: [
				{ ...weak(null, ['low_resolution']), id: 'a' },
				{ ...weak(null), id: 'b' },
				{ ...item(), id: 'c', primaryPhoto: null },
			],
		})
		expect(check(health, 'weak_photo')?.itemIds).toEqual(['a'])
	})

	test('does not run while media.photo_quality is off', () => {
		const health = run({
			items: [{ ...weak(10, ['blurry']), id: 'a' }],
		})
		expect(check(health, 'weak_photo')).toBeUndefined()
	})

	test('is a pure deduction: a menu without weak photos scores as before', () => {
		expect(MENU_HEALTH_DEDUCTION_CHECKS.has('weak_photo')).toBe(true)
		const clean = run({ photoQuality: true, items: [weak(90)] })
		expect(clean.score).toBe(100)
		const hurt = run({ photoQuality: true, items: [weak(10)] })
		expect(hurt.score).toBeLessThan(100)
		expect(menuHealthEntityType('weak_photo')).toBe('item')
	})

	test('a dismissal ends when the photo or its score changes', () => {
		const before = menuHealthFingerprint({
			key: 'weak_photo',
			score: 30,
			issues: ['blurry'],
		})
		expect(
			menuHealthFingerprint({
				key: 'weak_photo',
				score: 30,
				issues: ['blurry'],
			}),
		).toBe(before)
		expect(
			menuHealthFingerprint({ key: 'weak_photo', score: 70, issues: [] }),
		).not.toBe(before)
	})

	test('the summary carries the photo and issues for "Fix in photo studio"', () => {
		const health = run({
			photoQuality: true,
			items: [{ ...weak(20, ['too_dark', 'blurry']), id: 'a' }],
		})
		const summary = summarizeMenuHealth(
			health,
			(_type, id) => `Dish ${id}`,
			(itemId) =>
				itemId === 'a'
					? { assetId: 'asset-9', issues: ['too_dark', 'blurry'] }
					: null,
		)
		const weakCheck = summary.checks.find((c) => c.key === 'weak_photo')!
		expect(weakCheck.records).toEqual([
			{
				id: 'a',
				name: 'Dish a',
				photo: { assetId: 'asset-9', issues: ['too_dark', 'blurry'] },
			},
		])
		// Other checks carry no photo.
		const other = summarizeMenuHealth(health, (_t, id) => id).checks
		expect(other.every((c) => c.records.every((r) => !('photo' in r)))).toBe(
			true,
		)
	})
})

describe('delivery_menu_differs (#144)', () => {
	test('is a pure deduction and absent when deliveryMenuDiffs is omitted or all stores match', () => {
		expect(MENU_HEALTH_DEDUCTION_CHECKS.has('delivery_menu_differs')).toBe(true)
		expect(menuHealthEntityType('delivery_menu_differs')).toBe('integration')

		const omitted = run()
		expect(check(omitted, 'delivery_menu_differs')).toBeUndefined()
		expect(omitted.score).toBe(100)

		const inSync = run({
			deliveryMenuDiffs: [
				{
					integrationId: 'int_uber',
					providerName: 'ubereats',
					providerLabel: 'Uber Eats',
					diffCount: 0,
				},
			],
		})
		expect(check(inSync, 'delivery_menu_differs')?.count).toBe(0)
		expect(inSync.score).toBe(100)
	})

	test('flags delivery integrations with diffCount > 0 and lowers score', () => {
		const health = run({
			deliveryMenuDiffs: [
				{
					integrationId: 'int_uber',
					providerName: 'ubereats',
					providerLabel: 'Uber Eats',
					diffCount: 3,
				},
				{
					integrationId: 'int_dd',
					providerName: 'doordash',
					providerLabel: 'DoorDash',
					diffCount: 0,
				},
			],
		})
		expect(check(health, 'delivery_menu_differs')).toMatchObject({
			count: 1,
			total: 2,
			integrationIds: ['int_uber'],
			severity: 'warning',
		})
		expect(health.fixCount).toBe(1)
		expect(health.score).toBeLessThan(100)
	})
})
