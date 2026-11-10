import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type InventoryCategory, type UnitSystem } from '@repo/inventory'
import {
	baseUnitFor,
	defaultMeasureUnit,
	type MeasuredIn,
} from './item-form.ts'

/**
 * Starter lists: common items by restaurant type, so a new kitchen does not
 * start from a blank page. Names are Lingui messages and are saved as plain
 * text in the language the operator is using when they add them (an item has
 * one name, never a translation map).
 */

export const RESTAURANT_TYPES = [
	'shawarma_grill',
	'burger',
	'pizza',
	'cafe',
	'bakery',
	'casual_dining',
] as const
export type RestaurantType = (typeof RESTAURANT_TYPES)[number]

export const RESTAURANT_TYPE_LABELS: Record<RestaurantType, MessageDescriptor> =
	{
		shawarma_grill: msg`Shawarma and grill`,
		burger: msg`Burger`,
		pizza: msg`Pizza`,
		cafe: msg`Cafe`,
		bakery: msg`Bakery or pastry shop`,
		casual_dining: msg`Casual dining`,
	}

type StarterArea = 'fridge' | 'freezer' | 'dry' | 'bar'

const AREA_LABELS: Record<StarterArea, MessageDescriptor> = {
	fridge: msg`Walk-in fridge`,
	freezer: msg`Freezer`,
	dry: msg`Dry store`,
	bar: msg`Bar`,
}

export type StarterItem = {
	key: string
	name: MessageDescriptor
	category: InventoryCategory
	measure: MeasuredIn
	area: StarterArea
}

const ITEMS = {
	chicken: {
		name: msg`Chicken`,
		category: 'meat',
		measure: 'weight',
		area: 'fridge',
	},
	beef: {
		name: msg`Beef`,
		category: 'meat',
		measure: 'weight',
		area: 'fridge',
	},
	lamb: {
		name: msg`Lamb`,
		category: 'meat',
		measure: 'weight',
		area: 'fridge',
	},
	patties: {
		name: msg`Beef patties`,
		category: 'meat',
		measure: 'count',
		area: 'freezer',
	},
	pepperoni: {
		name: msg`Pepperoni`,
		category: 'meat',
		measure: 'weight',
		area: 'fridge',
	},
	fish: {
		name: msg`Fish fillets`,
		category: 'seafood',
		measure: 'weight',
		area: 'freezer',
	},
	tomatoes: {
		name: msg`Tomatoes`,
		category: 'produce',
		measure: 'weight',
		area: 'fridge',
	},
	onions: {
		name: msg`Onions`,
		category: 'produce',
		measure: 'weight',
		area: 'dry',
	},
	lettuce: {
		name: msg`Lettuce`,
		category: 'produce',
		measure: 'count',
		area: 'fridge',
	},
	cucumbers: {
		name: msg`Cucumbers`,
		category: 'produce',
		measure: 'weight',
		area: 'fridge',
	},
	potatoes: {
		name: msg`Potatoes`,
		category: 'produce',
		measure: 'weight',
		area: 'dry',
	},
	pickles: {
		name: msg`Pickles`,
		category: 'produce',
		measure: 'weight',
		area: 'dry',
	},
	fries: {
		name: msg`Frozen fries`,
		category: 'other',
		measure: 'weight',
		area: 'freezer',
	},
	garlicSauce: {
		name: msg`Garlic sauce`,
		category: 'sauces',
		measure: 'volume',
		area: 'fridge',
	},
	tahini: {
		name: msg`Tahini`,
		category: 'sauces',
		measure: 'volume',
		area: 'dry',
	},
	ketchup: {
		name: msg`Ketchup`,
		category: 'sauces',
		measure: 'volume',
		area: 'dry',
	},
	mayo: {
		name: msg`Mayonnaise`,
		category: 'sauces',
		measure: 'volume',
		area: 'dry',
	},
	tomatoSauce: {
		name: msg`Tomato sauce`,
		category: 'sauces',
		measure: 'volume',
		area: 'dry',
	},
	pita: {
		name: msg`Pita bread`,
		category: 'bakery',
		measure: 'count',
		area: 'dry',
	},
	buns: {
		name: msg`Burger buns`,
		category: 'bakery',
		measure: 'count',
		area: 'dry',
	},
	dough: {
		name: msg`Pizza dough`,
		category: 'bakery',
		measure: 'count',
		area: 'fridge',
	},
	yeast: {
		name: msg`Yeast`,
		category: 'bakery',
		measure: 'weight',
		area: 'dry',
	},
	cheeseSlices: {
		name: msg`Cheese slices`,
		category: 'dairy',
		measure: 'count',
		area: 'fridge',
	},
	mozzarella: {
		name: msg`Mozzarella`,
		category: 'dairy',
		measure: 'weight',
		area: 'fridge',
	},
	milk: {
		name: msg`Milk`,
		category: 'dairy',
		measure: 'volume',
		area: 'fridge',
	},
	cream: {
		name: msg`Cream`,
		category: 'dairy',
		measure: 'volume',
		area: 'fridge',
	},
	butter: {
		name: msg`Butter`,
		category: 'dairy',
		measure: 'weight',
		area: 'fridge',
	},
	eggs: {
		name: msg`Eggs`,
		category: 'dairy',
		measure: 'count',
		area: 'fridge',
	},
	flour: {
		name: msg`Flour`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	sugar: {
		name: msg`Sugar`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	rice: {
		name: msg`Rice`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	pasta: {
		name: msg`Pasta`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	salt: {
		name: msg`Salt`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	chocolate: {
		name: msg`Chocolate`,
		category: 'dry_goods',
		measure: 'weight',
		area: 'dry',
	},
	oliveOil: {
		name: msg`Olive oil`,
		category: 'dry_goods',
		measure: 'volume',
		area: 'dry',
	},
	fryingOil: {
		name: msg`Frying oil`,
		category: 'dry_goods',
		measure: 'volume',
		area: 'dry',
	},
	coffee: {
		name: msg`Coffee beans`,
		category: 'drinks',
		measure: 'weight',
		area: 'dry',
	},
	tea: { name: msg`Tea`, category: 'drinks', measure: 'weight', area: 'dry' },
	syrup: {
		name: msg`Flavored syrup`,
		category: 'drinks',
		measure: 'volume',
		area: 'bar',
	},
	juice: {
		name: msg`Orange juice`,
		category: 'drinks',
		measure: 'volume',
		area: 'fridge',
	},
	cola: {
		name: msg`Cola cans`,
		category: 'drinks',
		measure: 'count',
		area: 'fridge',
	},
	water: {
		name: msg`Water bottles`,
		category: 'drinks',
		measure: 'count',
		area: 'fridge',
	},
	cups: {
		name: msg`Paper cups`,
		category: 'packaging',
		measure: 'count',
		area: 'dry',
	},
	boxes: {
		name: msg`Takeaway boxes`,
		category: 'packaging',
		measure: 'count',
		area: 'dry',
	},
	napkins: {
		name: msg`Napkins`,
		category: 'packaging',
		measure: 'count',
		area: 'dry',
	},
	soap: {
		name: msg`Dish soap`,
		category: 'cleaning',
		measure: 'volume',
		area: 'dry',
	},
} satisfies Record<string, Omit<StarterItem, 'key'>>

type StarterKey = keyof typeof ITEMS

const LISTS: Record<RestaurantType, readonly StarterKey[]> = {
	shawarma_grill: [
		'chicken',
		'beef',
		'lamb',
		'garlicSauce',
		'tahini',
		'pickles',
		'tomatoes',
		'onions',
		'cucumbers',
		'pita',
		'rice',
		'fryingOil',
		'fries',
		'boxes',
		'cola',
		'water',
	],
	burger: [
		'patties',
		'buns',
		'cheeseSlices',
		'lettuce',
		'tomatoes',
		'onions',
		'pickles',
		'ketchup',
		'mayo',
		'fries',
		'fryingOil',
		'cola',
		'boxes',
		'napkins',
	],
	pizza: [
		'dough',
		'flour',
		'yeast',
		'tomatoSauce',
		'mozzarella',
		'pepperoni',
		'onions',
		'oliveOil',
		'salt',
		'boxes',
		'cola',
		'water',
	],
	cafe: [
		'coffee',
		'milk',
		'tea',
		'syrup',
		'sugar',
		'cups',
		'napkins',
		'juice',
		'water',
		'cream',
		'chocolate',
	],
	bakery: [
		'flour',
		'sugar',
		'yeast',
		'butter',
		'eggs',
		'milk',
		'salt',
		'chocolate',
		'cream',
		'boxes',
	],
	casual_dining: [
		'chicken',
		'beef',
		'fish',
		'potatoes',
		'tomatoes',
		'onions',
		'lettuce',
		'oliveOil',
		'salt',
		'rice',
		'pasta',
		'cream',
		'milk',
		'cola',
		'water',
		'napkins',
		'soap',
	],
}

export function starterItemsFor(type: RestaurantType): StarterItem[] {
	return LISTS[type].map((key) => ({ key, ...ITEMS[key] }))
}

/** One entry of `POST /items/bulk` (a bought item with its count unit and area). */
export type BulkItemInput = {
	name: string
	category: string
	kind: 'bought' | 'made'
	baseUnit: 'g' | 'ml' | 'piece'
	countUnit?: string
	areaName?: string
	costMicro?: number
	currency?: string
}

/** The chosen starter items as bulk entries, named in the viewer's language. */
export function starterBulkItems(
	items: readonly StarterItem[],
	{ i18n, system }: { i18n: Pick<I18n, '_'>; system: UnitSystem },
): BulkItemInput[] {
	return items.map((item) => ({
		name: i18n._(item.name),
		category: item.category,
		kind: 'bought',
		baseUnit: baseUnitFor(item.measure),
		countUnit: defaultMeasureUnit(item.measure, system),
		areaName: i18n._(AREA_LABELS[item.area]),
	}))
}
