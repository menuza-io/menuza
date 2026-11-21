import { describe, expect, it } from 'vitest'
import {
	hasCurrencyMismatch,
	MENU_IMPORT_MAX_TOTAL_ITEMS,
	MENU_IMPORT_MAX_TOTAL_MODIFIER_GROUPS,
	MENU_IMPORT_MAX_TOTAL_MODIFIER_OPTIONS,
	MENU_IMPORT_NAME_MAX,
	menuImportDraftSchema,
	normalizeModelOutputToDraft,
	serializeLocalizedTextForOrg,
} from './schema.ts'

describe('menu import draft schema (#73)', () => {
	it('accepts valid model output, trims strings, and builds a strict draft', () => {
		const res = normalizeModelOutputToDraft({
			detectedCurrency: ' sar ',
			detectedLocales: ['en', 'ar'],
			menus: [
				{
					name: { en: '  Lunch Menu  ', ar: '  قائمة الغداء  ' },
					categories: [
						{
							name: { en: ' Burgers ' },
							items: [
								{
									name: { en: ' Classic Burger ', ar: ' برجر كلاسيك ' },
									description: { en: '  Beef patty with cheese  ' },
									price: 32.5,
									sizes: [
										{ name: { en: ' Single ' }, price: 32.5 },
										{ name: { en: ' Double ' }, price: 44 },
									],
									modifierGroups: [
										{
											name: { en: 'Extras' },
											selectionType: 'multiple',
											minSelections: 0,
											maxSelections: 2,
											options: [{ name: { en: ' Bacon ' }, price: 6 }],
										},
									],
									confidence: 'low',
									lowConfidenceFields: ['price'],
								},
							],
						},
					],
				},
			],
		})

		expect(res.ok).toBe(true)
		if (!res.ok) return
		expect(res.draft.detectedCurrency).toBe('SAR')
		const item = res.draft.menus[0]!.categories[0]!.items[0]!
		expect(item.name).toEqual({ en: 'Classic Burger', ar: 'برجر كلاسيك' })
		expect(item.description).toEqual({ en: 'Beef patty with cheese' })
		expect(item.price).toBe(32.5)
		expect(item.confidence).toBe('low')
		expect(item.lowConfidenceFields).toEqual(['price'])
		expect(menuImportDraftSchema.safeParse(res.draft).success).toBe(true)
	})

	it('rejects malformed model output (negative prices, NaN, over-length, missing names)', () => {
		// Negative price
		expect(
			normalizeModelOutputToDraft({
				menus: [
					{
						name: { en: 'Main' },
						categories: [
							{
								name: { en: 'Starters' },
								items: [{ name: { en: 'Soup' }, price: -5 }],
							},
						],
					},
				],
			}).ok,
		).toBe(false)

		// NaN / non-numeric price
		expect(
			normalizeModelOutputToDraft({
				menus: [
					{
						name: { en: 'Main' },
						categories: [
							{
								name: { en: 'Starters' },
								items: [{ name: { en: 'Soup' }, price: Number.NaN }],
							},
						],
					},
				],
			}).ok,
		).toBe(false)

		// Over-length name
		expect(
			normalizeModelOutputToDraft({
				menus: [
					{
						name: { en: 'Main' },
						categories: [
							{
								name: { en: 'Starters' },
								items: [
									{
										name: { en: 'A'.repeat(MENU_IMPORT_NAME_MAX + 1) },
										price: 10,
									},
								],
							},
						],
					},
				],
			}).ok,
		).toBe(false)

		// Blank trimmed name
		expect(
			normalizeModelOutputToDraft({
				menus: [
					{
						name: { en: '   ' },
						categories: [],
					},
				],
			}).ok,
		).toBe(false)
	})

	it('never allows allergens or calories fields in model output or drafts', () => {
		const withAllergens = normalizeModelOutputToDraft({
			menus: [
				{
					name: { en: 'Main' },
					categories: [
						{
							name: { en: 'Mains' },
							items: [
								{
									name: { en: 'Peanut Salad' },
									price: 12,
									allergens: ['peanuts'],
								},
							],
						},
					],
				},
			],
		})
		expect(withAllergens.ok).toBe(false)

		const withCalories = normalizeModelOutputToDraft({
			menus: [
				{
					name: { en: 'Main' },
					categories: [
						{
							name: { en: 'Mains' },
							items: [
								{
									name: { en: 'Salad' },
									price: 12,
									calories: 350,
								},
							],
						},
					],
				},
			],
		})
		expect(withCalories.ok).toBe(false)
	})

	it('serializes bilingual fields only for locales configured on the org and detects currency mismatch', () => {
		expect(
			serializeLocalizedTextForOrg(
				{ en: 'Shawarma', ar: 'شاورما' },
				['en'],
				'en',
				true,
			),
		).toBe('{"en":"Shawarma"}')

		expect(
			serializeLocalizedTextForOrg(
				{ en: 'Shawarma', ar: 'شاورما' },
				['en', 'ar'],
				'en',
				true,
			),
		).toBe('{"en":"Shawarma","ar":"شاورما"}')

		expect(hasCurrencyMismatch('EUR', 'USD')).toBe(true)
		expect(hasCurrencyMismatch('SAR', 'SAR')).toBe(false)
		expect(hasCurrencyMismatch(null, 'USD')).toBe(false)
	})

	it('enforces total items, modifier groups, and modifier options caps across the whole draft and defaults matchMode to auto', () => {
		// 2 menus x 151 items = 302 > MENU_IMPORT_MAX_TOTAL_ITEMS (300)
		const overItems = normalizeModelOutputToDraft({
			menus: [0, 1].map((m) => ({
				name: { en: `Menu ${m}` },
				categories: [
					{
						name: { en: 'Cat' },
						items: Array.from({ length: 151 }, (_, idx) => ({
							name: { en: `Dish ${m}-${idx}` },
							price: 10,
						})),
					},
				],
			})),
		})
		expect(overItems.ok).toBe(false)

		// Draft schema also rejects > MENU_IMPORT_MAX_TOTAL_ITEMS
		expect(
			menuImportDraftSchema.safeParse({
				version: 1,
				detectedCurrency: null,
				detectedLocales: ['en'],
				imageSuggestions: [],
				menus: [0, 1].map((m) => ({
					id: `menu-${m}`,
					included: true,
					name: { en: `Menu ${m}` },
					categories: [
						{
							id: `cat-${m}`,
							included: true,
							name: { en: 'Cat' },
							items: Array.from(
								{ length: Math.floor(MENU_IMPORT_MAX_TOTAL_ITEMS / 2) + 1 },
								(_, idx) => ({
									id: `item-${m}-${idx}`,
									included: true,
									name: { en: `Dish ${m}-${idx}` },
									price: 10,
								}),
							),
						},
					],
				})),
			}).success,
		).toBe(false)

		// > MENU_IMPORT_MAX_TOTAL_MODIFIER_GROUPS across items
		expect(
			menuImportDraftSchema.safeParse({
				version: 1,
				detectedCurrency: null,
				detectedLocales: ['en'],
				imageSuggestions: [],
				menus: [
					{
						id: 'm1',
						included: true,
						name: { en: 'Menu' },
						categories: [
							{
								id: 'c1',
								included: true,
								name: { en: 'Cat' },
								items: Array.from({ length: 26 }, (_, i) => ({
									id: `it-${i}`,
									included: true,
									name: { en: `Dish ${i}` },
									price: 10,
									modifierGroups: Array.from(
										{
											length:
												Math.floor(MENU_IMPORT_MAX_TOTAL_MODIFIER_GROUPS / 26) +
												1,
										},
										(_, g) => ({
											id: `grp-${i}-${g}`,
											included: true,
											name: { en: `Group ${g}` },
											options: [],
										}),
									),
								})),
							},
						],
					},
				],
			}).success,
		).toBe(false)

		// > MENU_IMPORT_MAX_TOTAL_MODIFIER_OPTIONS across groups
		expect(
			menuImportDraftSchema.safeParse({
				version: 1,
				detectedCurrency: null,
				detectedLocales: ['en'],
				imageSuggestions: [],
				menus: [
					{
						id: 'm1',
						included: true,
						name: { en: 'Menu' },
						categories: [
							{
								id: 'c1',
								included: true,
								name: { en: 'Cat' },
								items: Array.from({ length: 5 }, (_, i) => ({
									id: `it-${i}`,
									included: true,
									name: { en: `Dish ${i}` },
									price: 10,
									modifierGroups: Array.from({ length: 10 }, (_, g) => ({
										id: `grp-${i}-${g}`,
										included: true,
										name: { en: `Group ${g}` },
										options: Array.from(
											{
												length:
													Math.floor(
														MENU_IMPORT_MAX_TOTAL_MODIFIER_OPTIONS / 50,
													) + 1,
											},
											(_, o) => ({
												id: `opt-${i}-${g}-${o}`,
												included: true,
												name: { en: `Opt ${o}` },
												price: 1,
											}),
										),
									})),
								})),
							},
						],
					},
				],
			}).success,
		).toBe(false)

		// Default matchMode is 'auto'
		const okRes = normalizeModelOutputToDraft({
			menus: [
				{
					name: { en: 'Main' },
					categories: [
						{
							name: { en: 'Mains' },
							items: [{ name: { en: 'Burger' }, price: 12 }],
						},
					],
				},
			],
		})
		expect(okRes.ok).toBe(true)
		if (okRes.ok) {
			expect(okRes.draft.menus[0]!.categories[0]!.items[0]!.matchMode).toBe(
				'auto',
			)
		}
	})
})
