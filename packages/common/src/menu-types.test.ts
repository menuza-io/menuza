import { describe, expect, it } from 'vitest'
import {
	ALLERGENS,
	ALLERGEN_LABELS,
	DIETARY_FLAGS,
	MENU_TYPES,
	AvailabilityStatusSchema,
	MODIFIER_SELECTION_TYPES,
	MenuItemInputSchema,
	MenuVariationSchema,
	MenuVariationsSchema,
	MenuInputSchema,
	MenuCategoryInputSchema,
	MenuOptionInputSchema,
	getCategoryDepth,
	isValidParentCategory,
	validateModifierGraph,
	findBlockedNestedGroups,
	applyModifierGraphChange,
	ModifierGroupInputSchema,
	ModifierOptionInputSchema,
	getLocalizedMenuValue,
	parseMenuItemImageKeys,
	reconcileMenuVariations,
	generatePickupSlots,
	DropInputSchema,
	DropPickupWindowInputSchema,
	getDropDisplayStatus,
	getDropPublicationErrors,
	hasDropDefaultTitle,
	isDropDiscoverable,
} from './menu-types.ts'

describe('menu-types', () => {
	it('defines all required allergens with labels', () => {
		expect(ALLERGENS).toContain('dairy')
		expect(ALLERGENS).toContain('eggs')
		expect(ALLERGENS).toContain('fish')
		expect(ALLERGENS).toContain('gluten')
		expect(ALLERGENS).toContain('mango')
		expect(ALLERGENS).toContain('peanuts')
		expect(ALLERGENS).toContain('sesame')
		expect(ALLERGENS).toContain('shellfish')
		expect(ALLERGENS).toContain('soy')
		expect(ALLERGENS).toContain('tree_nuts')
		expect(ALLERGEN_LABELS.dairy).toBe('Dairy')
		expect(ALLERGEN_LABELS.tree_nuts).toBe('Tree Nuts')
	})

	it('defines dietary flags', () => {
		expect(DIETARY_FLAGS).toContain('alcohol')
		expect(DIETARY_FLAGS).toContain('gluten_free')
		expect(DIETARY_FLAGS).toContain('vegetarian')
	})

	it('defines menu types and modifier selection types', () => {
		expect(MENU_TYPES).toContain('online_pos_kiosk')
		expect(MENU_TYPES).toContain('catering')
		expect(MODIFIER_SELECTION_TYPES).toContain('single')
		expect(MODIFIER_SELECTION_TYPES).toContain('multiple')
		expect(MODIFIER_SELECTION_TYPES).toContain('quantity')
		expect(MODIFIER_SELECTION_TYPES).toContain('pizza')
	})

	it('extracts localized menu value correctly', () => {
		expect(getLocalizedMenuValue('Burger')).toBe('Burger')
		expect(
			getLocalizedMenuValue(
				'{"en":"Pizza Margherita","ar":"بيتزا مارغريتا"}',
				'ar',
			),
		).toBe('بيتزا مارغريتا')
		expect(
			getLocalizedMenuValue(
				'{"en":"Pizza Margherita","ar":"بيتزا مارغريتا"}',
				'fr',
				'en',
			),
		).toBe('Pizza Margherita')
	})

	it('defaults excludeFromDiscounts to false and keeps it on variants', () => {
		const base = { displayName: 'Gift card', price: 25 }
		expect(MenuItemInputSchema.parse(base).excludeFromDiscounts).toBe(false)
		expect(
			MenuItemInputSchema.parse({ ...base, excludeFromDiscounts: true })
				.excludeFromDiscounts,
		).toBe(true)
		const variant = MenuVariationSchema.parse({
			id: 'v1',
			valueIds: ['a'],
			price: 1,
			excludeFromDiscounts: true,
		})
		expect(variant.excludeFromDiscounts).toBe(true)
		expect(
			MenuVariationSchema.parse({ id: 'v2', valueIds: ['a'], price: 1 })
				.excludeFromDiscounts,
		).toBe(false)
	})

	it('validates MenuItemInputSchema with calories and allergens', () => {
		const parsed = MenuItemInputSchema.safeParse({
			displayName: 'Cheeseburger',
			price: '12.99',
			isGlutenFree: false,
			isVegetarian: false,
			allergens: ['dairy', 'gluten'],
			calorieMin: '550',
			calorieMax: '750',
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.price).toBe(12.99)
			expect(parsed.data.calorieMin).toBe(550)
			expect(parsed.data.calorieMax).toBe(750)
			expect(parsed.data.allergens).toEqual(['dairy', 'gluten'])
			expect(parsed.data.applySalesTax).toBe(true)
		}
	})

	it('allows up to five images for menu items only', () => {
		const parsed = MenuItemInputSchema.safeParse({
			displayName: 'Cheeseburger',
			price: 12.99,
			imageKeys: ['first', 'second'],
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.imageKeys).toEqual(['first', 'second'])
		}

		expect(
			parseMenuItemImageKeys('["first", "second", "first"]', 'legacy'),
		).toEqual(['first', 'second'])
		expect(parseMenuItemImageKeys('not-json', 'legacy')).toEqual(['legacy'])

		const option = ModifierOptionInputSchema.parse({
			displayName: 'Extra cheese',
			imageKeys: ['not-supported'],
		})
		expect(option).not.toHaveProperty('imageKeys')
	})

	it('requires a priced variation for every size and color combination', () => {
		const groups = [
			{
				id: 'size',
				name: 'Size',
				values: [
					{ id: 'small', name: 'Small' },
					{ id: 'large', name: 'Large' },
				],
			},
			{
				id: 'color',
				name: 'Color',
				values: [
					{ id: 'black', name: 'Black' },
					{ id: 'blue', name: 'Blue' },
				],
			},
		]
		const variants = groups[0]!.values.flatMap((size) =>
			groups[1]!.values.map((color) => ({
				id: `${size.id}-${color.id}`,
				valueIds: [size.id, color.id],
				price: size.id === 'large' ? 15 : 12,
				imageKey: color.id === 'black' ? 'black-photo' : null,
			})),
		)
		expect(MenuVariationsSchema.safeParse({ groups, variants }).success).toBe(
			true,
		)
		const legacy = MenuVariationsSchema.parse({ groups, variants })
		expect(
			legacy.variants.every(
				(variant) =>
					variant.availabilityStatus === 'available' &&
					variant.unavailableUntil === null,
			),
		).toBe(true)
		expect(
			MenuVariationsSchema.safeParse({
				groups,
				variants: [
					{ ...variants[0], availabilityStatus: 'unavailable_until' },
					...variants.slice(1),
				],
			}).success,
		).toBe(false)
		expect(
			MenuVariationsSchema.parse({
				groups,
				variants: [
					{
						...variants[0],
						availabilityStatus: 'unavailable_until',
						unavailableUntil: '2030-01-01T12:00:00.000Z',
					},
					...variants.slice(1),
				],
			}).variants[0]?.availabilityStatus,
		).toBe('unavailable_until')
		expect(
			MenuVariationsSchema.safeParse({ groups, variants: variants.slice(1) })
				.success,
		).toBe(false)
		expect(
			MenuVariationsSchema.safeParse({
				groups,
				variants: [...variants.slice(1), variants[1]],
			}).success,
		).toBe(false)
		expect(
			MenuVariationsSchema.safeParse({
				groups,
				variants: [{ ...variants[0], price: -1 }, ...variants.slice(1)],
			}).success,
		).toBe(false)
	})

	it('keeps combination pricing and photos when option names change', () => {
		const size = {
			id: 'size',
			name: 'Size',
			values: [{ id: 'small', name: 'Small' }],
		}
		const color = {
			id: 'color',
			name: 'Color',
			values: [{ id: 'black', name: 'Black' }],
		}
		const first = reconcileMenuVariations(
			{ groups: [], variants: [] },
			[size, color],
			10,
			() => 'first',
		)
		const priced = {
			...first,
			variants: [
				{
					...first.variants[0]!,
					price: 12,
					imageKey: 'black-photo',
					availabilityStatus: 'unavailable' as const,
				},
			],
		}
		const renamed = reconcileMenuVariations(
			priced,
			[{ ...size, name: 'Fit' }, color],
			10,
			() => 'unused',
		)
		expect(renamed.variants).toEqual(priced.variants)
		const expanded = reconcileMenuVariations(
			renamed,
			[
				{ ...size, values: [...size.values, { id: 'large', name: 'Large' }] },
				color,
			],
			10,
			() => 'second',
		)
		expect(expanded.variants).toEqual([
			priced.variants[0],
			{
				id: 'second',
				valueIds: ['large', 'black'],
				price: 10,
				imageKey: null,
				excludeFromDiscounts: false,
				availabilityStatus: 'available',
				unavailableUntil: null,
			},
		])
		const withAnotherColor = reconcileMenuVariations(
			priced,
			[
				size,
				{ ...color, values: [...color.values, { id: 'blue', name: 'Blue' }] },
			],
			10,
			() => 'new-color',
		)
		expect(withAnotherColor.variants[1]?.price).toBe(10)
		expect(withAnotherColor.variants[1]?.availabilityStatus).toBe('available')
		const withoutColor = reconcileMenuVariations(
			priced,
			[size],
			10,
			() => 'unused',
		)
		expect(withoutColor.variants).toEqual([
			{
				...priced.variants[0],
				valueIds: ['small'],
				availabilityStatus: 'available',
			},
		])
		const withFinish = reconcileMenuVariations(
			priced,
			[
				...priced.groups,
				{
					id: 'finish',
					name: 'Finish',
					values: [
						{ id: 'matte', name: 'Matte' },
						{ id: 'gloss', name: 'Gloss' },
					],
				},
			],
			10,
			() => 'new-finish',
		)
		expect(withFinish.variants.map((variant) => variant.price)).toEqual([
			12, 12,
		])
		expect(withFinish.variants.map((variant) => variant.imageKey)).toEqual([
			'black-photo',
			'black-photo',
		])
		expect(
			withFinish.variants.every(
				(variant) => variant.availabilityStatus === 'available',
			),
		).toBe(true)
	})

	it('validates ModifierGroupInputSchema with pizza option pricing', () => {
		const parsed = ModifierGroupInputSchema.safeParse({
			name: 'Choose Toppings',
			selectionType: 'pizza',
			options: [
				{
					displayName: 'Pepperoni',
					price: 2,
					priceWhole: 2,
					priceLeft: 1,
					priceRight: 1,
					isTopping: true,
				},
			],
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.selectionType).toBe('pizza')
			expect(parsed.data.options[0]?.priceWhole).toBe(2)
			expect(parsed.data.options[0]?.priceLeft).toBe(1)
		}
	})

	it('validates MenuInputSchema with nutritionalInfo and specialInstructions', () => {
		const parsed = MenuInputSchema.safeParse({
			displayName: 'Lunch Menu',
			menuType: 'online_pos_kiosk',
			nutritionalInfo: true,
			specialInstructions: true,
		})
		expect(parsed.success).toBe(true)
	})
	it('validates MenuCategoryInputSchema with parentId', () => {
		const parsed = MenuCategoryInputSchema.safeParse({
			displayName: 'Hot Coffees',
			parentId: 'cat_drinks_1',
		})
		expect(parsed.success).toBe(true)
		if (parsed.success) {
			expect(parsed.data.parentId).toBe('cat_drinks_1')
		}
	})

	it('validates category hierarchy depth and prevents cycles', () => {
		const categories = [
			{ id: 'drinks', parentId: null },
			{ id: 'hot_coffees', parentId: 'drinks' },
			{ id: 'americanos', parentId: 'hot_coffees' },
		]
		const map = new Map(categories.map((c) => [c.id, c]))

		expect(getCategoryDepth('drinks', map)).toBe(1)
		expect(getCategoryDepth('hot_coffees', map)).toBe(2)
		expect(getCategoryDepth('americanos', map)).toBe(3)

		// Adding Level 4 should be rejected (maxDepth = 3)
		const level4Check = isValidParentCategory(
			'blonde_americano',
			'americanos',
			categories,
			3,
		)
		expect(level4Check.valid).toBe(false)
		expect(level4Check.reason).toContain('maximum of 3 levels')

		// Self-parenting should be rejected
		const selfCheck = isValidParentCategory('drinks', 'drinks', categories, 3)
		expect(selfCheck.valid).toBe(false)
		expect(selfCheck.reason).toContain('cannot be its own parent')

		// Circular reference (descendant as parent) should be rejected
		const cycleCheck = isValidParentCategory(
			'drinks',
			'hot_coffees',
			categories,
			3,
		)
		expect(cycleCheck.valid).toBe(false)
		expect(cycleCheck.reason).toContain('descendant')

		// Valid parent assignment
		const validCheck = isValidParentCategory(
			'cold_coffees',
			'drinks',
			categories,
			3,
		)
		expect(validCheck.valid).toBe(true)
	})

	it('validates ModifierOptionInputSchema and MenuOptionInputSchema with nestedModifierGroupIds', () => {
		const parsedOption = ModifierOptionInputSchema.safeParse({
			displayName: 'French Fries',
			price: 4.5,
			nestedModifierGroupIds: ['grp_fry_size', 'grp_dipping_sauce'],
		})
		expect(parsedOption.success).toBe(true)
		if (parsedOption.success) {
			expect(parsedOption.data.nestedModifierGroupIds).toEqual([
				'grp_fry_size',
				'grp_dipping_sauce',
			])
		}

		const parsedMenuOption = MenuOptionInputSchema.safeParse({
			displayName: 'French Fries',
			price: 4.5,
			modifierGroupIds: ['grp_sides'],
			nestedModifierGroupIds: ['grp_fry_size'],
		})
		expect(parsedMenuOption.success).toBe(true)
		if (parsedMenuOption.success) {
			expect(parsedMenuOption.data.modifierGroupIds).toEqual(['grp_sides'])
			expect(parsedMenuOption.data.nestedModifierGroupIds).toEqual([
				'grp_fry_size',
			])
		}
	})

	it('generates accurate pickup slots without exceeding window boundaries', () => {
		const slots = generatePickupSlots('10:00', '11:30', 30)
		expect(slots).toHaveLength(3)
		expect(slots[0]).toEqual({
			time: '10:00',
			displayTime: '10:00am',
		})
		expect(slots[1]).toEqual({
			time: '10:30',
			displayTime: '10:30am',
		})
		expect(slots[2]).toEqual({
			time: '11:00',
			displayTime: '11:00am',
		})

		// When window is smaller than interval
		const emptySlots = generatePickupSlots('10:00', '10:15', 30)
		expect(emptySlots).toHaveLength(0)

		// 15-minute interval check
		const slots15 = generatePickupSlots('14:00', '14:45', 15)
		expect(slots15).toHaveLength(3)
		expect(slots15[0]?.displayTime).toBe('2:00pm')
		expect(slots15[2]?.displayTime).toBe('2:30pm')
	})

	it('validates DropInputSchema with defaults and pickup windows', () => {
		const validDrop = {
			menuId: 'menu_123',
			title: 'Friday Night Cookie Drop',
			slug: 'friday-night-cookie-drop',
			status: 'scheduled',
			pickupWindows: [
				{
					locationId: 'loc_123',
					date: '2026-10-10',
					startTime: '12:00',
					endTime: '14:00',
					slotIntervalMinutes: 30,
					maxOrdersPerSlot: 10,
				},
			],
			assignedCategoryIds: ['cat_1', 'cat_2'],
		}

		const parsed = DropInputSchema.safeParse(validDrop)
		expect(parsed.success).toBe(true)
		expect(
			DropInputSchema.safeParse({ ...validDrop, menuId: '' }).success,
		).toBe(false)
		if (parsed.success) {
			expect(parsed.data.checkoutHoldMinutes).toBe(5)
			expect(parsed.data.showOrdersOpenTime).toBe(true)
			expect(parsed.data.showMenuPreview).toBe(true)
			expect(parsed.data.showInventoryRemaining).toBe(true)
			expect(parsed.data.pickupWindows[0]?.slotIntervalMinutes).toBe(30)
		}

		expect(AvailabilityStatusSchema.safeParse('hidden').success).toBe(true)

		// Invalid status should fail
		const invalidStatus = DropInputSchema.safeParse({
			...validDrop,
			status: 'nonexistent_status',
		})
		expect(invalidStatus.success).toBe(false)
	})

	it('accepts localized drop names without limiting the serialized map to 150 characters', () => {
		const title = JSON.stringify({
			en: 'Weekend drop'.repeat(10),
			ar: 'مخبوزات نهاية الأسبوع',
		})
		const parsed = DropInputSchema.safeParse({ menuId: 'menu_123', title })
		expect(parsed.success).toBe(true)
		expect(hasDropDefaultTitle(title, 'en')).toBe(true)
		expect(hasDropDefaultTitle(title, 'ar')).toBe(true)
		expect(hasDropDefaultTitle('Legacy name', 'ar')).toBe(true)
		expect(hasDropDefaultTitle('{"en":"English only"}', 'ar')).toBe(false)
		expect(hasDropDefaultTitle('{"en":"  "}', 'en')).toBe(false)
		expect(
			DropInputSchema.safeParse({
				menuId: 'menu_123',
				title: JSON.stringify({ en: 'x'.repeat(151), ar: 'اسم' }),
			}).success,
		).toBe(false)
		expect(
			DropInputSchema.safeParse({
				menuId: 'menu_123',
				title: 'x'.repeat(151),
			}).success,
		).toBe(false)
	})

	it('derives published phases from order times while treating legacy completed as closed', () => {
		const now = new Date('2026-10-05T12:00:00.000Z')
		const future = '2026-10-05T13:00:00.000Z'
		const past = '2026-10-05T11:00:00.000Z'
		expect(getDropDisplayStatus('draft', past, future, now)).toBe('draft')
		expect(getDropDisplayStatus('scheduled', future, null, now)).toBe(
			'scheduled',
		)
		expect(getDropDisplayStatus('scheduled', past, future, now)).toBe('live')
		expect(getDropDisplayStatus('scheduled', past, now, now)).toBe('closed')
		expect(getDropDisplayStatus('live', future, null, now)).toBe('scheduled')
		expect(getDropDisplayStatus('completed', past, future, now)).toBe('closed')
	})
	it('discovers only published public drops while preserving unlisted link access', () => {
		expect(isDropDiscoverable('draft', 'public')).toBe(false)
		expect(isDropDiscoverable('scheduled', 'public')).toBe(true)
		expect(isDropDiscoverable('live', 'public')).toBe(true)
		expect(isDropDiscoverable('closed', 'public')).toBe(true)
		expect(isDropDiscoverable('completed', 'public')).toBe(true)
		expect(isDropDiscoverable('live', 'unlisted')).toBe(false)
	})

	it('requires a valid ordering and pickup schedule to publish, but not to save a draft', () => {
		const now = new Date('2026-10-05T12:00:00.000Z')
		const draft = DropInputSchema.parse({
			menuId: 'menu_123',
			title: 'Friday Drop',
			status: 'draft',
		})
		expect(draft.ordersOpenAt).toBeNull()
		expect(getDropPublicationErrors(draft, now)).toMatchObject({
			ordersOpenAt: expect.any(Array),
			ordersCloseAt: expect.any(Array),
			pickupWindows: expect.any(Array),
		})

		const scheduled = {
			...draft,
			status: 'scheduled' as const,
			ordersOpenAt: new Date('2026-10-06T10:00:00.000Z'),
			ordersCloseAt: new Date('2026-10-06T11:00:00.000Z'),
			pickupWindows: [
				{
					locationId: 'loc_123',
					date: '2026-10-07',
					startTime: '12:00',
					endTime: '14:00',
					slotIntervalMinutes: 30,
					maxOrdersPerSlot: null,
					orderLeadTimeMinutes: 0,
				},
			],
		}
		expect(getDropPublicationErrors(scheduled, now)).toEqual({})
		expect(
			getDropPublicationErrors(
				{ ...scheduled, ordersCloseAt: scheduled.ordersOpenAt },
				now,
			).ordersCloseAt,
		).toEqual(['The closing time must be after the opening time.'])
		const pastWindow = {
			...scheduled,
			ordersOpenAt: new Date('2026-10-04T10:00:00.000Z'),
			ordersCloseAt: new Date('2026-10-04T11:00:00.000Z'),
		}
		expect(getDropPublicationErrors(pastWindow, now).ordersCloseAt).toEqual([
			'The closing time must be in the future.',
		])
		expect(
			getDropPublicationErrors(pastWindow, now, {
				requireFutureClose: false,
			}),
		).toEqual({})
	})
})

describe('validateModifierGraph', () => {
	// Each group gets one option `<group>-opt`; `links` nests groups under it.
	function graph(links: Record<string, string[]>, groups: string[] = []) {
		const ids = new Set([...groups, ...Object.keys(links)])
		for (const targets of Object.values(links)) {
			for (const id of targets) ids.add(id)
		}
		return {
			groupOptions: Object.fromEntries(
				[...ids].map((id) => [id, [`${id}-opt`]]),
			),
			optionNestedGroups: Object.fromEntries(
				Object.entries(links).map(([id, targets]) => [`${id}-opt`, targets]),
			),
		}
	}

	it('accepts groups without nesting', () => {
		expect(validateModifierGraph(graph({}, ['size', 'extras']))).toEqual({
			ok: true,
		})
	})

	it('refuses a group nested under one of its own options', () => {
		expect(validateModifierGraph(graph({ size: ['size'] }))).toEqual({
			ok: false,
			reason: 'modifier_cycle',
			path: ['size', 'size'],
		})
	})

	it('refuses a two-step loop', () => {
		const result = validateModifierGraph(
			graph({ size: ['extras'], extras: ['size'] }),
		)
		expect(result).toMatchObject({ ok: false, reason: 'modifier_cycle' })
		if (!result.ok) {
			expect(result.path[0]).toBe(result.path.at(-1))
			expect(new Set(result.path)).toEqual(new Set(['size', 'extras']))
		}
	})

	it('finds a loop through an option shared by two groups', () => {
		// `cheese` sits in both groups; nesting `sauce` under it loops back.
		const result = validateModifierGraph({
			groupOptions: { toppings: ['cheese'], sauce: ['cheese'] },
			optionNestedGroups: { cheese: ['sauce'] },
		})
		expect(result).toEqual({
			ok: false,
			reason: 'modifier_cycle',
			path: ['sauce', 'sauce'],
		})
	})

	it('allows three nested levels and refuses four', () => {
		expect(
			validateModifierGraph(graph({ a: ['b'], b: ['c'], c: ['d'] })),
		).toEqual({ ok: true })
		expect(
			validateModifierGraph(graph({ a: ['b'], b: ['c'], c: ['d'], d: ['e'] })),
		).toEqual({
			ok: false,
			reason: 'modifier_too_deep',
			path: ['a', 'b', 'c', 'd', 'e'],
		})
	})

	it('respects a custom depth', () => {
		expect(
			validateModifierGraph({ ...graph({ a: ['b'], b: ['c'] }), maxDepth: 1 }),
		).toMatchObject({ ok: false, reason: 'modifier_too_deep' })
	})

	it('only blames links the edit adds when given the previous graph', () => {
		// An old loop elsewhere must not block an unrelated save.
		const previous = graph({ x: ['y'], y: ['x'] }, ['size', 'extras'])
		const next = graph({ x: ['y'], y: ['x'], size: ['extras'] })
		expect(validateModifierGraph({ ...next, previous })).toEqual({ ok: true })
		// Without the previous graph the old loop is reported.
		expect(validateModifierGraph(next)).toMatchObject({
			ok: false,
			reason: 'modifier_cycle',
		})
	})

	it('refuses an edit that closes a loop through another group', () => {
		const previous = graph({ a: ['b'] }, ['b'])
		const next = graph({ a: ['b'], b: ['a'] })
		expect(validateModifierGraph({ ...next, previous })).toEqual({
			ok: false,
			reason: 'modifier_cycle',
			path: ['b', 'a', 'b'],
		})
	})

	it('counts the levels above an edited link', () => {
		const previous = graph({ a: ['b'], b: ['c'] }, ['d', 'e'])
		const next = graph({ a: ['b'], b: ['c'], d: ['e'], c: ['d'] })
		expect(validateModifierGraph({ ...next, previous })).toEqual({
			ok: false,
			reason: 'modifier_too_deep',
			path: ['a', 'b', 'c', 'd', 'e'],
		})
	})

	it('lets an edit remove links from bad data', () => {
		const previous = graph({ a: ['b'], b: ['a'] })
		const next = graph({ a: ['b'] }, ['b'])
		expect(validateModifierGraph({ ...next, previous })).toEqual({ ok: true })
	})
})

describe('findBlockedNestedGroups', () => {
	const graph = {
		groupOptions: {
			size: ['large'],
			extras: ['bacon'],
			sauce: ['mayo'],
			a: ['a1'],
			b: ['b1'],
			c: ['c1'],
		},
		optionNestedGroups: { bacon: ['size'], a1: ['b'], b1: ['c'] },
	}

	it('blocks groups that would loop back to the option own group', () => {
		// `large` sits in Size; Extras already nests Size under bacon.
		expect(
			findBlockedNestedGroups({
				graph,
				optionId: 'large',
				groupIds: ['size'],
				nestedGroupIds: [],
				candidateIds: ['size', 'extras', 'sauce'],
			}),
		).toEqual({ size: 'modifier_cycle', extras: 'modifier_cycle' })
	})

	it('blocks groups that would nest too deep and judges the form state', () => {
		// a -> b -> c already: Size (no nesting) fits as a third level, while
		// Extras (-> Size) and Sauce (-> Extras -> Size) would go deeper.
		const deep = {
			...graph,
			optionNestedGroups: { ...graph.optionNestedGroups, mayo: ['extras'] },
		}
		expect(
			findBlockedNestedGroups({
				graph: deep,
				optionId: 'c1',
				groupIds: ['c'],
				nestedGroupIds: [],
				candidateIds: ['size', 'sauce', 'extras'],
			}),
		).toEqual({ sauce: 'modifier_too_deep', extras: 'modifier_too_deep' })
	})

	it('applies membership changes for a new option', () => {
		expect(
			applyModifierGraphChange(graph, {
				options: [{ id: 'new', nestedGroupIds: ['sauce'], groupIds: ['c'] }],
			}).groupOptions.c,
		).toEqual(['c1', 'new'])
	})
})
