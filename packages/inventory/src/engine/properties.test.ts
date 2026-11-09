import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
	expandDish,
	expandLines,
	expandRecipe,
	MAX_RECIPE_DEPTH,
	roundUsage,
} from './expand.ts'
import { fmul, frac, roundHalfUp } from './fraction.ts'
import { MAX_ENTRY_QUANTITY } from '../units.ts'
import { item, recipe, store } from './fixtures.ts'
import {
	applyUsageDeltas,
	desiredUsage,
	diffUsage,
	type UsageEntry,
} from './usage.ts'
import {
	type RecipeItemFacts,
	type RecipeLineSpec,
	type RecipeVersion,
	type SaleLine,
} from './types.ts'

const RUNS = { numRuns: 300 }
const AT = 1_000

const BOUGHT = ['b0', 'b1', 'b2', 'b3', 'b4']
const MADE = ['m0', 'm1', 'm2']
const DISHES = ['d0', 'd1', 'd2', 'd3']
const VARIANTS = ['v0', 'v1', 'v2']
const OPTIONS = ['o0', 'o1', 'o2', 'o3']

const arbQuantity = fc.integer({ min: 1, max: 1_000_000 })
const arbUsable = fc.integer({ min: 100, max: 10_000 })

const arbAddLine = (ids: readonly string[]): fc.Arbitrary<RecipeLineSpec> =>
	fc.record({
		itemId: fc.constantFrom(...ids),
		quantity: arbQuantity,
		usableBp: arbUsable,
		mode: fc.constant('add' as const),
		replacesItemId: fc.constant(null),
	})

const arbReplaceLine: fc.Arbitrary<RecipeLineSpec> = fc
	.tuple(
		fc.constantFrom(...BOUGHT),
		fc.constantFrom(...BOUGHT),
		arbQuantity,
		arbUsable,
	)
	.filter(([itemId, replaces]) => itemId !== replaces)
	.map(([itemId, replaces, quantity, usableBp]) => ({
		itemId,
		quantity,
		usableBp,
		mode: 'replace' as const,
		replacesItemId: replaces,
	}))

const uniqueByItem = (lines: RecipeLineSpec[]) => {
	const seen = new Set<string>()
	return lines.filter((l) => !seen.has(l.itemId) && seen.add(l.itemId))
}

/**
 * A random menu: made items only reference bought items and LOWER made items
 * (so no loops), and some are counted in batches. Options mix adds and swaps.
 */
const arbStore = fc
	.record({
		madeCounted: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
		madeLines: fc.tuple(
			fc.array(arbAddLine(BOUGHT), { minLength: 1, maxLength: 3 }),
			fc.array(arbAddLine([...BOUGHT, 'm0']), { minLength: 1, maxLength: 3 }),
			fc.array(arbAddLine([...BOUGHT, 'm0', 'm1']), {
				minLength: 1,
				maxLength: 3,
			}),
		),
		makes: fc.array(fc.integer({ min: 1000, max: 10_000_000 }), {
			minLength: 3,
			maxLength: 3,
		}),
		dishLines: fc.array(
			fc.array(arbAddLine([...BOUGHT, ...MADE]), { maxLength: 4 }),
			{ minLength: 4, maxLength: 4 },
		),
		variants: fc.array(
			fc.oneof(
				fc.record({
					kind: fc.constant('multiplier' as const),
					bp: fc.integer({ min: 100, max: 40_000 }),
				}),
				fc.record({
					kind: fc.constant('own' as const),
					lines: fc.array(arbAddLine(BOUGHT), { maxLength: 3 }),
				}),
				fc.constant({ kind: 'none' as const }),
			),
			{ minLength: 3, maxLength: 3 },
		),
		options: fc.array(
			fc.array(fc.oneof(arbAddLine(BOUGHT), arbReplaceLine), { maxLength: 3 }),
			{ minLength: 4, maxLength: 4 },
		),
	})
	.map((spec) => {
		const recipes: RecipeVersion[] = []
		const items: RecipeItemFacts[] = []
		MADE.forEach((id, i) => {
			items.push(item(id, 'made', spec.madeCounted[i]!))
			recipes.push(
				recipe('made_item', id, uniqueByItem(spec.madeLines[i]!), {
					makesQuantity: spec.makes[i]!,
				}),
			)
		})
		DISHES.forEach((id, i) => {
			recipes.push(recipe('menu_item', id, uniqueByItem(spec.dishLines[i]!)))
		})
		VARIANTS.forEach((id, i) => {
			const v = spec.variants[i]!
			if (v.kind === 'multiplier') {
				recipes.push(recipe('variant', id, [], { multiplierBp: v.bp }))
			} else if (v.kind === 'own') {
				recipes.push(recipe('variant', id, uniqueByItem(v.lines)))
			}
		})
		OPTIONS.forEach((id, i) => {
			recipes.push(recipe('option', id, uniqueByItem(spec.options[i]!)))
		})
		return store(recipes, items)
	})

const arbOptions = fc.array(
	fc.record({
		optionId: fc.constantFrom(...OPTIONS, 'no_recipe'),
		quantity: fc.integer({ min: 1, max: 4 }),
		half: fc.constantFrom('whole', 'left', 'right', null),
	}),
	{ maxLength: 4 },
)

const arbLine: fc.Arbitrary<SaleLine> = fc.record({
	itemId: fc.constantFrom(...DISHES, 'no_recipe'),
	variantId: fc.constantFrom(...VARIANTS, 'no_recipe', null),
	quantity: fc.integer({ min: 1, max: 20 }),
	options: arbOptions,
})

describe('expansion', () => {
	test('never negative, always whole thousandths, never zero rows', () => {
		fc.assert(
			fc.property(arbStore, fc.array(arbLine, { maxLength: 6 }), (s, lines) => {
				const result = expandLines(s, lines, AT)
				// Made items here never loop; the only way a line can fail is by
				// asking for an absurd amount of one ingredient.
				for (const error of result.errors) {
					expect(error.code).toBe('usage_out_of_range')
				}
				for (const { quantity } of result.usage) {
					expect(quantity).toBeLessThanOrEqual(
						MAX_ENTRY_QUANTITY * lines.length,
					)
					expect(Number.isSafeInteger(quantity)).toBe(true)
					expect(quantity).toBeGreaterThan(0)
				}
			}),
			RUNS,
		)
	})

	test('rounds once: each item is within half a thousandth of the exact sum', () => {
		fc.assert(
			fc.property(arbStore, fc.array(arbLine, { maxLength: 5 }), (s, lines) => {
				fc.pre(expandLines(s, lines, AT).errors.length === 0)
				const exact = new Map<string, ReturnType<typeof frac>>()
				for (const line of lines) {
					const dish = expandDish(s, line, AT)
					if (!dish.ok) continue
					for (const [id, amount] of dish.usage) {
						const add = fmul(amount, frac(line.quantity))
						const have = exact.get(id)
						exact.set(
							id,
							have
								? frac(have.n * add.d + add.n * have.d, have.d * add.d)
								: add,
						)
					}
				}
				expect(expandLines(s, lines, AT).usage).toEqual(roundUsage(exact))
				for (const [id, value] of exact) {
					const got = expandLines(s, lines, AT).usage.find(
						(u) => u.itemId === id,
					)
					const rounded = BigInt(got?.quantity ?? 0)
					// |rounded - exact| <= 1/2  <=>  |2*rounded*d - 2*n| <= d
					const diff = 2n * rounded * value.d - 2n * value.n
					expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(value.d)
					expect(roundHalfUp(value)).toBe(rounded)
				}
			}),
			RUNS,
		)
	})

	test('the order of lines (and of options) does not matter', () => {
		fc.assert(
			fc.property(
				arbStore,
				fc.array(arbLine, { minLength: 1, maxLength: 6 }),
				fc.infiniteStream(fc.nat()),
				(s, lines, randoms) => {
					const shuffle = <T>(list: T[]): T[] => {
						const copy = [...list]
						const it = randoms[Symbol.iterator]()
						for (let i = copy.length - 1; i > 0; i--) {
							const j = it.next().value! % (i + 1)
							;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
						}
						return copy
					}
					const shuffled = shuffle(lines).map((line) => ({
						...line,
						options: shuffle([...(line.options ?? [])]),
					}))
					const a = expandLines(s, lines, AT)
					const b = expandLines(s, shuffled, AT)
					expect(b.usage).toEqual(a.usage)
					expect(b.errors.length).toBe(a.errors.length)
					expect(b.unrecipedLines.length).toBe(a.unrecipedLines.length)
				},
			),
			RUNS,
		)
	})

	test('two halves of an option are exactly one whole, replaces included', () => {
		fc.assert(
			fc.property(
				arbStore,
				fc.constantFrom(...DISHES),
				fc.constantFrom(...OPTIONS),
				fc.integer({ min: 1, max: 5 }),
				(s, itemId, optionId, quantity) => {
					const halves = expandLines(
						s,
						[
							{
								itemId,
								quantity,
								options: [
									{ optionId, half: 'left' },
									{ optionId, half: 'right' },
								],
							},
						],
						AT,
					)
					const whole = expandLines(
						s,
						[{ itemId, quantity, options: [{ optionId, half: 'whole' }] }],
						AT,
					)
					expect(halves.usage).toEqual(whole.usage)
				},
			),
			RUNS,
		)
	})

	test('a replace never leaves both: the swapped ingredient is gone, the new one is in', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5_000_000 }),
				fc.integer({ min: 1, max: 5_000_000 }),
				arbUsable,
				arbUsable,
				fc.integer({ min: 1, max: 9 }),
				(milk, oat, milkBp, oatBp, quantity) => {
					const s = store([
						recipe('menu_item', 'latte', [
							['milk', milk, milkBp],
							['espresso', 18_000],
						]),
						recipe('option', 'oat', [
							{
								itemId: 'oat',
								quantity: oat,
								usableBp: oatBp,
								mode: 'replace',
								replacesItemId: 'milk',
							},
						]),
					])
					const usage = Object.fromEntries(
						expandRecipe(
							s,
							{ itemId: 'latte', quantity, options: [{ optionId: 'oat' }] },
							AT,
						).usage.map((u) => [u.itemId, u.quantity]),
					)
					expect(usage.milk).toBeUndefined()
					expect(usage.oat).toBeGreaterThan(0)
					expect(usage.espresso).toBe(18_000 * quantity)
				},
			),
			RUNS,
		)
	})

	test('a loop of made items is found whatever its length, and a batch-counted link breaks it', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.nat(),
				(length, breakAt) => {
					const ids = Array.from({ length }, (_, i) => `c${i}`)
					const recipes = [recipe('menu_item', 'dish', [[ids[0]!, 1000]])]
					ids.forEach((id, i) => {
						recipes.push(
							recipe('made_item', id, [[ids[(i + 1) % length]!, 1000]]),
						)
					})
					const looped = store(
						recipes,
						ids.map((id) => item(id, 'made')),
					)
					const result = expandRecipe(
						looped,
						{ itemId: 'dish', quantity: 1 },
						AT,
					)
					expect(result.errors).toHaveLength(1)
					const error = result.errors[0]!
					expect(error.code).toBe('recipe_cycle')
					expect(error.path).toEqual([...ids, ids[0]!])
					expect(result.usage).toEqual([])

					const broken = store(
						recipes,
						ids.map((id, i) => item(id, 'made', i === breakAt % length)),
					)
					expect(
						expandRecipe(broken, { itemId: 'dish', quantity: 1 }, AT).errors,
					).toEqual([])
				},
			),
			RUNS,
		)
	})

	test(`nesting is capped at ${MAX_RECIPE_DEPTH} made items`, () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 14 }), (depth) => {
				const recipes = [recipe('menu_item', 'dish', [['m1', 1_000_000]])]
				const items = []
				for (let i = 1; i <= depth; i++) {
					recipes.push(
						recipe(
							'made_item',
							`m${i}`,
							[[i === depth ? 'flour' : `m${i + 1}`, 1_000_000]],
							{ makesQuantity: 1_000_000 },
						),
					)
					items.push(item(`m${i}`, 'made'))
				}
				const result = expandRecipe(
					store(recipes, items),
					{ itemId: 'dish', quantity: 1 },
					AT,
				)
				if (depth <= MAX_RECIPE_DEPTH) {
					expect(result.errors).toEqual([])
					expect(result.usage).toEqual([
						{ itemId: 'flour', quantity: 1_000_000 },
					])
				} else {
					expect(result.errors.map((e) => e.code)).toEqual(['recipe_too_deep'])
				}
			}),
			RUNS,
		)
	})
})

const arbEntries = fc.array(
	fc.record({
		itemId: fc.constantFrom('a', 'b', 'c', 'd'),
		locationId: fc.constantFrom('main', 'north'),
		quantity: fc.integer({ min: 0, max: 5_000_000 }),
	}),
	{ maxLength: 10 },
)

const totals = (entries: Iterable<UsageEntry>) => {
	const map = new Map<string, number>()
	for (const e of entries) {
		const key = `${e.locationId}/${e.itemId}`
		map.set(key, (map.get(key) ?? 0) + e.quantity)
	}
	return map
}

describe('diffUsage', () => {
	test('applying the desired usage twice posts nothing the second time', () => {
		fc.assert(
			fc.property(arbEntries, arbEntries, (applied, want) => {
				const first = diffUsage(applied, want)
				const afterFirst = applyUsageDeltas(applied, first)
				expect(diffUsage(afterFirst, want)).toEqual([])
				const afterSecond = applyUsageDeltas(
					afterFirst,
					diffUsage(afterFirst, want),
				)
				expect(afterSecond).toEqual(afterFirst)
			}),
			RUNS,
		)
	})

	test('the deltas add up to desired minus applied, per item and location', () => {
		fc.assert(
			fc.property(arbEntries, arbEntries, (applied, want) => {
				const deltas = diffUsage(applied, want)
				const before = totals(applied)
				const after = totals(want)
				const sum = new Map<string, number>()
				for (const d of deltas) {
					expect(d.usageDelta).not.toBe(0)
					expect(d.movementQuantity).toBe(-d.usageDelta)
					sum.set(`${d.locationId}/${d.itemId}`, d.usageDelta)
				}
				for (const key of new Set([...before.keys(), ...after.keys()])) {
					expect(sum.get(key) ?? 0).toBe(
						(after.get(key) ?? 0) - (before.get(key) ?? 0),
					)
				}
			}),
			RUNS,
		)
	})

	test('the order and splitting of the entries does not matter', () => {
		fc.assert(
			fc.property(arbEntries, arbEntries, (applied, want) => {
				const reversed = diffUsage([...applied].reverse(), [...want].reverse())
				expect(reversed).toEqual(diffUsage(applied, want))
			}),
			RUNS,
		)
	})

	test('the posted movements, summed, equal the final usage taken out', () => {
		fc.assert(
			fc.property(
				fc.array(arbEntries, { minLength: 1, maxLength: 5 }),
				(revisions) => {
					let applied: UsageEntry[] = []
					const movement = new Map<string, number>()
					for (const want of revisions) {
						const deltas = diffUsage(applied, want)
						for (const d of deltas) {
							const key = `${d.locationId}/${d.itemId}`
							movement.set(key, (movement.get(key) ?? 0) + d.movementQuantity)
						}
						applied = applyUsageDeltas(applied, deltas)
					}
					const final = totals(revisions[revisions.length - 1]!)
					for (const [key, value] of final) {
						expect(movement.get(key) ?? 0).toBe(0 - value)
					}
					expect(totals(applied)).toEqual(
						new Map([...final].filter(([, value]) => value > 0)),
					)
				},
			),
			RUNS,
		)
	})
})

describe('settling a sale from its lines', () => {
	test('any sequence of revisions converges to the last state, and a cancel returns to zero', () => {
		fc.assert(
			fc.property(
				arbStore,
				fc.array(fc.array(arbLine, { maxLength: 4 }), {
					minLength: 1,
					maxLength: 4,
				}),
				(s, revisions) => {
					let applied: UsageEntry[] = []
					for (const lines of revisions) {
						const want = desiredUsage({
							store: s,
							locationId: 'main',
							at: AT,
							source: { kind: 'pos_order', status: 'paid', lines },
						}).sale
						applied = applyUsageDeltas(applied, diffUsage(applied, want))
						expect(diffUsage(applied, want)).toEqual([])
					}
					const cancelled = desiredUsage({
						store: s,
						locationId: 'main',
						at: AT,
						source: { kind: 'pos_order', status: 'void', lines: revisions[0]! },
					}).sale
					expect(cancelled).toEqual([])
					expect(
						applyUsageDeltas(applied, diffUsage(applied, cancelled)),
					).toEqual([])
				},
			),
			RUNS,
		)
	})
})
