/**
 * Cuisines and price range (#182). The cuisine list is fixed: keys with an
 * English and an Arabic label and the text schema.org `servesCuisine` takes,
 * so listings and structured data map reliably. There is no "Other": cuisines
 * are added here on request.
 *
 * Stored as a JSON array of keys on `Organization.cuisines` (at most three)
 * with an optional per-location override (`OrganizationLocation.cuisines`).
 * Price range is a level from 1 to 4 (`$` to `$$$$`), nullable: empty leaves
 * it out everywhere.
 */

export type CuisineDefinition = {
	key: string
	/** English label (also the schema.org `servesCuisine` text). */
	en: string
	ar: string
	/** Google Business Profile style category, for listings and suggestions. */
	category: string
}

export const CUISINES = [
	{
		key: 'american',
		en: 'American',
		ar: 'أمريكي',
		category: 'American restaurant',
	},
	{
		key: 'arabic',
		en: 'Arabic',
		ar: 'عربي',
		category: 'Middle Eastern restaurant',
	},
	{ key: 'bakery', en: 'Bakery', ar: 'مخبز', category: 'Bakery' },
	{ key: 'bbq', en: 'Barbecue', ar: 'مشويات', category: 'Barbecue restaurant' },
	{
		key: 'breakfast',
		en: 'Breakfast',
		ar: 'فطور',
		category: 'Breakfast restaurant',
	},
	{ key: 'brunch', en: 'Brunch', ar: 'برانش', category: 'Brunch restaurant' },
	{
		key: 'burgers',
		en: 'Burgers',
		ar: 'برجر',
		category: 'Hamburger restaurant',
	},
	{ key: 'cafe', en: 'Cafe', ar: 'مقهى', category: 'Cafe' },
	{ key: 'chinese', en: 'Chinese', ar: 'صيني', category: 'Chinese restaurant' },
	{ key: 'coffee', en: 'Coffee', ar: 'قهوة', category: 'Coffee shop' },
	{ key: 'desserts', en: 'Desserts', ar: 'حلويات', category: 'Dessert shop' },
	{
		key: 'egyptian',
		en: 'Egyptian',
		ar: 'مصري',
		category: 'Egyptian restaurant',
	},
	{ key: 'french', en: 'French', ar: 'فرنسي', category: 'French restaurant' },
	{ key: 'greek', en: 'Greek', ar: 'يوناني', category: 'Greek restaurant' },
	{
		key: 'healthy',
		en: 'Healthy',
		ar: 'صحي',
		category: 'Health food restaurant',
	},
	{ key: 'indian', en: 'Indian', ar: 'هندي', category: 'Indian restaurant' },
	{
		key: 'italian',
		en: 'Italian',
		ar: 'إيطالي',
		category: 'Italian restaurant',
	},
	{
		key: 'japanese',
		en: 'Japanese',
		ar: 'ياباني',
		category: 'Japanese restaurant',
	},
	{ key: 'juice', en: 'Juice', ar: 'عصائر', category: 'Juice shop' },
	{ key: 'korean', en: 'Korean', ar: 'كوري', category: 'Korean restaurant' },
	{
		key: 'lebanese',
		en: 'Lebanese',
		ar: 'لبناني',
		category: 'Lebanese restaurant',
	},
	{
		key: 'mediterranean',
		en: 'Mediterranean',
		ar: 'متوسطي',
		category: 'Mediterranean restaurant',
	},
	{
		key: 'mexican',
		en: 'Mexican',
		ar: 'مكسيكي',
		category: 'Mexican restaurant',
	},
	{
		key: 'middle_eastern',
		en: 'Middle Eastern',
		ar: 'شرق أوسطي',
		category: 'Middle Eastern restaurant',
	},
	{
		key: 'pakistani',
		en: 'Pakistani',
		ar: 'باكستاني',
		category: 'Pakistani restaurant',
	},
	{ key: 'pizza', en: 'Pizza', ar: 'بيتزا', category: 'Pizza restaurant' },
	{ key: 'saudi', en: 'Saudi', ar: 'سعودي', category: 'Saudi restaurant' },
	{
		key: 'seafood',
		en: 'Seafood',
		ar: 'مأكولات بحرية',
		category: 'Seafood restaurant',
	},
	{
		key: 'shawarma',
		en: 'Shawarma',
		ar: 'شاورما',
		category: 'Shawarma restaurant',
	},
	{
		key: 'steakhouse',
		en: 'Steakhouse',
		ar: 'ستيك هاوس',
		category: 'Steak house',
	},
	{ key: 'sushi', en: 'Sushi', ar: 'سوشي', category: 'Sushi restaurant' },
	{ key: 'thai', en: 'Thai', ar: 'تايلندي', category: 'Thai restaurant' },
	{ key: 'turkish', en: 'Turkish', ar: 'تركي', category: 'Turkish restaurant' },
	{ key: 'vegan', en: 'Vegan', ar: 'نباتي صرف', category: 'Vegan restaurant' },
	{
		key: 'vegetarian',
		en: 'Vegetarian',
		ar: 'نباتي',
		category: 'Vegetarian restaurant',
	},
	{ key: 'yemeni', en: 'Yemeni', ar: 'يمني', category: 'Yemeni restaurant' },
] as const satisfies readonly CuisineDefinition[]

export type CuisineKey = (typeof CUISINES)[number]['key']

export const MAX_CUISINES = 3

const BY_KEY = new Map<string, CuisineDefinition>(
	CUISINES.map((cuisine) => [cuisine.key, cuisine]),
)

export function isCuisineKey(value: unknown): value is CuisineKey {
	return typeof value === 'string' && BY_KEY.has(value)
}

export function getCuisine(key: string): CuisineDefinition | null {
	return BY_KEY.get(key) ?? null
}

/** The label in a language: Arabic for `ar*`, English otherwise. */
export function cuisineLabel(key: string, locale: string): string {
	const cuisine = BY_KEY.get(key)
	if (!cuisine) return ''
	return locale.toLowerCase().startsWith('ar') ? cuisine.ar : cuisine.en
}

export type CuisineValidation =
	| { ok: true; keys: CuisineKey[] }
	| { ok: false; error: 'unknown_cuisine' | 'too_many_cuisines' }

/**
 * Validate operator input: known keys only, duplicates collapsed, at most
 * three. Order is kept (the first is the main cuisine).
 */
export function validateCuisines(input: readonly unknown[]): CuisineValidation {
	const keys: CuisineKey[] = []
	for (const value of input) {
		if (!isCuisineKey(value)) return { ok: false, error: 'unknown_cuisine' }
		if (!keys.includes(value)) keys.push(value)
	}
	if (keys.length > MAX_CUISINES)
		return { ok: false, error: 'too_many_cuisines' }
	return { ok: true, keys }
}

/**
 * Read a stored value (JSON text or an array). Unknown keys are dropped, so a
 * key removed from the list never reaches the site. `null` means not set
 * (for a location: use the organization's).
 */
export function parseStoredCuisines(value: unknown): CuisineKey[] | null {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return null
		}
	}
	if (!Array.isArray(raw)) return null
	const keys: CuisineKey[] = []
	for (const item of raw) {
		if (isCuisineKey(item) && !keys.includes(item)) keys.push(item)
	}
	return keys.slice(0, MAX_CUISINES)
}

export const PRICE_RANGE_LEVELS = [1, 2, 3, 4] as const
export type PriceRangeLevel = (typeof PRICE_RANGE_LEVELS)[number]

export function parsePriceRange(value: unknown): PriceRangeLevel | null {
	const level = typeof value === 'string' ? Number(value) : value
	return typeof level === 'number' &&
		(PRICE_RANGE_LEVELS as readonly number[]).includes(level)
		? (level as PriceRangeLevel)
		: null
}

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: '$',
	CAD: '$',
	AUD: '$',
	EUR: '€',
	GBP: '£',
	SAR: '﷼',
	AED: 'د.إ',
}

/** The local currency symbol, `$` when the currency is unknown. */
export function currencySymbol(currency: string | null | undefined): string {
	return CURRENCY_SYMBOLS[(currency ?? '').toUpperCase()] ?? '$'
}

/** `$$` for level 2 in dollars, `﷼﷼` in riyals. Empty when not set. */
export function formatPriceRange(
	level: number | null | undefined,
	currency?: string | null,
): string {
	const parsed = parsePriceRange(level)
	if (!parsed) return ''
	return currencySymbol(currency).repeat(parsed)
}

/**
 * What a location publishes: its own cuisines and price range when set,
 * otherwise the organization's. An empty location list counts as "not set".
 */
export function resolveCuisineAndPrice(
	organization: { cuisines: unknown; priceRange: unknown },
	location?: { cuisines: unknown; priceRange: unknown } | null,
): { cuisines: CuisineKey[]; priceRange: PriceRangeLevel | null } {
	const own = location ? parseStoredCuisines(location.cuisines) : null
	return {
		cuisines:
			own && own.length
				? own
				: (parseStoredCuisines(organization.cuisines) ?? []),
		priceRange:
			(location ? parsePriceRange(location.priceRange) : null) ??
			parsePriceRange(organization.priceRange),
	}
}

/** schema.org `servesCuisine` values (English names). */
export function servesCuisine(keys: readonly string[]): string[] {
	return keys
		.map((key) => BY_KEY.get(key)?.en)
		.filter((name): name is string => Boolean(name))
}
