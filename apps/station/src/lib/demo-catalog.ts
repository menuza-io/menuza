import {
	type CatalogSnapshot,
	type MenuCategory,
	type MenuItem,
	type ModifierGroup,
} from './types.ts'

/**
 * Sample data so the till can be explored with no backend (`VITE_POS_DEMO=1`).
 * Real data always comes from the App; nothing here ships to production flows.
 */
let position = 0
const item = (
	id: string,
	displayName: string,
	price: number,
	extra: Partial<MenuItem> = {},
): MenuItem => ({
	id,
	displayName,
	description: null,
	price,
	imageUrl: null,
	variations: { groups: [], variants: [] },
	isVegetarian: false,
	isGlutenFree: false,
	isAlcohol: false,
	allergens: [],
	isPopular: false,
	availabilityStatus: 'available',
	position: position++,
	modifierGroups: [],
	...extra,
})

const opt = (
	id: string,
	displayName: string,
	price = 0,
	isDefault = false,
) => ({
	id,
	displayName,
	price,
	minSelections: 0,
	maxSelections: null,
	isDefault,
	applySalesTax: true,
	availabilityStatus: 'available',
	position: position++,
})

const extras: ModifierGroup = {
	id: 'g-extras',
	name: 'Add extras',
	selectionType: 'multiple',
	minSelections: 0,
	maxSelections: 4,
	availabilityStatus: 'available',
	position: 1,
	options: [
		opt('o-cheese', 'Extra cheese', 1.5),
		opt('o-bacon', 'Bacon', 2),
		opt('o-egg', 'Fried egg', 1.75),
		opt('o-avo', 'Avocado', 2.25),
	],
}
const doneness: ModifierGroup = {
	id: 'g-temp',
	name: 'How would you like it cooked?',
	selectionType: 'single',
	minSelections: 1,
	maxSelections: 1,
	availabilityStatus: 'available',
	position: 0,
	options: [
		opt('o-med', 'Medium', 0, true),
		opt('o-well', 'Well done'),
		opt('o-rare', 'Medium rare'),
	],
}
const sauce: ModifierGroup = {
	id: 'g-sauce',
	name: 'Sauce',
	selectionType: 'single',
	minSelections: 1,
	maxSelections: 1,
	availabilityStatus: 'available',
	position: 0,
	options: [
		opt('o-marinara', 'Marinara'),
		opt('o-alfredo', 'Alfredo', 1),
		opt('o-pesto', 'Pesto', 1.5),
	],
}
const sizes = (small: number, large: number) => ({
	groups: [
		{
			id: 'size',
			name: 'Size',
			values: [
				{ id: 'sm', name: 'Regular' },
				{ id: 'lg', name: 'Large' },
			],
		},
	],
	variants: [
		{
			id: 'v-sm',
			valueIds: ['sm'],
			price: small,
			availabilityStatus: 'available',
		},
		{
			id: 'v-lg',
			valueIds: ['lg'],
			price: large,
			availabilityStatus: 'available',
		},
	],
})

export function demoCatalog(): CatalogSnapshot {
	position = 0
	const cat = (
		id: string,
		displayName: string,
		items: MenuItem[],
		subcategories: MenuCategory[] = [],
		parentId: string | null = null,
	): MenuCategory => ({
		id,
		displayName,
		parentId,
		subcategories,
		availabilityStatus: 'available',
		position: position++,
		items,
	})
	return {
		key: 'catalog',
		fetchedAt: Date.now(),
		organization: {
			id: 'demo-org',
			name: 'Demo Kitchen',
			slug: 'demo',
			theme: {
				baseColor: 'stone',
				theme: 'demo',
				radius: '0.75rem',
				mode: 'light',
				css: `:root{--radius:.875rem;--background:oklch(.985 .006 85);--foreground:oklch(.22 .02 60);--card:oklch(1 0 0);--card-foreground:oklch(.22 .02 60);--popover:oklch(1 0 0);--popover-foreground:oklch(.22 .02 60);--primary:oklch(.46 .11 150);--primary-foreground:oklch(.985 .01 150);--secondary:oklch(.95 .012 85);--secondary-foreground:oklch(.3 .03 60);--muted:oklch(.95 .01 85);--muted-foreground:oklch(.5 .02 60);--accent:oklch(.93 .04 85);--accent-foreground:oklch(.3 .05 60);--destructive:oklch(.55 .2 27);--border:oklch(.9 .01 85);--input:oklch(.9 .01 85);--ring:oklch(.46 .11 150)}`,
			},
		},
		menu: {
			organization: {
				id: 'demo-org',
				name: 'Demo Kitchen',
				slug: 'demo',
				currency: 'USD',
				defaultLocale: 'en',
			},
			locations: [
				{
					id: 'loc-1',
					name: 'Downtown',
					timezone: 'America/New_York',
					taxRate: 8.25,
					currency: 'USD',
					isDefault: true,
					phone: null,
				},
			],
			locationOverrides: {},
			menus: [
				{
					id: 'm1',
					displayName: 'All day',
					menuType: 'standard',
					availabilityStatus: 'available',
					position: 0,
					categories: [
						cat('c-mains', 'Mains', [
							item('i-burger', 'Smash Burger', 13.5, {
								isPopular: true,
								description:
									'Two patties, American cheese, pickles, house sauce',
								modifierGroups: [doneness, extras],
							}),
							item('i-chicken', 'Crispy Chicken Sandwich', 12.75, {
								modifierGroups: [extras],
							}),
							item('i-salmon', 'Seared Salmon', 19, {
								isGlutenFree: true,
								modifierGroups: [doneness],
							}),
							item('i-veg', 'Roasted Veg Bowl', 12, {
								isVegetarian: true,
								isGlutenFree: true,
							}),
							item('i-steak', 'Steak Frites', 24.5, {
								modifierGroups: [doneness],
							}),
							item('i-pasta', 'Fresh Pasta', 15, {
								isVegetarian: true,
								modifierGroups: [sauce],
							}),
							item('i-ribs', 'Smoked Ribs', 21, {
								availabilityStatus: 'unavailable',
							}),
						]),
						cat('c-starters', 'Starters', [
							item('i-fries', 'Truffle Fries', 7.5, {
								isVegetarian: true,
								isPopular: true,
							}),
							item('i-wings', 'Buffalo Wings', 11),
							item('i-soup', 'Tomato Soup', 7, { isVegetarian: true }),
							item('i-salad', 'Little Gem Caesar', 9.5, {
								modifierGroups: [extras],
							}),
						]),
						cat('c-pizza', 'Pizza', [
							item('i-marg', 'Margherita', 14, {
								isVegetarian: true,
								variations: sizes(14, 19),
								modifierGroups: [extras],
							}),
							item('i-pep', 'Pepperoni', 16, {
								variations: sizes(16, 21),
								modifierGroups: [extras],
							}),
						]),
						cat(
							'c-drinks',
							'Drinks',
							[
								item('i-water', 'Sparkling Water', 3),
								item('i-tap', 'House Tap Water', 0),
							],
							[
								cat(
									'c-hot',
									'Hot',
									[
										item('i-latte', 'Latte', 4.75, {
											variations: sizes(4.75, 5.75),
										}),
										item('i-tea', 'Pot of Tea', 4),
									],
									[],
									'c-drinks',
								),
								cat(
									'c-cold',
									'Cold',
									[item('i-cola', 'Cola', 3.5)],
									[
										cat(
											'c-juice',
											'Juice',
											[
												item('i-oj', 'Orange Juice', 4.25),
												item('i-apple', 'Apple Juice', 4),
											],
											[],
											'c-cold',
										),
										cat(
											'c-soda',
											'Fountain',
											[
												item('i-lemon', 'Fresh Lemonade', 4.5, {
													variations: sizes(4.5, 6),
												}),
											],
											[],
											'c-cold',
										),
									],
									'c-drinks',
								),
							],
						),
						cat('c-dessert', 'Dessert', [
							item('i-brownie', 'Warm Brownie', 8, { isVegetarian: true }),
							item('i-cheese', 'Basque Cheesecake', 9, {
								isVegetarian: true,
								isPopular: true,
							}),
						]),
					],
				},
			],
		},
	}
}
