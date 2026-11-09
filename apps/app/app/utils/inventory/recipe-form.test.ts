import {
	foodCostStatus,
	putRecipeSchema,
	type PlateCost,
	type Recipe,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	addLine,
	buildPutRecipe,
	chooseLineItem,
	chunk,
	convertLineUnit,
	costRowView,
	draftFromRecipe,
	emptyDraft,
	emptyLine,
	isRecipeDirty,
	majorToMinor,
	plateView,
	recipeEntryUnit,
	recipeProblems,
	regionCurrency,
	removeLine,
	setMode,
	updateLine,
	type RecipeDraft,
} from './recipe-form.ts'

const CHICKEN = {
	id: 'itm_chicken',
	name: 'Chicken thighs',
	baseUnit: 'g' as const,
	units: [{ id: 'box', name: 'Box', baseQuantity: 10_000_000 }],
}
const PITA = {
	id: 'itm_pita',
	name: 'Pita bread',
	baseUnit: 'piece' as const,
	units: [],
}

function filled(): RecipeDraft {
	let draft = addLine(emptyDraft('menu_item'))
	const [first] = draft.lines
	draft = chooseLineItem(draft, first!.key, CHICKEN, 'g')
	draft = updateLine(draft, first!.key, { amount: 180, usablePercent: 85 })
	return draft
}

describe('recipe draft editing', () => {
	it('adds, edits and removes ingredient rows', () => {
		let draft = emptyDraft('menu_item')
		expect(draft.lines).toEqual([])
		draft = addLine(draft)
		draft = addLine(draft)
		expect(draft.lines).toHaveLength(2)
		const key = draft.lines[0]!.key
		draft = chooseLineItem(draft, key, CHICKEN, 'g')
		expect(draft.lines[0]).toMatchObject({
			itemId: 'itm_chicken',
			itemName: 'Chicken thighs',
			unit: 'g',
			usablePercent: 100,
		})
		draft = removeLine(draft, key)
		expect(draft.lines).toHaveLength(1)
	})

	it('converts the typed amount when the unit changes, keeping the quantity', () => {
		const line = emptyLine('add', {
			itemId: CHICKEN.id,
			baseUnit: 'g',
			units: CHICKEN.units,
			amount: 0.18,
			unit: 'kg',
		})
		expect(convertLineUnit(line, 'g')).toMatchObject({ amount: 180, unit: 'g' })
		// A named unit converts through the base unit: 1 Box is 10 kg.
		expect(
			convertLineUnit({ ...line, amount: 2, unit: 'unit:box' }, 'kg'),
		).toMatchObject({ amount: 20, unit: 'kg' })
		// A unit the ingredient cannot be measured in leaves the amount alone.
		expect(convertLineUnit(line, 'ml')).toMatchObject({ amount: 0.18 })
	})

	it('offers grams, millilitres and pieces first (ounces in US units)', () => {
		expect(recipeEntryUnit('g', 'metric')).toBe('g')
		expect(recipeEntryUnit('ml', 'metric')).toBe('ml')
		expect(recipeEntryUnit('piece', 'us')).toBe('piece')
		expect(recipeEntryUnit('g', 'us')).toBe('oz')
		expect(recipeEntryUnit('ml', 'us')).toBe('fl_oz')
	})

	it('switches a size between its multiple and its own ingredients', () => {
		let draft = emptyDraft('variant')
		expect(draft).toMatchObject({ mode: 'multiplier', multiplier: 1 })
		draft = setMode(draft, 'lines')
		expect(draft.mode).toBe('lines')
		draft = setMode(draft, 'multiplier')
		expect(draft.multiplier).toBe(1)
	})
})

describe('recipe validation', () => {
	const rules = { ownerKind: 'menu_item' as const, currency: 'SAR' }

	it('needs at least one ingredient', () => {
		expect(recipeProblems(emptyDraft('menu_item'), rules)).toContain('empty')
	})

	it('flags a row without an ingredient, amount or usable percent', () => {
		const draft = addLine(emptyDraft('menu_item'))
		const key = draft.lines[0]!.key
		const problems = recipeProblems(
			updateLine(draft, key, { usablePercent: 0 }),
			rules,
		)
		expect(problems).toEqual(
			expect.arrayContaining([
				{ line: key, field: 'item' },
				{ line: key, field: 'amount' },
				{ line: key, field: 'unit' },
				{ line: key, field: 'usable' },
			]),
		)
		expect(
			recipeProblems(updateLine(draft, key, { usablePercent: 101 }), rules),
		).toContainEqual({ line: key, field: 'usable' })
	})

	it('refuses listing an ingredient twice', () => {
		let draft = filled()
		draft = addLine(draft)
		draft = chooseLineItem(draft, draft.lines[1]!.key, CHICKEN, 'g')
		draft = updateLine(draft, draft.lines[1]!.key, { amount: 10 })
		expect(recipeProblems(draft, rules)).toContain('duplicate')
	})

	it('checks a typed cost and a size multiple', () => {
		expect(
			recipeProblems(
				{ ...emptyDraft('menu_item'), mode: 'typed', typedCostText: 'abc' },
				rules,
			),
		).toEqual(['typed_cost'])
		expect(
			recipeProblems(
				{ ...emptyDraft('menu_item'), mode: 'typed', typedCostText: '4.50' },
				rules,
			),
		).toEqual([])
		const size = { ...rules, ownerKind: 'variant' as const }
		expect(
			recipeProblems({ ...emptyDraft('variant'), multiplier: 0 }, size),
		).toEqual(['multiplier'])
		expect(
			recipeProblems({ ...emptyDraft('variant'), multiplier: 150 }, size),
		).toEqual(['multiplier'])
		expect(recipeProblems(emptyDraft('variant'), size)).toEqual([])
	})

	it('needs a replace line to name what it replaces, and not itself', () => {
		let draft = addLine(emptyDraft('option'), emptyLine('replace'))
		const key = draft.lines[0]!.key
		draft = chooseLineItem(draft, key, CHICKEN, 'g')
		draft = updateLine(draft, key, { amount: 30 })
		const option = { ownerKind: 'option' as const, currency: 'SAR' }
		expect(recipeProblems(draft, option)).toContainEqual({
			line: key,
			field: 'replaces',
		})
		draft = updateLine(draft, key, { replacesItemId: CHICKEN.id })
		expect(recipeProblems(draft, option)).toContainEqual({
			line: key,
			field: 'replaces',
		})
		draft = updateLine(draft, key, { replacesItemId: PITA.id })
		expect(recipeProblems(draft, option)).toEqual([])
	})

	it('needs a made item to say what a batch makes', () => {
		const rulesMade = { ownerKind: 'made_item' as const, currency: 'SAR' }
		const draft = filled()
		expect(recipeProblems(draft, rulesMade)).toContain('makes')
		expect(
			recipeProblems({ ...draft, makesAmount: 4, makesUnit: 'l' }, rulesMade),
		).toEqual([])
	})
})

describe('buildPutRecipe', () => {
	const input = {
		ownerKind: 'menu_item' as const,
		ownerId: 'mi_1',
		expectedVersion: 3,
		currency: 'SAR',
	}

	it('sends ids and numbers only, and parses with the contract', () => {
		const body = buildPutRecipe(filled(), input)
		expect(body).toEqual({
			ownerKind: 'menu_item',
			ownerId: 'mi_1',
			expectedVersion: 3,
			lines: [
				{
					itemId: 'itm_chicken',
					amount: 180,
					unit: 'g',
					usableBp: 8500,
					mode: 'add',
				},
			],
		})
		expect(putRecipeSchema.safeParse(body).success).toBe(true)
		expect(JSON.stringify(body)).not.toContain('Chicken')
	})

	it('returns null while the draft has problems', () => {
		expect(buildPutRecipe(emptyDraft('menu_item'), input)).toBeNull()
	})

	it('builds a typed cost in minor units of the currency', () => {
		const body = buildPutRecipe(
			{ ...emptyDraft('menu_item'), mode: 'typed', typedCostText: '4.50' },
			input,
		)
		expect(body).toMatchObject({
			lines: [],
			typedCost: { minor: 450, currency: 'SAR' },
		})
		expect(putRecipeSchema.safeParse(body).success).toBe(true)
	})

	it('builds a size multiple in basis points with no ingredients', () => {
		const body = buildPutRecipe(
			{ ...emptyDraft('variant'), multiplier: 1.5 },
			{ ...input, ownerKind: 'variant', ownerId: 'v1' },
		)
		expect(body).toMatchObject({ lines: [], multiplierBp: 15_000 })
		expect(putRecipeSchema.safeParse(body).success).toBe(true)
	})

	it('builds a replace line for an option with what it replaces', () => {
		let draft = addLine(emptyDraft('option'), emptyLine('replace'))
		const key = draft.lines[0]!.key
		draft = chooseLineItem(draft, key, PITA, 'piece')
		draft = updateLine(draft, key, {
			amount: 1,
			replacesItemId: CHICKEN.id,
			replacesItemName: CHICKEN.name,
		})
		const body = buildPutRecipe(draft, {
			...input,
			ownerKind: 'option',
			ownerId: 'opt_1',
		})
		expect(body?.lines[0]).toEqual({
			itemId: 'itm_pita',
			amount: 1,
			unit: 'piece',
			usableBp: 10_000,
			mode: 'replace',
			replacesItemId: 'itm_chicken',
		})
		expect(putRecipeSchema.safeParse(body).success).toBe(true)
	})

	it('builds what a made item makes', () => {
		const body = buildPutRecipe(
			{ ...filled(), makesAmount: 4, makesUnit: 'l' },
			{ ...input, ownerKind: 'made_item', ownerId: 'itm_sauce' },
		)
		expect(body).toMatchObject({ makes: { amount: 4, unit: 'l' } })
		expect(putRecipeSchema.safeParse(body).success).toBe(true)
	})
})

function recipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'r1',
		ownerKind: 'menu_item',
		ownerId: 'mi_1',
		version: 2,
		makesQuantity: null,
		multiplierBp: null,
		method: null,
		effectiveFrom: 0,
		createdAt: 0,
		lines: [
			{
				id: 'l1',
				itemId: 'itm_chicken',
				itemName: 'Chicken thighs',
				baseUnit: 'g',
				quantity: 180_000,
				usableBp: 8500,
				mode: 'add',
				replacesItemId: null,
				replacesItemName: null,
				sortOrder: 0,
				priced: true,
			},
		],
		...overrides,
	}
}

describe('draftFromRecipe', () => {
	const options = { system: 'metric' as const, currency: 'SAR' }

	it('shows stored thousandths as an amount in the best unit and usable percent', () => {
		const draft = draftFromRecipe(recipe(), 'menu_item', options)
		expect(draft.mode).toBe('lines')
		expect(draft.lines[0]).toMatchObject({
			itemName: 'Chicken thighs',
			amount: 180,
			unit: 'g',
			usablePercent: 85,
		})
		expect(isRecipeDirty(draft, draft)).toBe(false)
	})

	it('reads a recipe without ingredients as a typed cost', () => {
		const draft = draftFromRecipe(
			recipe({ lines: [], typedCostMinor: 450, typedCostCurrency: 'SAR' }),
			'menu_item',
			options,
		)
		expect(draft).toMatchObject({ mode: 'typed', typedCostText: '4.50' })
		// Without the cost grant the amount is absent: still typed, never zero.
		const hidden = draftFromRecipe(recipe({ lines: [] }), 'menu_item', options)
		expect(hidden).toMatchObject({ mode: 'typed', typedCostText: '' })
	})

	it('reads a size multiple', () => {
		const draft = draftFromRecipe(
			recipe({ ownerKind: 'variant', lines: [], multiplierBp: 15_000 }),
			'variant',
			options,
		)
		expect(draft).toMatchObject({ mode: 'multiplier', multiplier: 1.5 })
	})

	it('reads what a made item makes in its own unit', () => {
		const draft = draftFromRecipe(
			recipe({
				ownerKind: 'made_item',
				ownerId: 'itm_sauce',
				makesQuantity: 4_000_000,
			}),
			'made_item',
			{
				...options,
				known: new Map([
					[
						'itm_sauce',
						{ id: 'itm_sauce', name: 'Sauce', baseUnit: 'ml', units: [] },
					],
				]),
			},
		)
		expect(draft).toMatchObject({ makesAmount: 4, makesUnit: 'l' })
	})

	it('is dirty after an edit and clean after reverting', () => {
		const base = draftFromRecipe(recipe(), 'menu_item', options)
		const edited = updateLine(base, base.lines[0]!.key, { amount: 200 })
		expect(isRecipeDirty(edited, base)).toBe(true)
		expect(
			isRecipeDirty(
				updateLine(edited, base.lines[0]!.key, { amount: 180 }),
				base,
			),
		).toBe(false)
	})
})

describe('plateView', () => {
	const plate = (overrides: Partial<PlateCost> = {}): PlateCost => ({
		state: 'complete',
		costMinor: 655,
		currency: 'SAR',
		missingItemIds: [],
		...overrides,
	})

	it('works out food cost, its status and the price for the target', () => {
		const view = plateView(plate(), {
			priceMinor: 2200,
			targetBp: 3000,
			currency: 'SAR',
		})
		expect(view).toMatchObject({
			showMoney: true,
			costMinor: 655,
			foodCostBp: 2977,
			status: foodCostStatus(2977, 3000),
			priceForTargetMinor: 2183,
		})
		expect(view.status).toBe('good')
	})

	it('marks a cost over the target', () => {
		expect(
			plateView(plate({ costMinor: 900 }), {
				priceMinor: 2200,
				targetBp: 3000,
				currency: 'SAR',
			}).status,
		).toBe('high')
	})

	it('shows no money when the region left it out', () => {
		const view = plateView(
			{ state: 'complete', missingItemIds: [] },
			{ priceMinor: 2200, targetBp: 3000, currency: 'SAR' },
		)
		expect(view).toMatchObject({
			showMoney: false,
			costMinor: null,
			foodCostBp: null,
			status: null,
			priceForTargetMinor: null,
		})
		expect(
			plateView(undefined, { priceMinor: 100, targetBp: 3000, currency: 'SAR' })
				.showMoney,
		).toBe(false)
	})

	it('counts ingredients without a price and keeps a typed cost labelled', () => {
		expect(
			plateView(plate({ state: 'partial', missingItemIds: ['a', 'b'] }), {
				priceMinor: null,
				targetBp: null,
				currency: 'SAR',
			}),
		).toMatchObject({ unpricedCount: 2, foodCostBp: null, status: null })
		expect(
			plateView(plate({ state: 'typed' }), {
				priceMinor: 2200,
				targetBp: 3000,
				currency: 'SAR',
			}).typed,
		).toBe(true)
	})

	it('has no food cost for a free dish', () => {
		expect(
			plateView(plate(), { priceMinor: 0, targetBp: 3000, currency: 'SAR' })
				.foodCostBp,
		).toBeNull()
	})
})

describe('costRowView', () => {
	it('shows nothing for a dish without a recipe or a missing row', () => {
		expect(costRowView(undefined)).toEqual({
			hasRecipe: false,
			foodCostBp: null,
			status: null,
		})
		expect(costRowView({ hasRecipe: false, state: 'none' })).toMatchObject({
			hasRecipe: false,
		})
	})

	it('passes the percent and status through, never inventing one', () => {
		expect(
			costRowView({
				hasRecipe: true,
				state: 'complete',
				costMinor: 655,
				foodCostBp: 2977,
				status: 'good',
			}),
		).toEqual({ hasRecipe: true, foodCostBp: 2977, status: 'good' })
		expect(costRowView({ hasRecipe: true, state: 'complete' })).toEqual({
			hasRecipe: true,
			foodCostBp: null,
			status: null,
		})
	})
})

describe('small helpers', () => {
	it('converts a menu price to minor units of the region currency', () => {
		expect(regionCurrency('ksa')).toBe('SAR')
		expect(regionCurrency('us')).toBe('USD')
		expect(majorToMinor(22, 'SAR')).toBe(2200)
		expect(majorToMinor(21.83, 'USD')).toBe(2183)
		expect(majorToMinor(0.1 + 0.2, 'USD')).toBe(30)
	})

	it('splits costs requests into chunks of 200', () => {
		const rows = Array.from({ length: 450 }, (_, index) => index)
		expect(chunk(rows, 200).map((part) => part.length)).toEqual([200, 200, 50])
		expect(chunk([], 200)).toEqual([])
	})
})
