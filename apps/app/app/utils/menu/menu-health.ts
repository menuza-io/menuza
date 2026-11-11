import {
	parseLocalizedString,
	type SiteContentLocale,
} from '@repo/common/site-locales'

/**
 * Menu health: a 0-100 score for how complete an organization's menu is, plus
 * the fix-it list behind it. Pure, so the Menu overview and the filtered Items
 * and Categories lists agree on which records each check matches.
 */

export const MENU_HEALTH_CHECK_KEYS = [
	'zero_price',
	'no_photo',
	'no_description',
	'missing_translation',
	'empty_category',
	'long_unavailable',
	'no_allergens_or_calories',
] as const

export type MenuHealthCheckKey = (typeof MENU_HEALTH_CHECK_KEYS)[number]

export type MenuHealthSeverity = 'error' | 'warning' | 'info'

/**
 * Relative weight of each check. Photos and descriptions sell the dish, so
 * they weigh most. A zero price is an error: any one of them costs at least
 * half its weight (see `penaltyFraction`).
 */
export const MENU_HEALTH_WEIGHTS: Record<MenuHealthCheckKey, number> = {
	no_photo: 30,
	no_description: 25,
	zero_price: 15,
	missing_translation: 10,
	no_allergens_or_calories: 10,
	empty_category: 5,
	long_unavailable: 5,
}

const SEVERITY: Record<MenuHealthCheckKey, MenuHealthSeverity> = {
	zero_price: 'error',
	no_photo: 'warning',
	no_description: 'warning',
	missing_translation: 'warning',
	empty_category: 'warning',
	long_unavailable: 'info',
	no_allergens_or_calories: 'info',
}

/** Checks whose ids are categories; every other check lists dishes. */
export const MENU_HEALTH_CATEGORY_CHECKS: ReadonlySet<MenuHealthCheckKey> =
	new Set<MenuHealthCheckKey>(['empty_category'])

export const LONG_UNAVAILABLE_MS = 7 * 24 * 60 * 60 * 1000

export type MenuHealthItem = {
	id: string
	displayName: string
	description: string | null
	price: number
	imageKey: string | null
	imageUrl: string | null
	/** JSON array of image keys, as stored. */
	imageKeys: string | null
	/** JSON variations, as stored; only variant prices are read. */
	variations: string | null
	/** JSON array of allergens, as stored. */
	allergens: string | null
	calorieMin: number | null
	calorieMax: number | null
	availabilityStatus: string
	unavailableUntil: Date | null
	updatedAt: Date
}

export type MenuHealthCategory = {
	id: string
	parentId: string | null
	availabilityStatus: string
}

export type MenuHealthInput = {
	items: MenuHealthItem[]
	categories: MenuHealthCategory[]
	/** Category ids that have at least one item assigned. */
	categoryIdsWithItems: Iterable<string>
	/** Enabled site content locales; the default locale first or anywhere. */
	locales: readonly SiteContentLocale[]
	defaultLocale: SiteContentLocale
	now?: Date
}

export type MenuHealthCheck = {
	key: MenuHealthCheckKey
	severity: MenuHealthSeverity
	/** Records that fail the check. */
	count: number
	/** Records the check looked at. */
	total: number
	itemIds?: string[]
	categoryIds?: string[]
	/** missing_translation only: the locales checked. */
	locales?: SiteContentLocale[]
}

export type MenuHealth = {
	score: number
	/** Every check that applies, failing or not. */
	checks: MenuHealthCheck[]
	itemCount: number
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
	if (!raw) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function hasText(value: string | undefined): boolean {
	return Boolean(value?.trim())
}

export function itemHasPhoto(item: MenuHealthItem): boolean {
	if (
		hasText(item.imageKey ?? undefined) ||
		hasText(item.imageUrl ?? undefined)
	)
		return true
	return parseJsonArray(item.imageKeys).some(
		(key) => typeof key === 'string' && key.trim().length > 0,
	)
}

function variantPrices(raw: string | null): number[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw) as { variants?: unknown }
		if (!Array.isArray(parsed.variants)) return []
		return parsed.variants
			.map((variant) =>
				variant && typeof variant === 'object'
					? (variant as { price?: unknown }).price
					: undefined,
			)
			.filter((price): price is number => typeof price === 'number')
	} catch {
		return []
	}
}

/** Priced at 0: the base price and every variant price are 0. */
export function itemIsPricedAtZero(item: MenuHealthItem): boolean {
	if (item.price > 0) return false
	return !variantPrices(item.variations).some((price) => price > 0)
}

function itemListsAllergensOrCalories(item: MenuHealthItem): boolean {
	return (
		parseJsonArray(item.allergens).length > 0 ||
		item.calorieMin != null ||
		item.calorieMax != null
	)
}

/**
 * Unavailable with no end in sight for more than a week. There is no
 * "unavailable since" column, so the last edit stands in for it: an item
 * edited recently is never counted, which errs on the side of fewer flags.
 */
function itemIsLongUnavailable(item: MenuHealthItem, now: Date): boolean {
	const nowMs = now.getTime()
	const unavailable =
		item.availabilityStatus === 'unavailable' ||
		(item.availabilityStatus === 'unavailable_until' &&
			item.unavailableUntil != null &&
			item.unavailableUntil.getTime() > nowMs)
	if (!unavailable) return false
	return nowMs - item.updatedAt.getTime() > LONG_UNAVAILABLE_MS
}

function itemMissesTranslation(
	item: MenuHealthItem,
	locales: readonly SiteContentLocale[],
	defaultLocale: SiteContentLocale,
): boolean {
	const name = parseLocalizedString(item.displayName, defaultLocale)
	const description = parseLocalizedString(item.description, defaultLocale)
	const hasDescription = Object.values(description).some((value) =>
		hasText(value),
	)
	return locales.some(
		(locale) =>
			!hasText(name[locale]) ||
			(hasDescription && !hasText(description[locale])),
	)
}

function penaltyFraction(check: MenuHealthCheck): number {
	if (check.count === 0 || check.total === 0) return 0
	const fraction = check.count / check.total
	return check.severity === 'error' ? Math.min(1, 0.5 + fraction / 2) : fraction
}

export function computeMenuHealth(input: MenuHealthInput): MenuHealth {
	const now = input.now ?? new Date()
	// Hidden items are not shown to guests, so they cannot hurt the menu.
	const items = input.items.filter(
		(item) => item.availabilityStatus !== 'hidden',
	)
	const checks: MenuHealthCheck[] = []

	const itemCheck = (
		key: MenuHealthCheckKey,
		fails: (item: MenuHealthItem) => boolean,
	): MenuHealthCheck => {
		const itemIds = items.filter(fails).map((item) => item.id)
		return {
			key,
			severity: SEVERITY[key],
			count: itemIds.length,
			total: items.length,
			itemIds,
		}
	}

	if (items.length > 0) {
		checks.push(itemCheck('zero_price', itemIsPricedAtZero))
		checks.push(itemCheck('no_photo', (item) => !itemHasPhoto(item)))
		checks.push(
			itemCheck(
				'no_description',
				(item) =>
					!Object.values(
						parseLocalizedString(item.description, input.defaultLocale),
					).some((value) => hasText(value)),
			),
		)

		const translationLocales = Array.from(new Set(input.locales)).filter(
			(locale) => locale !== input.defaultLocale,
		)
		if (translationLocales.length > 0) {
			checks.push({
				...itemCheck('missing_translation', (item) =>
					itemMissesTranslation(item, translationLocales, input.defaultLocale),
				),
				locales: translationLocales,
			})
		}

		checks.push(
			itemCheck(
				'no_allergens_or_calories',
				(item) => !itemListsAllergensOrCalories(item),
			),
		)
		checks.push(
			itemCheck('long_unavailable', (item) => itemIsLongUnavailable(item, now)),
		)
	}

	const categories = input.categories.filter(
		(category) => category.availabilityStatus !== 'hidden',
	)
	if (categories.length > 0) {
		const withItems = new Set(input.categoryIdsWithItems)
		const parents = new Set(
			input.categories
				.map((category) => category.parentId)
				.filter((id): id is string => Boolean(id)),
		)
		const categoryIds = categories
			.filter(
				(category) => !withItems.has(category.id) && !parents.has(category.id),
			)
			.map((category) => category.id)
		checks.push({
			key: 'empty_category',
			severity: SEVERITY.empty_category,
			count: categoryIds.length,
			total: categories.length,
			categoryIds,
		})
	}

	const totalWeight = checks.reduce(
		(sum, check) => sum + MENU_HEALTH_WEIGHTS[check.key],
		0,
	)
	const lost = checks.reduce(
		(sum, check) =>
			sum + MENU_HEALTH_WEIGHTS[check.key] * penaltyFraction(check),
		0,
	)
	const rawScore =
		totalWeight === 0 ? 100 : (100 * (totalWeight - lost)) / totalWeight
	// Never round a menu with problems up to a perfect 100.
	const failing = checks.some((check) => check.count > 0)
	const score = Math.max(0, Math.min(failing ? 99 : 100, Math.round(rawScore)))

	return { score, checks, itemCount: items.length }
}

const SEVERITY_ORDER: Record<MenuHealthSeverity, number> = {
	error: 0,
	warning: 1,
	info: 2,
}

/** The failing checks, most urgent first. */
export function getMenuHealthFixes(health: MenuHealth): MenuHealthCheck[] {
	return health.checks
		.filter((check) => check.count > 0)
		.sort(
			(a, b) =>
				SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
				MENU_HEALTH_WEIGHTS[b.key] - MENU_HEALTH_WEIGHTS[a.key],
		)
}

export function parseMenuHealthCheckKey(
	value: string | null | undefined,
): MenuHealthCheckKey | null {
	return (MENU_HEALTH_CHECK_KEYS as readonly string[]).includes(value ?? '')
		? (value as MenuHealthCheckKey)
		: null
}

/** Query parameter the Items and Categories lists read to filter by a check. */
export const MENU_HEALTH_PARAM = 'health'
