import {
	type LocalizedString,
	parseLocalizedString,
	type SiteContentLocale,
} from '@repo/common/site-locales'

/**
 * Menu health: a 0-100 score for how complete an organization's menu is, a
 * letter grade derived from it, and the fix-it list behind both. Pure, so the
 * Menu overview and the filtered Items, Categories and Modifier groups lists
 * agree on which records each check matches.
 *
 * Dismissals. An operator can dismiss one check for one record ("this dish
 * has no photo on purpose"). A dismissal stores a fingerprint of the field
 * the check looks at (`menuHealthFingerprint`). A dismissed check stays away
 * until the field it looks at changes; once the record passes the check or
 * that field changes, the dismissal is dropped (`staleDismissals`, deleted by
 * the loader), so if the problem comes back later it counts again. A
 * dismissed record is left out of `count`, the id lists, the score, the grade
 * and `fixCount`, but still counts in `total`.
 *
 * Rows whose `checkKey` starts with `card:` belong to the review stack and
 * are ignored here.
 */

export const MENU_HEALTH_CHECK_KEYS = [
	'zero_price',
	'no_photo',
	'no_description',
	'missing_translation',
	'empty_category',
	'long_unavailable',
	'no_allergens_or_calories',
	'name_all_caps',
	'name_too_long',
	'empty_option_group',
	'impossible_minimum',
	'duplicate_item',
] as const

export type MenuHealthCheckKey = (typeof MENU_HEALTH_CHECK_KEYS)[number]

export type MenuHealthSeverity = 'error' | 'warning' | 'info'

/**
 * Relative weight of each check. Photos and descriptions sell the dish, so
 * they weigh most. A zero price is an error: any one of them costs at least
 * half its weight (see `penaltyFraction`).
 *
 * The checks in `MENU_HEALTH_DEDUCTION_CHECKS` are pure deductions: they take
 * `weight x penaltyFraction` off like the others, but their weight is never
 * added to the total the score is a share of. So a menu that passes them
 * scores exactly what it scored before they existed.
 */
export const MENU_HEALTH_WEIGHTS: Record<MenuHealthCheckKey, number> = {
	no_photo: 30,
	no_description: 25,
	zero_price: 15,
	missing_translation: 10,
	no_allergens_or_calories: 10,
	empty_category: 5,
	long_unavailable: 5,
	// Deductions (see above).
	impossible_minimum: 15,
	empty_option_group: 10,
	duplicate_item: 5,
	name_all_caps: 5,
	name_too_long: 5,
}

/** Checks that only deduct; see `MENU_HEALTH_WEIGHTS`. */
export const MENU_HEALTH_DEDUCTION_CHECKS: ReadonlySet<MenuHealthCheckKey> =
	new Set<MenuHealthCheckKey>([
		'impossible_minimum',
		'empty_option_group',
		'duplicate_item',
		'name_all_caps',
		'name_too_long',
	])

const SEVERITY: Record<MenuHealthCheckKey, MenuHealthSeverity> = {
	zero_price: 'error',
	impossible_minimum: 'error',
	no_photo: 'warning',
	no_description: 'warning',
	missing_translation: 'warning',
	empty_category: 'warning',
	empty_option_group: 'warning',
	duplicate_item: 'warning',
	long_unavailable: 'info',
	no_allergens_or_calories: 'info',
	name_all_caps: 'info',
	name_too_long: 'info',
}

/** Checks whose ids are categories. */
export const MENU_HEALTH_CATEGORY_CHECKS: ReadonlySet<MenuHealthCheckKey> =
	new Set<MenuHealthCheckKey>(['empty_category'])

/** Checks whose ids are modifier (option) groups. */
export const MENU_HEALTH_GROUP_CHECKS: ReadonlySet<MenuHealthCheckKey> =
	new Set<MenuHealthCheckKey>(['empty_option_group', 'impossible_minimum'])

export type MenuHealthEntityType = 'item' | 'category' | 'modifier_group'

/** What kind of record a check lists; every other check lists dishes. */
export function menuHealthEntityType(
	key: MenuHealthCheckKey,
): MenuHealthEntityType {
	if (MENU_HEALTH_CATEGORY_CHECKS.has(key)) return 'category'
	if (MENU_HEALTH_GROUP_CHECKS.has(key)) return 'modifier_group'
	return 'item'
}

export const LONG_UNAVAILABLE_MS = 7 * 24 * 60 * 60 * 1000

/** Longest dish name, in characters (code points, after trimming). */
export const MENU_HEALTH_NAME_MAX = 60

export const MENU_HEALTH_GRADES = ['A', 'B', 'C', 'D', 'F'] as const
export type MenuHealthGrade = (typeof MENU_HEALTH_GRADES)[number]

/**
 * The letter for a score, from the rounded score: A 90-100, B 80-89,
 * C 70-79, D 60-69, F 0-59. The grade is only ever derived here, so the
 * score and the letter cannot disagree.
 */
export function menuHealthGrade(score: number): MenuHealthGrade {
	const rounded = Math.round(score)
	if (!Number.isFinite(rounded)) return 'F'
	if (rounded >= 90) return 'A'
	if (rounded >= 80) return 'B'
	if (rounded >= 70) return 'C'
	if (rounded >= 60) return 'D'
	return 'F'
}

/** True when the menu's grade is `minimum` or better (for the launch checklist). */
export function menuHealthMeetsGrade(
	health: Pick<MenuHealth, 'score'>,
	minimum: MenuHealthGrade,
): boolean {
	return (
		MENU_HEALTH_GRADES.indexOf(menuHealthGrade(health.score)) <=
		MENU_HEALTH_GRADES.indexOf(minimum)
	)
}

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

export type MenuHealthModifierGroup = {
	id: string
	selectionType: string
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
}

export type MenuHealthDismissal = {
	entityId: string
	checkKey: string
	fingerprint: string
}

export type MenuHealthInput = {
	items: MenuHealthItem[]
	categories: MenuHealthCategory[]
	/** Category ids that have at least one item assigned. */
	categoryIdsWithItems: Iterable<string>
	/** Enabled site content locales; the default locale first or anywhere. */
	locales: readonly SiteContentLocale[]
	defaultLocale: SiteContentLocale
	/**
	 * Option groups. The two group checks run only when this is given (older
	 * callers leave it out and get the item and category checks only).
	 */
	modifierGroups?: MenuHealthModifierGroup[]
	/** Groups attached directly to dishes. */
	itemModifierGroups?: Iterable<{ itemId: string; modifierGroupId: string }>
	/** One row per option assigned to a group, with that option's status. */
	modifierGroupOptions?: Iterable<{
		modifierGroupId: string
		availabilityStatus: string
		/** With `unavailable_until`: the option is back from this time on. */
		unavailableUntil?: Date | null
		/** The option's own pick cap in a quantity group (null: no cap). */
		optionMaxSelections?: number | null
	}>
	/** Health dismissals of this organization (`card:` rows are ignored). */
	dismissals?: readonly MenuHealthDismissal[]
	/** Fill `fingerprints` on every check (server use, e.g. to dismiss). */
	includeFingerprints?: boolean
	now?: Date
}

export type MenuHealthCheck = {
	key: MenuHealthCheckKey
	severity: MenuHealthSeverity
	/** Records that fail the check, not counting dismissed ones. */
	count: number
	/** Records the check looked at (dismissed ones included). */
	total: number
	itemIds?: string[]
	categoryIds?: string[]
	modifierGroupIds?: string[]
	/**
	 * Failing records hidden by a dismissal whose fingerprint still matches.
	 * Always set by `computeMenuHealth`.
	 */
	dismissedIds?: string[]
	/** missing_translation only: the locales checked. */
	locales?: SiteContentLocale[]
	/**
	 * With `includeFingerprints`: the current fingerprint of every failing
	 * and dismissed record. Server only; never send it to the browser.
	 */
	fingerprints?: Record<string, string>
}

export type MenuHealth = {
	score: number
	grade: MenuHealthGrade
	/** Failing, non-dismissed records over all checks: "N things to fix". */
	fixCount: number
	/** Every check that applies, failing or not. */
	checks: MenuHealthCheck[]
	itemCount: number
	/**
	 * Health dismissals that no longer apply: a visible record passes now or
	 * its field changed. A dismissal of a hidden or missing record is kept (it
	 * applies again when the dish is shown; deleted records are cleaned up
	 * elsewhere). Only for checks that ran.
	 */
	staleDismissals: Array<{
		entityId: string
		checkKey: MenuHealthCheckKey
		/** The stored fingerprint, so a delete can skip a row saved again since. */
		fingerprint: string
	}>
}

/** A record listed under a check on the Menu overview. */
export type MenuHealthRecordRef = { id: string; name: string }

/** What the Menu overview sends to the browser for each check. */
export type MenuHealthCheckSummary = {
	key: MenuHealthCheckKey
	severity: MenuHealthSeverity
	count: number
	total: number
	locales?: SiteContentLocale[]
	/** Edit links: items/<id>, categories/<id>, modifiers/<id>. */
	entityType: MenuHealthEntityType
	/** Failing records, at most `MENU_HEALTH_RECORDS_MAX`. */
	records: MenuHealthRecordRef[]
	dismissedCount: number
	/** Dismissed records, at most `MENU_HEALTH_RECORDS_MAX`. */
	dismissed: MenuHealthRecordRef[]
}

export type MenuHealthSummary = {
	score: number
	grade: MenuHealthGrade
	fixCount: number
	itemCount: number
	checks: MenuHealthCheckSummary[]
}

export const MENU_HEALTH_RECORDS_MAX = 50

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

const LOWER_CASE = /\p{Ll}/u
const UPPER_RUN = /\p{Lu}{4,}/u
const ANY_LETTER = /\p{L}/gu
const CASED_LETTER = /[\p{Lu}\p{Ll}]/gu
const MARKS = /[\p{M}\u0640]/gu

/** More than half of the name's letters have a case (Latin, Greek, Cyrillic...). */
function mostLettersAreCased(name: string): boolean {
	const letters = name.match(ANY_LETTER)?.length ?? 0
	if (letters === 0) return false
	const cased = name.match(CASED_LETTER)?.length ?? 0
	return cased * 2 > letters
}

/**
 * Written in capitals: no lower-case letter at all, and at least one run of
 * 4 or more upper-case letters. So "BBQ", "BLT" or "KFC BBQ" (short
 * abbreviations) and "BBQ Wings" are fine, "BBQ WINGS" is not. Only cased
 * scripts can match: Arabic and other scripts without case never do, and a
 * mixed name ("بيبسي PEPSI") counts only when more than half of its letters
 * are cased.
 */
export function nameIsAllCaps(name: string): boolean {
	return (
		!LOWER_CASE.test(name) && UPPER_RUN.test(name) && mostLettersAreCased(name)
	)
}

/**
 * Over `MENU_HEALTH_NAME_MAX` characters (code points, after trimming;
 * combining marks such as Arabic vowel signs and tatweel do not count).
 */
export function nameIsTooLong(name: string): boolean {
	const trimmed = name.trim()
	// Cheap exit: code points never outnumber UTF-16 units.
	if (trimmed.length <= MENU_HEALTH_NAME_MAX) return false
	return (
		Array.from(trimmed.normalize('NFKD').replace(MARKS, '')).length >
		MENU_HEALTH_NAME_MAX
	)
}

const PUNCTUATION = /\p{P}+/gu
const SPACES = /\s+/gu
const ARABIC_MARKS = /[\u0640\u064B-\u065F\u0670]/gu

/**
 * Duplicate key for a name: case-folded, punctuation stripped, spaces
 * collapsed, Arabic tatweel and vowel signs dropped and alef forms folded.
 */
export function normalizeMenuName(name: string): string {
	return name
		.normalize('NFKC')
		.replace(ARABIC_MARKS, '')
		.replace(/[أإآٱ]/gu, 'ا')
		.replace(/ى/gu, 'ي')
		.toLowerCase()
		.replace(PUNCTUATION, '')
		.replace(SPACES, ' ')
		.trim()
}

/** FNV-1a (32 bit), as 8 hex characters. Not a security hash. */
function shortHash(value: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The field values one check reads for one record. */
export type MenuHealthFingerprintSource =
	| {
			key:
				| 'no_photo'
				| 'no_description'
				| 'empty_category'
				| 'no_allergens_or_calories'
	  }
	| { key: 'zero_price'; price: number; variantPrices: readonly number[] }
	| { key: 'missing_translation'; missingLocales: readonly string[] }
	| { key: 'long_unavailable'; availabilityStatus: string }
	| {
			key: 'name_all_caps' | 'name_too_long'
			/** The name in each enabled locale. */
			names: Readonly<Record<string, string>>
	  }
	| {
			key: 'duplicate_item'
			normalizedName: string
			price: string
			/** Every dish in the duplicate set. */
			ids: readonly string[]
	  }
	| {
			key: 'empty_option_group' | 'impossible_minimum'
			selectionType: string
			minSelections: number
			maxSelections: number | null
			visibleOptionCount: number
	  }

/**
 * A short string standing for the field value(s) a check reads for one
 * record. A dismissal applies only while the record's fingerprint equals
 * the stored one. Fields a check does not read (a photo for `no_photo`, a
 * description for `no_description`) give a constant: those dismissals end
 * only when the record passes the check.
 */
export function menuHealthFingerprint(
	source: MenuHealthFingerprintSource,
): string {
	switch (source.key) {
		case 'no_photo':
			return shortHash('none')
		case 'no_description':
		case 'empty_category':
		case 'no_allergens_or_calories':
			return shortHash('')
		case 'zero_price':
			return shortHash(
				[source.price, ...[...source.variantPrices].sort((a, b) => a - b)].join(
					',',
				),
			)
		case 'missing_translation':
			return shortHash([...source.missingLocales].sort().join(','))
		case 'long_unavailable':
			return shortHash(source.availabilityStatus)
		case 'name_all_caps':
		case 'name_too_long':
			return shortHash(
				Object.keys(source.names)
					.sort()
					.map((locale) => `${locale}=${source.names[locale]}`)
					.join('\u0001'),
			)
		case 'duplicate_item':
			return shortHash(
				`${source.normalizedName}\u0001${source.price}\u0001${[...source.ids].sort().join(',')}`,
			)
		case 'empty_option_group':
		case 'impossible_minimum':
			return shortHash(
				`${source.selectionType}:${source.minSelections}:${source.maxSelections ?? ''}:${source.visibleOptionCount}`,
			)
	}
}

/**
 * The most picks a guest can make in a group, mirroring how orders are
 * checked (`@repo/common/restaurant-orders`) and how the order page shows it:
 * single choice is a radio (1 pick), multiple choice picks distinct options,
 * pizza picks each option whole or as a left and a right half (2 per
 * option), quantity can repeat an option (no limit from the option count).
 * `null` means unlimited.
 */
function maxPicks(
	group: MenuHealthModifierGroup,
	visibleOptionCount: number,
	optionCapTotal: number | null,
): number | null {
	const max = group.maxSelections
	switch (group.selectionType) {
		case 'single':
			return Math.min(1, visibleOptionCount)
		case 'quantity': {
			// Each option repeats up to its own cap; no cap on any option means
			// no limit from the options.
			if (optionCapTotal == null) return max
			return max == null ? optionCapTotal : Math.min(max, optionCapTotal)
		}
		case 'pizza':
			return Math.min(max ?? Infinity, visibleOptionCount * 2)
		default:
			return Math.min(max ?? Infinity, visibleOptionCount)
	}
}

/**
 * A group's minimum cannot be met: more picks are required than the group
 * allows (`maxSelections`, or 1 for single choice) or than its visible
 * options can give (see `maxPicks`).
 */
function groupMinimumIsImpossible(
	group: MenuHealthModifierGroup,
	visibleOptionCount: number,
	optionCapTotal: number | null,
): boolean {
	const min = group.minSelections
	if (min <= 0) return false
	if (group.maxSelections != null && min > group.maxSelections) return true
	const picks = maxPicks(group, visibleOptionCount, optionCapTotal)
	return picks != null && Number.isFinite(picks) && min > picks
}

function penaltyFraction(check: MenuHealthCheck): number {
	if (check.count === 0 || check.total === 0) return 0
	const fraction = check.count / check.total
	return check.severity === 'error' ? Math.min(1, 0.5 + fraction / 2) : fraction
}

type Failing = { id: string; fingerprint: () => string }

type ItemFacts = {
	item: MenuHealthItem
	name: LocalizedString
	description: LocalizedString
	hasDescription: boolean
}

const ID_FIELD: Record<
	MenuHealthEntityType,
	'itemIds' | 'categoryIds' | 'modifierGroupIds'
> = {
	item: 'itemIds',
	category: 'categoryIds',
	modifier_group: 'modifierGroupIds',
}

function isHealthKey(value: string): value is MenuHealthCheckKey {
	return (MENU_HEALTH_CHECK_KEYS as readonly string[]).includes(value)
}

export function computeMenuHealth(input: MenuHealthInput): MenuHealth {
	const now = input.now ?? new Date()
	const { defaultLocale } = input
	// Hidden items are not shown to guests, so they cannot hurt the menu.
	const items = input.items.filter(
		(item) => item.availabilityStatus !== 'hidden',
	)
	const checks: MenuHealthCheck[] = []

	// Dismissals by `<checkKey>\0<entityId>`; `card:` and unknown keys skipped.
	const dismissals = new Map<string, MenuHealthDismissal>()
	for (const dismissal of input.dismissals ?? []) {
		if (!isHealthKey(dismissal.checkKey)) continue
		dismissals.set(`${dismissal.checkKey}\u0000${dismissal.entityId}`, dismissal)
	}
	const usedDismissals = new Set<string>()

	const addCheck = (
		key: MenuHealthCheckKey,
		total: number,
		failing: Failing[],
		extra: Partial<MenuHealthCheck> = {},
	) => {
		const ids: string[] = []
		const dismissedIds: string[] = []
		const fingerprints: Record<string, string> | undefined =
			input.includeFingerprints ? {} : undefined
		for (const record of failing) {
			const mapKey = `${key}\u0000${record.id}`
			const dismissal = dismissals.get(mapKey)
			let fingerprint: string | undefined
			if (dismissal) {
				fingerprint = record.fingerprint()
				if (dismissal.fingerprint === fingerprint) {
					usedDismissals.add(mapKey)
					dismissedIds.push(record.id)
				} else {
					ids.push(record.id)
				}
			} else {
				ids.push(record.id)
			}
			if (fingerprints) fingerprints[record.id] = fingerprint ?? record.fingerprint()
		}
		checks.push({
			key,
			severity: SEVERITY[key],
			count: ids.length,
			total,
			[ID_FIELD[menuHealthEntityType(key)]]: ids,
			dismissedIds,
			...extra,
			...(fingerprints ? { fingerprints } : {}),
		})
	}

	if (items.length > 0) {
		const enabledLocales = Array.from(new Set([defaultLocale, ...input.locales]))
		const translationLocales = enabledLocales.filter(
			(locale) => locale !== defaultLocale,
		)
		// Parse each dish's localized fields once for every check.
		const facts: ItemFacts[] = items.map((item) => {
			const description = parseLocalizedString(item.description, defaultLocale)
			return {
				item,
				name: parseLocalizedString(item.displayName, defaultLocale),
				description,
				hasDescription: Object.values(description).some((value) =>
					hasText(value),
				),
			}
		})
		const enabledNames = (fact: ItemFacts) => {
			const names: Record<string, string> = {}
			for (const locale of enabledLocales) {
				const value = fact.name[locale]
				if (value) names[locale] = value
			}
			return names
		}

		const collect = (
			test: (fact: ItemFacts) => boolean,
			fingerprint: (fact: ItemFacts) => string,
		): Failing[] => {
			const failing: Failing[] = []
			for (const fact of facts) {
				if (test(fact))
					failing.push({ id: fact.item.id, fingerprint: () => fingerprint(fact) })
			}
			return failing
		}

		addCheck(
			'zero_price',
			items.length,
			collect(
				(fact) => itemIsPricedAtZero(fact.item),
				(fact) =>
					menuHealthFingerprint({
						key: 'zero_price',
						price: fact.item.price,
						variantPrices: variantPrices(fact.item.variations),
					}),
			),
		)
		addCheck(
			'no_photo',
			items.length,
			collect(
				(fact) => !itemHasPhoto(fact.item),
				() => menuHealthFingerprint({ key: 'no_photo' }),
			),
		)
		addCheck(
			'no_description',
			items.length,
			collect(
				(fact) => !fact.hasDescription,
				() => menuHealthFingerprint({ key: 'no_description' }),
			),
		)

		if (translationLocales.length > 0) {
			const missingLocales = (fact: ItemFacts) =>
				translationLocales.filter(
					(locale) =>
						!hasText(fact.name[locale]) ||
						(fact.hasDescription && !hasText(fact.description[locale])),
				)
			addCheck(
				'missing_translation',
				items.length,
				collect(
					(fact) => missingLocales(fact).length > 0,
					(fact) =>
						menuHealthFingerprint({
							key: 'missing_translation',
							missingLocales: missingLocales(fact),
						}),
				),
				{ locales: translationLocales },
			)
		}

		addCheck(
			'no_allergens_or_calories',
			items.length,
			collect(
				(fact) => !itemListsAllergensOrCalories(fact.item),
				() => menuHealthFingerprint({ key: 'no_allergens_or_calories' }),
			),
		)
		addCheck(
			'long_unavailable',
			items.length,
			collect(
				(fact) => itemIsLongUnavailable(fact.item, now),
				(fact) =>
					menuHealthFingerprint({
						key: 'long_unavailable',
						availabilityStatus: fact.item.availabilityStatus,
					}),
			),
		)

		const nameCheck = (
			key: 'name_all_caps' | 'name_too_long',
			test: (name: string) => boolean,
		) =>
			addCheck(
				key,
				items.length,
				collect(
					(fact) =>
						enabledLocales.some((locale) => {
							const value = fact.name[locale]
							return value ? test(value) : false
						}),
					(fact) => menuHealthFingerprint({ key, names: enabledNames(fact) }),
				),
			)
		nameCheck('name_all_caps', nameIsAllCaps)
		nameCheck('name_too_long', nameIsTooLong)

		// Same source-language name (normalized) and the same prices.
		const sets = new Map<string, ItemFacts[]>()
		const duplicateKeys = new Map<ItemFacts, { name: string; price: string }>()
		for (const fact of facts) {
			const source = fact.name[defaultLocale]
			if (!source) continue
			const name = normalizeMenuName(source)
			if (!name) continue
			const price = [
				fact.item.price,
				...variantPrices(fact.item.variations).sort((a, b) => a - b),
			].join(',')
			const setKey = `${name}\u0000${price}`
			duplicateKeys.set(fact, { name, price })
			const set = sets.get(setKey)
			if (set) set.push(fact)
			else sets.set(setKey, [fact])
		}
		const duplicates: Failing[] = []
		for (const fact of facts) {
			const key = duplicateKeys.get(fact)
			if (!key) continue
			const set = sets.get(`${key.name}\u0000${key.price}`)!
			if (set.length < 2) continue
			duplicates.push({
				id: fact.item.id,
				fingerprint: () =>
					menuHealthFingerprint({
						key: 'duplicate_item',
						normalizedName: key.name,
						price: key.price,
						ids: set.map((entry) => entry.item.id),
					}),
			})
		}
		addCheck('duplicate_item', items.length, duplicates)
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
		addCheck(
			'empty_category',
			categories.length,
			categories
				.filter(
					(category) => !withItems.has(category.id) && !parents.has(category.id),
				)
				.map((category) => ({
					id: category.id,
					fingerprint: () => menuHealthFingerprint({ key: 'empty_category' }),
				})),
		)
	}

	if (input.modifierGroups && items.length > 0) {
		// Only groups attached directly to a dish guests can see count; groups
		// nested under an option are left out.
		const visibleItemIds = new Set(items.map((item) => item.id))
		const onVisibleDish = new Set<string>()
		for (const row of input.itemModifierGroups ?? []) {
			if (visibleItemIds.has(row.itemId)) onVisibleDish.add(row.modifierGroupId)
		}
		// Orders refuse an option that is not `available`, so only those count
		// (`unavailable_until` is available again once its date has passed).
		const visibleOptions = new Map<string, number>()
		// Sum of the options' own pick caps; null once any option has no cap.
		const optionCaps = new Map<string, number | null>()
		for (const row of input.modifierGroupOptions ?? []) {
			const selectable =
				row.availabilityStatus === 'available' ||
				(row.availabilityStatus === 'unavailable_until' &&
					(row.unavailableUntil == null ||
						row.unavailableUntil.getTime() <= now.getTime()))
			if (!selectable) continue
			visibleOptions.set(
				row.modifierGroupId,
				(visibleOptions.get(row.modifierGroupId) ?? 0) + 1,
			)
			const cap = row.optionMaxSelections ?? null
			const sofar = optionCaps.get(row.modifierGroupId)
			optionCaps.set(
				row.modifierGroupId,
				sofar === undefined
					? cap
					: sofar == null || cap == null
						? null
						: sofar + cap,
			)
		}
		const groups = input.modifierGroups.filter(
			(group) =>
				group.availabilityStatus !== 'hidden' && onVisibleDish.has(group.id),
		)
		if (groups.length > 0) {
			const empty: Failing[] = []
			const impossible: Failing[] = []
			for (const group of groups) {
				const optionCount = visibleOptions.get(group.id) ?? 0
				const failing = (
					key: 'empty_option_group' | 'impossible_minimum',
				): Failing => ({
					id: group.id,
					fingerprint: () =>
						menuHealthFingerprint({
							key,
							selectionType: group.selectionType,
							minSelections: group.minSelections,
							maxSelections: group.maxSelections,
							visibleOptionCount: optionCount,
						}),
				})
				if (optionCount === 0) empty.push(failing('empty_option_group'))
				else if (
						groupMinimumIsImpossible(
							group,
							optionCount,
							optionCaps.get(group.id) ?? null,
						)
					)
					impossible.push(failing('impossible_minimum'))
			}
			addCheck('empty_option_group', groups.length, empty)
			addCheck('impossible_minimum', groups.length, impossible)
		}
	}

	let totalWeight = 0
	let lost = 0
	for (const check of checks) {
		const weight = MENU_HEALTH_WEIGHTS[check.key]
		if (!MENU_HEALTH_DEDUCTION_CHECKS.has(check.key)) totalWeight += weight
		lost += weight * penaltyFraction(check)
	}
	const rawScore =
		totalWeight === 0 ? 100 : (100 * (totalWeight - lost)) / totalWeight
	// Never round a menu with problems up to a perfect 100.
	const fixCount = checks.reduce((sum, check) => sum + check.count, 0)
	const score = Math.max(
		0,
		Math.min(fixCount > 0 ? 99 : 100, Math.round(rawScore)),
	)

	// Dismissals of checks that ran but no longer match a failing record.
	// Only records guests can see: a hidden or missing record keeps its
	// dismissal for when it is shown again.
	const ranKeys = new Set(checks.map((check) => check.key))
	const visibleIds: Record<MenuHealthEntityType, Set<string>> = {
		item: new Set(items.map((item) => item.id)),
		category: new Set(categories.map((category) => category.id)),
		modifier_group: new Set(
			(input.modifierGroups ?? [])
				.filter((group) => group.availabilityStatus !== 'hidden')
				.map((group) => group.id),
		),
	}
	const staleDismissals: MenuHealth['staleDismissals'] = []
	for (const [mapKey, dismissal] of dismissals) {
		const key = dismissal.checkKey as MenuHealthCheckKey
		if (!ranKeys.has(key) || usedDismissals.has(mapKey)) continue
		if (!visibleIds[menuHealthEntityType(key)].has(dismissal.entityId)) continue
		staleDismissals.push({
			entityId: dismissal.entityId,
			checkKey: key,
			fingerprint: dismissal.fingerprint,
		})
	}

	return {
		score,
		grade: menuHealthGrade(score),
		fixCount,
		checks,
		itemCount: items.length,
		staleDismissals,
	}
}

/** The ids a check lists (failing, not dismissed). */
export function menuHealthCheckIds(check: MenuHealthCheck): string[] {
	return check[ID_FIELD[menuHealthEntityType(check.key)]] ?? []
}

/**
 * Reshape health for the browser: per check, up to `MENU_HEALTH_RECORDS_MAX`
 * failing and dismissed records with their names, no fingerprints.
 */
export function summarizeMenuHealth(
	health: MenuHealth,
	nameOf: (entityType: MenuHealthEntityType, id: string) => string,
): MenuHealthSummary {
	return {
		score: health.score,
		grade: health.grade,
		fixCount: health.fixCount,
		itemCount: health.itemCount,
		checks: health.checks.map((check) => {
			const entityType = menuHealthEntityType(check.key)
			const ref = (id: string) => ({ id, name: nameOf(entityType, id) })
			const dismissedIds = check.dismissedIds ?? []
			return {
				key: check.key,
				severity: check.severity,
				count: check.count,
				total: check.total,
				...(check.locales ? { locales: check.locales } : {}),
				entityType,
				records: menuHealthCheckIds(check)
					.slice(0, MENU_HEALTH_RECORDS_MAX)
					.map(ref),
				dismissedCount: dismissedIds.length,
				dismissed: dismissedIds.slice(0, MENU_HEALTH_RECORDS_MAX).map(ref),
			}
		}),
	}
}

const SEVERITY_ORDER: Record<MenuHealthSeverity, number> = {
	error: 0,
	warning: 1,
	info: 2,
}

/** The failing checks, most urgent first. */
export function getMenuHealthFixes<
	Check extends Pick<MenuHealthCheck, 'key' | 'severity' | 'count'>,
>(health: { checks: Check[] }): Check[] {
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
	return isHealthKey(value ?? '') ? (value as MenuHealthCheckKey) : null
}

/** Query parameter the Items, Categories and Modifier groups lists read. */
export const MENU_HEALTH_PARAM = 'health'
