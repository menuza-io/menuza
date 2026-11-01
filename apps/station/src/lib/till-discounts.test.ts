import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Adjustment, type CartLine } from './pricing.ts'
import {
	automaticTillAdjustments,
	categoryIdsByItem,
	keptButNotOffered,
	parseTillRules,
	quoteTillManualDiscount,
	settleTillDiscounts,
	noteTillClock,
	reloadTillClock,
	tillRulesStatus,
	TILL_CLOCK_KEY,
	TILL_CLOCK_SKEW_MS,
	TILL_RULES_MAX_AGE_MS,
} from './till-discounts.ts'
import {
	type CatalogSnapshot,
	type MenuCategory,
	type MenuItem,
} from './types.ts'

const target = {
	scope: 'order',
	itemIds: [],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
}

const rule = (overrides: Record<string, unknown> = {}) => ({
	id: 'd1',
	version: 1,
	createdAt: '2026-01-01T00:00:00.000Z',
	name: 'Happy hour',
	internalName: null,
	description: null,
	status: 'active',
	application: 'automatic',
	valueType: 'percent',
	percentBp: 1000,
	amountMinor: null,
	currency: null,
	maxDiscountMinor: null,
	target,
	requirement: null,
	quantityRule: { kind: 'none' },
	maxDiscountedUnits: null,
	minSubtotalMinor: null,
	locationIds: null,
	channels: ['pos'],
	fulfillments: ['pickup', 'dine_in'],
	includeDrops: false,
	schedule: null,
	startsAt: null,
	endsAt: null,
	eligibility: 'everyone',
	totalLimit: null,
	perCustomerLimit: null,
	combinable: true,
	priority: 0,
	promoteOnMenu: false,
	requireApproval: false,
	...overrides,
})

const line = (overrides: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'i1',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 10_000,
	instructions: '',
	options: [],
	...overrides,
})

const items = new Map<string, MenuItem>()
const common = {
	categories: [],
	items,
	timeZone: 'UTC',
	currency: 'USD',
	locationId: null,
	fulfillment: 'pickup' as const,
}

describe('parseTillRules', () => {
	it('keeps valid till rules and drops malformed and non-till ones', () => {
		const rules = parseTillRules([
			rule(),
			rule({ id: 'web-only', channels: ['web'] }),
			{ nonsense: true },
		])
		expect(rules.map((row) => row.id)).toEqual(['d1'])
	})

	it('treats a missing or odd payload as no rules', () => {
		expect(parseTillRules(undefined)).toEqual([])
		expect(parseTillRules('x')).toEqual([])
	})
})

describe('automaticTillAdjustments', () => {
	it('applies an automatic percentage as a labelled adjustment', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [line()],
			rules: [rule()],
		})
		expect(rows).toEqual([
			{
				id: 'auto:d1',
				kind: 'discount',
				label: 'Happy hour',
				amountCents: 1000,
				// Which line took it, so tax shrinks line by line like online.
				lineAmounts: { l1: 1000 },
				version: 1,
			},
		])
	})

	it('discounts the toppings on a pizza at the till', () => {
		const pizza = line({
			itemId: 'pizza',
			name: 'Pizza',
			baseCents: 1200,
			options: [
				{
					groupId: 'toppings',
					groupName: 'Toppings',
					optionId: 'pepperoni',
					optionName: 'Pepperoni',
					quantity: 1,
					unitCents: 150,
					taxable: true,
				},
				{
					groupId: 'toppings',
					groupName: 'Toppings',
					optionId: 'mushroom',
					optionName: 'Mushroom',
					quantity: 1,
					unitCents: 100,
					taxable: true,
				},
				{
					groupId: 'toppings',
					groupName: 'Toppings',
					optionId: 'olives',
					optionName: 'Olives',
					quantity: 1,
					unitCents: 80,
					taxable: true,
				},
			],
		})
		const rows = automaticTillAdjustments({
			...common,
			lines: [pizza],
			rules: [
				rule({
					name: 'Two toppings free',
					percentBp: 10_000,
					target: {
						...target,
						scope: 'modifiers',
						modifierGroupIds: ['toppings'],
						modifierOptionIds: [],
					},
					quantityRule: { kind: 'per_item', quantity: 2 },
				}),
			],
		})
		// The pepperoni and the mushroom, 1.50 and 1.00.
		expect(rows).toEqual([
			{
				id: 'auto:d1',
				kind: 'discount',
				label: 'Two toppings free',
				amountCents: 250,
				lineAmounts: { l1: 250 },
				version: 1,
			},
		])
	})

	it('a set price at the till replaces the pizza and leaves its toppings', () => {
		const pizza = line({
			itemId: 'pizza',
			name: 'Pizza',
			baseCents: 1400,
			options: [
				{
					groupId: 'toppings',
					groupName: 'Toppings',
					optionId: 'pepperoni',
					optionName: 'Pepperoni',
					quantity: 1,
					unitCents: 300,
					taxable: true,
				},
			],
		})
		const rows = automaticTillAdjustments({
			...common,
			lines: [pizza],
			rules: [
				rule({
					valueType: 'fixed_price',
					percentBp: null,
					amountMinor: 1000,
					currency: 'USD',
					target: { ...target, scope: 'items', itemIds: ['pizza'] },
				}),
			],
		})
		expect(rows[0]?.amountCents).toBe(400)
	})

	it('matches a size by name from the item the line is for', () => {
		const sized = {
			id: 'i1',
			excludeFromDiscounts: false,
			variations: {
				groups: [
					{
						id: 'g1',
						name: 'Size',
						values: [
							{ id: 'v-large', name: 'Large' },
							{ id: 'v-small', name: 'Small' },
						],
					},
				],
				variants: [
					{
						id: 'var-large',
						valueIds: ['v-large'],
						excludeFromDiscounts: false,
					},
					{
						id: 'var-small',
						valueIds: ['v-small'],
						excludeFromDiscounts: false,
					},
				],
			},
		} as unknown as MenuItem
		const sizedItems = new Map([['i1', sized]])
		const largeForTen = rule({
			valueType: 'fixed_price',
			percentBp: null,
			amountMinor: 1000,
			currency: 'USD',
			target: {
				...target,
				scope: 'items',
				itemIds: ['i1'],
				variantNames: ['large'],
			},
		})
		const adjust = (variantId: string, baseCents: number) =>
			automaticTillAdjustments({
				...common,
				items: sizedItems,
				lines: [line({ itemId: 'i1', variantId, baseCents })],
				rules: [largeForTen],
			})
		expect(adjust('var-large', 1400)[0]?.amountCents).toBe(400)
		expect(adjust('var-small', 900)).toEqual([])
	})

	it('gives the step of a spend ladder the cart reaches', () => {
		const ladder = rule({
			percentBp: null,
			currency: 'USD',
			tiers: {
				basis: 'spend',
				steps: [
					{ at: 20_000, percentBp: 500, amountMinor: null },
					{ at: 50_000, percentBp: 1500, amountMinor: null },
				],
			},
		})
		const total = (baseCents: number) =>
			automaticTillAdjustments({
				...common,
				lines: [line({ baseCents })],
				rules: [ladder],
			})[0]?.amountCents
		expect(total(10_000)).toBeUndefined()
		expect(total(30_000)).toBe(1500)
		expect(total(60_000)).toBe(9000)
	})

	it('ignores manual rules and an empty cart', () => {
		expect(
			automaticTillAdjustments({
				...common,
				lines: [line()],
				rules: [rule({ application: 'manual' })],
			}),
		).toEqual([])
		expect(
			automaticTillAdjustments({ ...common, lines: [], rules: [rule()] }),
		).toEqual([])
	})

	it('does not apply outside its date window', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [line()],
			rules: [rule({ endsAt: '2026-01-01T00:00' })],
			now: new Date('2026-06-01T12:00:00Z'),
		})
		expect(rows).toEqual([])
	})
})

describe('quoteTillManualDiscount', () => {
	const manual = rule({ application: 'manual', percentBp: 5000 })
	const record = parseTillRules([manual])[0]!

	it('prices a manual percentage on the lines', () => {
		const quoted = quoteTillManualDiscount({
			...common,
			discount: record,
			lines: [line()],
		})
		expect(quoted).toMatchObject({ ok: true, amountMinor: 5000 })
	})

	it('cannot stack past the bill after automatic discounts', () => {
		const full = parseTillRules([
			rule({ application: 'manual', percentBp: 10_000 }),
		])[0]!
		const quoted = quoteTillManualDiscount({
			...common,
			discount: full,
			lines: [line()],
			priorDiscountMinor: 4000,
		})
		expect(quoted).toMatchObject({ ok: true, amountMinor: 6000 })
	})

	it('refuses an expired manual discount', () => {
		const expired = parseTillRules([
			rule({
				application: 'manual',
				endsAt: '2026-01-01T00:00',
			}),
		])[0]!
		const quoted = quoteTillManualDiscount({
			...common,
			discount: expired,
			lines: [line()],
			now: new Date('2026-06-01T12:00:00Z'),
		})
		expect(quoted.ok).toBe(false)
	})

	it('refuses a value that is not a whole number instead of throwing', () => {
		const variable = parseTillRules([
			rule({
				application: 'manual',
				valueType: 'variable_percent',
				percentBp: null,
			}),
		])[0]!
		const quoted = quoteTillManualDiscount({
			...common,
			discount: variable,
			lines: [line()],
			percentBp: Number.NaN,
		})
		expect(quoted.ok).toBe(false)
	})

	it('does not scale down excluded items when shrinking lines after prior discount', () => {
		const itemsWithExcluded = new Map<string, MenuItem>([
			[
				'i1',
				{
					id: 'i1',
					displayName: 'Burger',
					description: null,
					price: 100,
					imageUrl: null,
					variations: { groups: [], variants: [] },
					isVegetarian: false,
					isGlutenFree: false,
					isAlcohol: false,
					allergens: [],
					isPopular: false,
					excludeFromDiscounts: false,
					availabilityStatus: 'available',
					position: 1,
					modifierGroups: [],
				},
			],
			[
				'i2',
				{
					id: 'i2',
					displayName: 'Exclusive Wine',
					description: null,
					price: 100,
					imageUrl: null,
					variations: { groups: [], variants: [] },
					isVegetarian: false,
					isGlutenFree: false,
					isAlcohol: true,
					allergens: [],
					isPopular: false,
					excludeFromDiscounts: true,
					availabilityStatus: 'available',
					position: 2,
					modifierGroups: [],
				},
			],
		])
		const full = parseTillRules([
			rule({ application: 'manual', percentBp: 10_000 }),
		])[0]!
		const quoted = quoteTillManualDiscount({
			...common,
			items: itemsWithExcluded,
			discount: full,
			lines: [
				line({ id: 'l1', itemId: 'i1', baseCents: 10_000 }),
				line({ id: 'l2', itemId: 'i2', baseCents: 10_000 }),
			],
			priorDiscountMinor: 5_000,
		})
		expect(quoted).toMatchObject({ ok: true, amountMinor: 5000 })
	})
})

describe('till discount rules', () => {
	const snapshot = (menu: Record<string, unknown>, fetchedAt: number) =>
		({ key: 'catalog', fetchedAt, menu }) as unknown as CatalogSnapshot

	it('apply for 24 hours after they were fetched, then stop', () => {
		const rules = [rule()]
		const at = 1_000_000
		const fresh = tillRulesStatus(
			snapshot({ discountRules: rules, discountRulesAt: at }, at),
			at + TILL_RULES_MAX_AGE_MS,
		)
		expect(fresh.state).toBe('fresh')
		const old = tillRulesStatus(
			snapshot({ discountRules: rules, discountRulesAt: at }, at),
			at + TILL_RULES_MAX_AGE_MS + 1,
		)
		expect(old.state).toBe('expired')
	})

	it('uses the rules stamp, not the newer catalog fetch, once a refresh kept old rules', () => {
		const status = tillRulesStatus(
			snapshot({ discountRules: [rule()], discountRulesAt: 0 }, 5_000_000_000),
			TILL_RULES_MAX_AGE_MS + 5,
		)
		expect(status.state).toBe('expired')
	})

	it('falls back to the catalog fetch time for a catalog saved before the stamp', () => {
		const status = tillRulesStatus(
			snapshot({ discountRules: [rule()] }, 10_000),
			10_000 + 1000,
		)
		expect(status.state).toBe('fresh')
	})

	it('has nothing to expire without rules', () => {
		expect(
			tillRulesStatus(snapshot({}, 0), 99 * TILL_RULES_MAX_AGE_MS).state,
		).toBe('none')
		expect(tillRulesStatus(null).state).toBe('none')
	})

	it('says why they stopped: age', () => {
		const at = 1_000_000
		expect(
			tillRulesStatus(
				snapshot({ discountRules: [rule()], discountRulesAt: at }, at),
				at + TILL_RULES_MAX_AGE_MS + 1,
			),
		).toEqual({ state: 'expired', fetchedAt: at, cause: 'age' })
	})
})

describe('till discount rules and a clock moved back', () => {
	const snapshot = (rulesAt: number) =>
		({
			key: 'catalog',
			fetchedAt: rulesAt,
			menu: { discountRules: [rule()], discountRulesAt: rulesAt },
		}) as unknown as CatalogSnapshot
	const at = 2_000_000_000_000
	const minutes = (count: number) => count * 60_000

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
		reloadTillClock()
	})

	it('are off when stamped in the future, beyond normal drift', () => {
		expect(tillRulesStatus(snapshot(at), at - TILL_CLOCK_SKEW_MS).state).toBe(
			'fresh',
		)
		expect(tillRulesStatus(snapshot(at), at - TILL_CLOCK_SKEW_MS - 1)).toEqual({
			state: 'expired',
			fetchedAt: at,
			cause: 'clock',
		})
	})

	it('are off while the clock is behind the latest time seen with them', () => {
		const seen = at + minutes(60)
		expect(tillRulesStatus(snapshot(at), seen - minutes(4), seen).state).toBe(
			'fresh',
		)
		expect(
			tillRulesStatus(snapshot(at), seen - minutes(6), seen),
		).toMatchObject({
			state: 'expired',
			cause: 'clock',
		})
	})

	it('cannot be made younger by setting the clock back', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(at + minutes(60))
		expect(tillRulesStatus(snapshot(at)).state).toBe('fresh')
		// Back 20 hours: without the latest time seen, they would have 20 more hours.
		vi.setSystemTime(at + minutes(60) - minutes(20 * 60))
		expect(tillRulesStatus(snapshot(at))).toMatchObject({
			state: 'expired',
			cause: 'clock',
		})
		// Forward again: the age is the clock's own, and the limit still holds.
		vi.setSystemTime(at + minutes(90))
		expect(tillRulesStatus(snapshot(at)).state).toBe('fresh')
		vi.setSystemTime(at + TILL_RULES_MAX_AGE_MS + 1)
		expect(tillRulesStatus(snapshot(at))).toMatchObject({
			state: 'expired',
			cause: 'age',
		})
	})

	it('start again with rules fetched later, so a clock fixed once does not keep them off', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		// The clock ran a week ahead when the rules came, then was put right.
		const ahead = at + minutes(7 * 24 * 60)
		vi.setSystemTime(ahead)
		expect(tillRulesStatus(snapshot(ahead)).state).toBe('fresh')
		vi.setSystemTime(at + minutes(10))
		expect(tillRulesStatus(snapshot(ahead))).toMatchObject({
			state: 'expired',
			cause: 'clock',
		})
		// The next fetch stamps the rules with the right time: they apply, although
		// the latest time seen before was a week ahead.
		expect(tillRulesStatus(snapshot(at + minutes(10))).state).toBe('fresh')
	})

	it('remember the latest time across a reload', () => {
		const memory = new Map<string, string>()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => memory.get(key) ?? null,
			setItem: (key: string, value: string) => void memory.set(key, value),
		})
		reloadTillClock()
		expect(noteTillClock(at, at + minutes(1))).toBe(at + minutes(1))
		expect(noteTillClock(at, at + minutes(120))).toBe(at + minutes(120))
		expect(JSON.parse(memory.get(TILL_CLOCK_KEY)!)).toEqual({
			stamp: at,
			seen: at + minutes(120),
		})
		// A reload with the clock set back still knows how far it had gone.
		reloadTillClock()
		expect(noteTillClock(at, at + minutes(5))).toBe(at + minutes(120))
	})

	it('ignore a stored record that is not what the till wrote', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => '{"stamp":"x"}',
			setItem: () => undefined,
		})
		reloadTillClock()
		expect(noteTillClock(at, at + minutes(1))).toBe(at + minutes(1))
	})
})

describe('categories', () => {
	it('match by the category an item is directly in, like the server', () => {
		const veg = {
			id: 'veg',
			items: [{ id: 'margherita' }],
			subcategories: [],
		} as unknown as MenuCategory
		const pizza = {
			id: 'pizza',
			items: [{ id: 'plain-pizza' }],
			subcategories: [veg],
		} as unknown as MenuCategory
		const map = categoryIdsByItem([pizza])
		expect(map.get('margherita')).toEqual(['veg'])
		expect(map.get('plain-pizza')).toEqual(['pizza'])
	})

	it('a Pizza category discount does not reach an item in Pizza > Veg', () => {
		const veg = {
			id: 'veg',
			items: [{ id: 'i1' }],
			subcategories: [],
		} as unknown as MenuCategory
		const pizza = {
			id: 'pizza',
			items: [],
			subcategories: [veg],
		} as unknown as MenuCategory
		const rows = automaticTillAdjustments({
			...common,
			categories: [pizza],
			lines: [line()],
			rules: [
				rule({
					target: { ...target, scope: 'categories', categoryIds: ['pizza'] },
				}),
			],
		})
		expect(rows).toEqual([])
	})
})

describe('limited discounts', () => {
	it('never apply by themselves: the till cannot count uses offline', () => {
		for (const limit of [
			{ totalLimit: 10 },
			{ perCustomerLimit: { count: 1, period: 'lifetime' } },
		]) {
			expect(
				automaticTillAdjustments({
					...common,
					lines: [line()],
					rules: [rule(limit)],
				}),
			).toEqual([])
		}
	})
})

describe('tabs keep the discounts a round had when it was sent', () => {
	const happyHour = rule({ endsAt: '2026-06-01T12:00' })

	it('an expired happy hour does not reprice an earlier round', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({ id: 'early', sentAt: Date.parse('2026-06-01T11:00:00Z') }),
				line({ id: 'late' }),
			],
			rules: [happyHour],
			now: new Date('2026-06-01T13:00:00Z'),
		})
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			amountCents: 1000,
			lineAmounts: { early: 1000 },
		})
	})

	it('a round sent inside the window keeps its discount when the tab is reopened later', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({ id: 'early', sentAt: Date.parse('2026-06-01T11:30:00Z') }),
			],
			rules: [happyHour],
			now: new Date('2026-06-02T09:00:00Z'),
		})
		expect(rows[0]?.amountCents).toBe(1000)
	})

	it('a new round inside the window is discounted with the old', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({ id: 'a', sentAt: Date.parse('2026-06-01T10:00:00Z') }),
				line({ id: 'b' }),
			],
			rules: [happyHour],
			now: new Date('2026-06-01T11:00:00Z'),
		})
		expect(rows[0]?.lineAmounts).toEqual({ a: 1000, b: 1000 })
	})

	it('scales a sent line discount when quantity is voided down', () => {
		const kept: Adjustment[] = [
			{
				id: 'auto:d1',
				kind: 'discount',
				label: 'Happy hour',
				amountCents: 4000,
				lineAmounts: { l1: 4000 },
				version: 1,
			},
		]
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({
					id: 'l1',
					quantity: 1,
					sentAt: 1_000,
					sentQuantity: 2,
					baseCents: 10_000,
				}),
			],
			rules: [rule({ percentBp: 2000 })],
			kept,
		})
		expect(rows[0]?.lineAmounts?.l1).toBe(2000)
		expect(rows[0]?.amountCents).toBe(2000)
	})
})

describe('a later round does not stack discounts that do not combine', () => {
	const everything = rule({ id: 'x', name: 'Ten off', combinable: false })
	const mains = rule({
		id: 'y',
		name: 'Mains half price',
		percentBp: 5000,
		combinable: false,
		startsAt: '2026-06-01T15:00',
	})

	it('never takes a line below what the best single discount gives', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({
					id: 'a',
					baseCents: 1000,
					sentAt: Date.parse('2026-06-01T14:55:00Z'),
				}),
				line({ id: 'b', baseCents: 1000 }),
			],
			rules: [everything, mains],
			now: new Date('2026-06-01T15:05:00Z'),
		})
		const taken = (lineId: string) =>
			rows.reduce((sum, row) => sum + (row.lineAmounts?.[lineId] ?? 0), 0)
		expect(taken('a')).toBe(100)
		expect(taken('b')).toBe(500)
	})

	it('still stacks when both discounts combine', () => {
		const rows = automaticTillAdjustments({
			...common,
			lines: [
				line({
					id: 'a',
					baseCents: 1000,
					sentAt: Date.parse('2026-06-01T14:55:00Z'),
				}),
				line({ id: 'b', baseCents: 1000 }),
			],
			rules: [
				{ ...everything, combinable: true },
				{ ...mains, combinable: true },
			],
			now: new Date('2026-06-01T15:05:00Z'),
		})
		const taken = (lineId: string) =>
			rows.reduce((sum, row) => sum + (row.lineAmounts?.[lineId] ?? 0), 0)
		expect(taken('a')).toBe(550)
	})
})

describe('a sent round keeps its automatic discounts when the rules change', () => {
	const sentAt = Date.parse('2026-06-01T11:00:00Z')
	const now = new Date('2026-06-01T13:00:00Z')
	const sent = line({ id: 'a', sentAt })
	const fresh = line({ id: 'b' })
	const kept: Adjustment[] = [
		{
			id: 'auto:d1',
			kind: 'discount',
			label: 'Happy hour',
			amountCents: 1000,
			lineAmounts: { a: 1000 },
			version: 1,
		},
	]
	const run = (rules: unknown, lines: CartLine[], extra = {}) =>
		automaticTillAdjustments({ ...common, lines, rules, now, kept, ...extra })

	it('keeps the discount when the rule was deleted', () => {
		const rows = run([rule({ id: 'other' })], [sent])
		expect(rows).toEqual(kept)
	})

	it('keeps the discount when the list of rules is empty', () => {
		expect(run([], [sent])).toEqual(kept)
		expect(run(undefined, [sent])).toEqual(kept)
		// A new round on the tab is not discounted by a rule that is gone.
		expect(run([], [sent, fresh])).toEqual(kept)
	})

	it('a paused rule leaves the old round alone and gives the new round nothing', () => {
		const rows = run([rule({ status: 'paused' })], [sent, fresh])
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			id: 'auto:d1',
			amountCents: 1000,
			lineAmounts: { a: 1000 },
		})
	})

	it('an unsent cart with no rules has no discount, whatever it was before', () => {
		const stale: Adjustment[] = [{ ...kept[0]!, lineAmounts: { b: 1000 } }]
		expect(run([], [fresh], { kept: stale })).toEqual([])
		expect(run([rule()], [fresh], { kept: stale })[0]?.lineAmounts).toEqual({
			b: 1000,
		})
	})

	it('keeps the amount when the rule is edited to a smaller percent', () => {
		const rows = run([rule({ percentBp: 500, version: 2 })], [sent, fresh])
		expect(rows).toHaveLength(1)
		expect(rows[0]?.lineAmounts).toEqual({ a: 1000, b: 500 })
		expect(rows[0]?.amountCents).toBe(1500)
		expect(rows[0]?.version).toBe(2)
	})

	it('keeps the old version when the rule changed but nothing grew', () => {
		const rows = run([rule({ percentBp: 500, version: 2 })], [sent])
		expect(rows[0]).toMatchObject({ amountCents: 1000, version: 1 })
	})

	it('grows the amount when the rule is edited to a larger percent', () => {
		const rows = run([rule({ percentBp: 2000, version: 2 })], [sent])
		expect(rows[0]).toMatchObject({
			amountCents: 2000,
			lineAmounts: { a: 2000 },
			version: 2,
		})
	})

	it('adds a new discount that stacks with the one the round carries', () => {
		const rows = run(
			[rule(), rule({ id: 'n', name: 'New', percentBp: 500 })],
			[sent],
		)
		expect(rows.map((row) => [row.id, row.amountCents])).toEqual([
			['auto:d1', 1000],
			['auto:n', 450],
		])
	})

	it('never adds a discount that does not combine to a line that carries one', () => {
		const rows = run(
			[
				rule({ id: 'd1', combinable: false }),
				rule({ id: 'n', name: 'Other', percentBp: 5000, combinable: false }),
			],
			[sent],
		)
		expect(rows.map((row) => row.id)).toEqual(['auto:d1'])
		expect(rows[0]?.amountCents).toBe(1000)
	})

	it('adds nothing to a line that carries a discount the rules no longer know', () => {
		const rows = run(
			[rule({ id: 'n', name: 'Other', percentBp: 5000 })],
			[sent],
		)
		expect(rows.map((row) => row.id)).toEqual(['auto:d1'])
	})

	it('never takes more than the line costs', () => {
		const rows = run([], [{ ...sent, baseCents: 400 }])
		expect(rows[0]?.amountCents).toBe(400)
	})

	it('drops what a line that left the order had', () => {
		expect(run([], [fresh])).toEqual([])
	})

	it('does not keep a discount a manual one replaced', () => {
		const rows = run([rule()], [sent], { excludeIds: new Set(['d1']) })
		expect(rows).toEqual([])
	})

	it('rules too old to apply still leave a sent round its discount', () => {
		const settled = settleTillDiscounts({
			...common,
			lines: [sent, fresh],
			rules: [rule()],
			rulesUsable: false,
			manual: null,
			now,
			kept,
		})
		expect(settled.automatic).toEqual(kept)
	})

	it('says which kept discounts the rules no longer offer', () => {
		const lines = [sent]
		const ask = (rules: unknown) =>
			keptButNotOffered({ rules, lines, adjustments: kept })
		expect(ask([])).toEqual({ ids: ['d1'], names: ['Happy hour'] })
		expect(ask([rule({ status: 'paused' })]).ids).toEqual(['d1'])
		expect(ask([rule()]).ids).toEqual([])
		// A happy hour that is merely not running now is still offered.
		expect(ask([rule({ endsAt: '2026-06-01T12:00' })]).ids).toEqual([])
		// A line that is not sent keeps nothing.
		expect(
			keptButNotOffered({ rules: [], lines: [fresh], adjustments: kept }).ids,
		).toEqual([])
	})
})

describe('one manual discount, on the running total', () => {
	const manualRule = (over: Record<string, unknown> = {}) =>
		rule({ id: 'm1', name: 'Staff discount', application: 'manual', ...over })
	const settle = (
		rules: unknown[],
		manual: Parameters<typeof settleTillDiscounts>[0]['manual'],
		lines: CartLine[] = [line()],
	) =>
		settleTillDiscounts({
			...common,
			lines,
			rules,
			rulesUsable: true,
			manual,
		})

	it('quotes a manual discount on what automatic discounts left', () => {
		const settled = settle(
			[rule({ percentBp: 4000 }), manualRule({ percentBp: 10_000 })],
			{ discountId: 'm1' },
		)
		expect(settled.automatic[0]?.amountCents).toBe(4000)
		expect(settled.manual).toMatchObject({
			ok: true,
			adjustment: { amountCents: 6000, lineAmounts: { l1: 6000 } },
		})
	})

	it('allocates by line, so a second line is untouched by a discount on the first', () => {
		const settled = settle(
			[
				rule({
					percentBp: 10_000,
					target: { ...target, scope: 'items', itemIds: ['i1'] },
				}),
				manualRule({ percentBp: 5000 }),
			],
			{ discountId: 'm1' },
			[
				line({ id: 'l1', itemId: 'i1', baseCents: 1000 }),
				line({ id: 'l2', itemId: 'i2', baseCents: 1000 }),
			],
		)
		expect(settled.automatic[0]?.lineAmounts).toEqual({ l1: 1000 })
		// Half of what is left: nothing of l1, half of l2.
		expect(settled.manual).toMatchObject({
			ok: true,
			adjustment: { amountCents: 500, lineAmounts: { l2: 500 } },
		})
	})

	it('a manual discount that does not combine replaces the automatic ones and says so', () => {
		const settled = settle(
			[rule(), manualRule({ percentBp: 2000, combinable: false })],
			{ discountId: 'm1' },
		)
		expect(settled.automatic).toEqual([])
		expect(settled.replaced).toEqual(['Happy hour'])
		expect(settled.manual).toMatchObject({
			ok: true,
			adjustment: { amountCents: 2000 },
		})
	})

	it('stacks with automatic discounts that allow it', () => {
		const settled = settle([rule(), manualRule({ percentBp: 2000 })], {
			discountId: 'm1',
		})
		expect(settled.automatic).toHaveLength(1)
		expect(settled.replaced).toEqual([])
	})

	it('an automatic discount that refuses to combine is replaced too', () => {
		const settled = settle(
			[rule({ combinable: false }), manualRule({ percentBp: 2000 })],
			{ discountId: 'm1' },
		)
		expect(settled.automatic).toEqual([])
		expect(settled.replaced).toEqual(['Happy hour'])
	})

	it('refuses everything while the rules are too old', () => {
		const settled = settleTillDiscounts({
			...common,
			lines: [line()],
			rules: [rule(), manualRule()],
			rulesUsable: false,
			manual: { discountId: 'm1' },
		})
		expect(settled.automatic).toEqual([])
		expect(settled.manual).toEqual({ ok: false, reason: 'rules_stale' })
	})

	it('never takes more than the bill, however the discounts add up', () => {
		const settled = settle(
			[rule({ percentBp: 7000 }), manualRule({ percentBp: 10_000 })],
			{ discountId: 'm1' },
			[line({ quantity: 3, baseCents: 333 })],
		)
		const total =
			(settled.automatic[0]?.amountCents ?? 0) +
			(settled.manual?.ok ? settled.manual.adjustment.amountCents : 0)
		expect(total).toBe(999)
	})
})

describe('manual discount errors say what is wrong', () => {
	const variablePercent = parseTillRules([
		rule({
			application: 'manual',
			valueType: 'variable_percent',
			percentBp: null,
		}),
	])[0]!
	const variableAmount = parseTillRules([
		rule({
			application: 'manual',
			valueType: 'variable_amount',
			percentBp: null,
			currency: 'USD',
			maxDiscountMinor: 3000,
		}),
	])[0]!
	const quote = (
		discount: typeof variablePercent,
		value: { percentBp?: number; amountMinor?: number },
	) =>
		quoteTillManualDiscount({
			...common,
			discount,
			lines: [line({ baseCents: 2000 })],
			...value,
		})

	it('a percentage over 100', () => {
		expect(quote(variablePercent, { percentBp: 15_000 })).toEqual({
			ok: false,
			reason: 'over_100',
		})
	})

	it('a missing or zero value', () => {
		expect(quote(variablePercent, {})).toMatchObject({
			reason: 'value_required',
		})
		expect(quote(variableAmount, { amountMinor: 0 })).toMatchObject({
			reason: 'value_required',
		})
	})

	it('an amount over the discount maximum', () => {
		expect(quote(variableAmount, { amountMinor: 3500 })).toEqual({
			ok: false,
			reason: 'over_max',
			maxMinor: 3000,
		})
	})

	it('an amount larger than the bill, instead of a silent cap', () => {
		const uncapped = parseTillRules([
			rule({
				application: 'manual',
				valueType: 'variable_amount',
				percentBp: null,
				currency: 'USD',
			}),
		])[0]!
		expect(quote(uncapped, { amountMinor: 5000 })).toEqual({
			ok: false,
			reason: 'over_bill',
			maxMinor: 2000,
		})
		expect(quote(uncapped, { amountMinor: 2000 })).toMatchObject({
			ok: true,
			amountMinor: 2000,
		})
	})
})
