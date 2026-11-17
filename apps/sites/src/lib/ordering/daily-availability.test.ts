import { describe, expect, it } from 'vitest'
import {
	applyDailyAvailability,
	cartNameOf,
	dailyCartIssues,
	dailyView,
	readDailyAvailability,
} from './daily-availability.ts'
import { type CartItem, type OrderingCategory } from './types.ts'

const catalog = (): OrderingCategory[] => [
	{
		id: 'c1',
		displayName: 'Mains',
		items: [
			{
				id: 'special',
				displayName: 'Lamb special',
				price: 10,
				variations: { groups: [], variants: [] },
				modifierGroups: [
					{
						id: 'g1',
						name: 'Side',
						selectionType: 'single',
						minSelections: 0,
						maxSelections: 1,
						options: [
							{ id: 'dessert', displayName: 'Dessert', price: 2 },
							{ id: 'plain', displayName: 'Plain', price: 0 },
						],
					},
				],
			},
			{
				id: 'soup',
				displayName: 'Soup',
				price: 4,
				availabilityStatus: 'unavailable',
				variations: { groups: [], variants: [] },
				modifierGroups: [],
			},
		],
		subcategories: [
			{
				id: 'c2',
				displayName: 'Sub',
				items: [],
			},
		],
	},
]

describe('readDailyAvailability', () => {
	it('reads what the region sent and drops anything malformed', () => {
		expect(
			readDailyAvailability({
				dailyAvailability: {
					'item:a': { remaining: 0, showRemaining: false },
					'item:b': { remaining: 3, showRemaining: true },
					'item:c': { remaining: -1, showRemaining: true },
					'item:d': { remaining: 2.5, showRemaining: true },
					'item:e': 'x',
					'item:f': null,
					'item:g': { remaining: 4 },
				},
			}),
		).toEqual({
			'item:a': { remaining: 0, showRemaining: false },
			'item:b': { remaining: 3, showRemaining: true },
			'item:g': { remaining: 4, showRemaining: false },
		})
	})

	it('is empty for an older node, a missing field and junk', () => {
		for (const value of [
			null,
			undefined,
			{},
			{ dailyAvailability: null },
			{ dailyAvailability: [] },
			'x',
		]) {
			expect(readDailyAvailability(value)).toEqual({})
		}
	})
})

describe('dailyView', () => {
	const availability = readDailyAvailability({
		dailyAvailability: {
			'item:out': { remaining: 0, showRemaining: false },
			'item:low': { remaining: 3, showRemaining: true },
			'option:out': { remaining: 0, showRemaining: false },
		},
	})

	it('says sold out, or how many are left where the restaurant shows it', () => {
		expect(dailyView(availability, 'item', 'out')).toEqual({
			soldOut: true,
			left: null,
		})
		expect(dailyView(availability, 'item', 'low')).toEqual({
			soldOut: false,
			left: 3,
		})
		expect(dailyView(availability, 'option', 'out')).toEqual({
			soldOut: true,
			left: null,
		})
	})

	it('knows nothing about a dish the region did not list, and keeps item and option ids apart', () => {
		expect(dailyView(availability, 'item', 'other')).toBeNull()
		expect(dailyView(availability, 'option', 'low')).toBeNull()
	})
})

describe('applyDailyAvailability', () => {
	it('marks a sold-out dish and option unavailable and carries a shown number', () => {
		const categories = catalog()
		applyDailyAvailability(
			categories,
			readDailyAvailability({
				dailyAvailability: {
					'item:special': { remaining: 3, showRemaining: true },
					'option:dessert': { remaining: 0, showRemaining: false },
				},
			}),
		)
		const special = categories[0]!.items[0]!
		expect(special.availabilityStatus).toBe('available')
		expect(special.dailyRemaining).toBe(3)
		const [dessert, plain] = special.modifierGroups[0]!.options
		expect(dessert!.availabilityStatus).toBe('unavailable')
		expect(plain!.availabilityStatus).toBe('available')
	})

	it('gives a dish back when a manager tops it up (what the menu published is kept)', () => {
		const categories = catalog()
		applyDailyAvailability(
			categories,
			readDailyAvailability({
				dailyAvailability: {
					'item:special': { remaining: 0, showRemaining: false },
				},
			}),
		)
		expect(categories[0]!.items[0]!.availabilityStatus).toBe('unavailable')
		applyDailyAvailability(categories, {})
		expect(categories[0]!.items[0]!.availabilityStatus).toBe('available')
		expect(categories[0]!.items[0]!.dailyRemaining).toBeNull()
	})

	it('never turns a dish the menu itself hides back on', () => {
		const categories = catalog()
		applyDailyAvailability(categories, {})
		expect(categories[0]!.items[1]!.availabilityStatus).toBe('unavailable')
		applyDailyAvailability(
			categories,
			readDailyAvailability({
				dailyAvailability: {
					'item:soup': { remaining: 5, showRemaining: true },
				},
			}),
		)
		expect(categories[0]!.items[1]!.availabilityStatus).toBe('unavailable')
	})
})

describe('dailyCartIssues', () => {
	const line = (over: Partial<CartItem> = {}): CartItem => ({
		id: 'l1',
		itemId: 'special',
		quantity: 1,
		name: 'Lamb special',
		basePrice: 10,
		unitPrice: 12,
		options: [],
		instructions: '',
		...over,
	})
	const availability = readDailyAvailability({
		dailyAvailability: {
			'item:special': { remaining: 2, showRemaining: true },
			'option:dessert': { remaining: 0, showRemaining: false },
		},
	})

	it('flags a line whose chosen option sold out', () => {
		const issues = dailyCartIssues(
			[
				line({
					options: [
						{
							groupId: 'g1',
							groupName: 'Side',
							optionId: 'dessert',
							optionName: 'Dessert',
							priceDelta: 2,
						},
					],
				}),
			],
			availability,
		)
		expect(issues).toEqual([
			{ key: 'option:dessert', kind: 'option', id: 'dessert', remaining: null },
		])
	})

	it('flags more units than the number shown as left, naming that number', () => {
		expect(dailyCartIssues([line({ quantity: 3 })], availability)).toEqual([
			{ key: 'item:special', kind: 'item', id: 'special', remaining: 2 },
		])
		expect(dailyCartIssues([line({ quantity: 2 })], availability)).toEqual([])
	})

	it('adds up the same dish across lines, as the region does', () => {
		expect(
			dailyCartIssues(
				[line({ id: 'a', quantity: 2 }), line({ id: 'b', quantity: 1 })],
				availability,
			),
		).toHaveLength(1)
	})

	it('leaves a dish with no entry to the region and ignores size echoes', () => {
		expect(dailyCartIssues([line({ itemId: 'other' })], availability)).toEqual(
			[],
		)
		expect(
			dailyCartIssues(
				[
					line({
						options: [
							{
								groupId: 'v',
								groupName: 'Size',
								optionId: 'dessert',
								optionName: 'Large',
								priceDelta: 0,
								variation: true,
							},
						],
					}),
				],
				availability,
			),
		).toEqual([])
		expect(dailyCartIssues([line()], {})).toEqual([])
	})

	it('names a dish or option from the cart itself', () => {
		const cart = [
			line({
				options: [
					{
						groupId: 'g1',
						groupName: 'Side',
						optionId: 'dessert',
						optionName: 'Dessert',
						priceDelta: 2,
					},
				],
			}),
		]
		expect(cartNameOf(cart, { kind: 'item', id: 'special' })).toBe(
			'Lamb special',
		)
		expect(cartNameOf(cart, { kind: 'option', id: 'dessert' })).toBe('Dessert')
		expect(cartNameOf(cart, { kind: 'item', id: 'zzz' })).toBeNull()
	})
})
