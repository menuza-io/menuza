/**
 * Word lists for the polish cards (#234): menu words the typo pre-filter
 * trusts, scales the option-order card knows, and the keywords that sort
 * categories into the usual order of a meal. Pure data.
 */

const MENU_WORDS = `
chicken cheese cheddar mozzarella parmesan ricotta feta halloumi gouda swiss provolone mascarpone gorgonzola
sauce sauces gravy dressing mayonnaise mayo ketchup mustard vinegar balsamic
espresso cappuccino latte macchiato americano mocha frappe coffee cortado tea matcha chai lemonade smoothie milkshake juice
orange apple mango strawberry blueberry raspberry banana pineapple coconut lemon lime grape cherry peach watermelon pomegranate passion berry berries
tomato tomatoes potato potatoes onion onions garlic pepper peppers jalapeño jalapeno cucumber lettuce spinach arugula rocket cabbage carrot carrots
broccoli cauliflower mushroom mushrooms zucchini courgette eggplant aubergine avocado olive olives pickles pickled corn beans chickpeas lentils
rice pasta spaghetti penne fettuccine lasagna lasagne ravioli gnocchi noodles macaroni linguine tagliatelle risotto
pizza margherita pepperoni calzone bruschetta focaccia sandwich sandwiches burger burgers hamburger cheeseburger hotdog wrap wraps panini bagel
croissant brioche baguette toast bread bun buns pita naan tortilla taco tacos burrito quesadilla nachos fajita fajitas enchilada
salad salads caesar greek soup soups starter starters appetizer appetizers appetiser appetisers dessert desserts
cheesecake brownie brownies tiramisu pancake pancakes waffle waffles cookie cookies muffin muffins donut donuts doughnut pudding custard gelato sundae
cream chocolate vanilla caramel honey syrup sugar butter cinnamon nutella pistachio almond almonds walnut walnuts hazelnut peanut peanuts cashew sesame
beef steak ribeye sirloin tenderloin fillet filet brisket ribs lamb mutton veal pork bacon sausage sausages ham salami turkey duck
fish salmon tuna shrimp prawns prawn lobster crab calamari squid octopus mussels oysters seafood anchovies sardines
grilled fried roasted baked steamed smoked crispy crunchy spicy sweet sour creamy fresh tender juicy served topped stuffed marinated glazed toasted
sauteed breaded battered double triple single regular medium large small extra family special signature classic house homemade
platter combo bowl plate portion sides fries wedges chips rings coleslaw
hummus falafel shawarma kebab kabab kabob kebap tikka masala curry biryani korma paneer tandoori teriyaki sushi sashimi tempura ramen udon katsu tofu wasabi
ginger soy sriracha buffalo barbecue chipotle ranch pesto marinara alfredo carbonara bolognese arrabbiata
parsley basil oregano thyme rosemary coriander cilantro mint dill paprika cumin turmeric saffron truffle
water sparkling still soda cola coke sprite beer wine cocktail mojito
breakfast lunch dinner brunch omelette omelet scrambled poached benedict granola yogurt yoghurt cereal oatmeal porridge
french italian mexican turkish lebanese indian chinese thai japanese american mediterranean vegetarian vegan gluten dairy
topping toppings choice choose please
café cafe entrée entree purée puree crème creme
kunafa kunafeh knafeh mutabbal mutabal moutabal fattoush tabbouleh tabouli manakish labneh baklava kibbeh tawook mandi kabsa harees mansaf shakshuka
zaatar sambousek sambosa mujaddara mujadara ghanoush baba shish kofta kafta fatteh foul fuul maqluba musakhan mahalabia muhallabia basbousa qatayef
`

export const MENU_WORD_LIST: readonly string[] = [
	...new Set(MENU_WORDS.split(/\s+/).filter(Boolean)),
]
export const MENU_WORD_SET: ReadonlySet<string> = new Set(MENU_WORD_LIST)

// --- Option scales ------------------------------------------------------------

/** Names that belong at the same place of a scale are in one inner array. */
export type OptionScale = { id: string; steps: string[][] }

export const OPTION_SCALES: readonly OptionScale[] = [
	{
		id: 'size',
		steps: [
			['xs', 'extra small', 'x small'],
			['small', 's', 'mini'],
			['regular', 'standard'],
			['medium', 'm', 'mid'],
			['large', 'l'],
			['xl', 'extra large', 'x large'],
			['xxl', '2xl', 'xx large'],
		],
	},
	{ id: 'heat', steps: [['mild'], ['medium'], ['hot'], ['extra hot']] },
	{
		id: 'doneness',
		steps: [
			['rare'],
			['medium rare'],
			['medium'],
			['medium well'],
			['well done'],
		],
	},
	{ id: 'count', steps: [['single'], ['double'], ['triple']] },
	{
		id: 'size_ar',
		steps: [['صغير'], ['وسط', 'متوسط'], ['كبير'], ['عائلي']],
	},
	{
		id: 'heat_ar',
		steps: [['حار قليلا', 'خفيف'], ['وسط'], ['حار'], ['حار جدا']],
	},
]

// --- Category classes ---------------------------------------------------------

export type CategoryClass = { rank: number; english: RegExp; arabic: string[] }

/**
 * Checked in this order (the first match wins), so "side salad" is a side
 * and "dessert drinks" a dessert. `rank` is the place in a meal.
 */
export const CATEGORY_CLASSES: readonly CategoryClass[] = [
	{
		rank: 3,
		english: /\b(?:sides?)\b/,
		arabic: ['سلطات جانبية', 'اطباق جانبية'],
	},
	{
		rank: 4,
		english: /\b(?:desserts?|sweets?)\b/,
		arabic: ['حلويات', 'حلى'],
	},
	{
		rank: 5,
		english: /\b(?:drinks?|beverages?|coffee|tea|juices?|smoothies?)\b/,
		arabic: ['مشروبات', 'عصائر', 'قهوة'],
	},
	{
		rank: 1,
		english: /\b(?:starters?|appetizers?|appetisers?|salads?|soups?)\b/,
		arabic: ['مقبلات', 'سلطات', 'شوربات'],
	},
	{
		rank: 2,
		english:
			/\b(?:mains?|entrees?|entrées?|burgers?|pizzas?|pastas?|grills?|sandwich(?:es)?|wraps?)\b/,
		arabic: ['اطباق رئيسية', 'برجر', 'بيتزا', 'مشويات'],
	},
]

/** "Size" and "Regular" in the menu's language (the free-dish fix). */
export const SIZE_WORDS: Record<string, { size: string; regular: string }> = {
	en: { size: 'Size', regular: 'Regular' },
	ar: { size: 'الحجم', regular: 'عادي' },
	es: { size: 'Tamaño', regular: 'Normal' },
	fr: { size: 'Taille', regular: 'Normal' },
	de: { size: 'Größe', regular: 'Normal' },
	zh: { size: '尺寸', regular: '常规' },
}
