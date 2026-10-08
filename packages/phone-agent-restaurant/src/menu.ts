import { z } from 'zod'
import {
	defaultPriceFormatter,
	editDistance,
	foldText,
	type PriceFormatter,
	stripArabicArticle,
} from '@repo/phone-agent'

/**
 * Structural subset of the published Sites menu payload. Declared here so the
 * voice worker does not depend on App code; App passes its payload as-is.
 */
export interface AgentMenuOption {
	id: string
	displayName: string
	description?: string | null
	price: number
	availabilityStatus: string
	isDefault?: boolean
	isVegetarian?: boolean
	isGlutenFree?: boolean
	allergens?: string[]
	nestedModifierGroups?: AgentModifierGroup[]
}

export interface AgentModifierGroup {
	id: string
	name: string
	selectionType: string
	minSelections: number
	maxSelections: number | null
	availabilityStatus: string
	options: AgentMenuOption[]
}

export interface AgentMenuItem {
	id: string
	displayName: string
	description: string | null
	price: number
	variations: {
		groups: Array<{
			id: string
			name: string
			values: Array<{ id: string; name: string }>
		}>
		variants: Array<{
			id: string
			valueIds: string[]
			price: number
			availabilityStatus: 'available' | 'unavailable'
		}>
	}
	isAlcohol?: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin?: number | null
	calorieMax?: number | null
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus: string
	modifierGroups: AgentModifierGroup[]
}

export interface AgentMenuCategory {
	id: string
	displayName: string
	description: string | null
	subcategories?: AgentMenuCategory[]
	upsellCategoryIds: string[]
	availabilityStatus: string
	items: AgentMenuItem[]
}

export interface AgentMenu {
	id: string
	displayName: string
	availabilityStatus: string
	categories: AgentMenuCategory[]
}

export type IndexedMenuItem = {
	item: AgentMenuItem
	categoryId: string
	categoryName: string
}

export function isAvailable(status: string | null | undefined) {
	return !status || status === 'available'
}

export function flattenMenuItems(menus: AgentMenu[]): IndexedMenuItem[] {
	const out: IndexedMenuItem[] = []
	const seen = new Set<string>()
	const visit = (category: AgentMenuCategory) => {
		if (!isAvailable(category.availabilityStatus)) return
		for (const item of category.items) {
			if (seen.has(item.id)) continue
			seen.add(item.id)
			out.push({
				item,
				categoryId: category.id,
				categoryName: category.displayName,
			})
		}
		for (const sub of category.subcategories ?? []) visit(sub)
	}
	for (const menu of menus) {
		if (!isAvailable(menu.availabilityStatus)) continue
		for (const category of menu.categories) visit(category)
	}
	return out
}

export function listMenuCategories(menus: AgentMenu[]) {
	const out: Array<{ id: string; name: string; itemCount: number }> = []
	const visit = (category: AgentMenuCategory) => {
		if (!isAvailable(category.availabilityStatus)) return
		out.push({
			id: category.id,
			name: category.displayName,
			itemCount: category.items.length,
		})
		for (const sub of category.subcategories ?? []) visit(sub)
	}
	for (const menu of menus) {
		if (!isAvailable(menu.availabilityStatus)) continue
		for (const category of menu.categories) visit(category)
	}
	return out
}

function normalize(value: string) {
	return (
		foldText(value)
			// 12", 12 in, 12-inch and 12 inches all become "12 inch".
			.replace(
				/(\d+)\s*-?\s*(?:"|''|\u201d|\u2033|inch(?:es)?\b|in\b)/g,
				'$1 inch ',
			)
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	)
}

const TOKEN_ALIASES: Record<string, string> = {
	lg: 'large',
	lrg: 'large',
	sm: 'small',
	sml: 'small',
	med: 'medium',
	reg: 'regular',
	normal: 'regular',
}

function tokens(value: string) {
	return normalize(value)
		.split(' ')
		.filter((token) => token.length > 1 || /\d/.test(token))
		.map((token) => {
			const alias = TOKEN_ALIASES[token]
			if (alias) return alias
			const stem = stripArabicArticle(token)
			return stem.length > 3 && stem.endsWith('s') ? stem.slice(0, -1) : stem
		})
}

/**
 * Words that pick a size or are filler rather than naming a dish, so "large
 * pepperoni" still counts as fully naming "Pepperoni Pizza".
 */
const NON_NAME_WORDS = new Set([
	'small',
	'medium',
	'large',
	'regular',
	'extra',
	'xl',
	'xxl',
	'personal',
	'mini',
	'jumbo',
	'inch',
	'size',
	'order',
	'one',
	'two',
	'three',
	'four',
	'five',
	'an',
	'of',
	'the',
	'please',
	'some',
	'with',
	// Spanish
	'grande',
	'mediano',
	'mediana',
	'pequeno',
	'pequena',
	'chico',
	'chica',
	'tamano',
	// Arabic (folded)
	'كبير',
	'كبيره',
	'صغير',
	'صغيره',
	'وسط',
	'متوسط',
	'متوسطه',
	'عادي',
	'حجم',
])

/** 3 for the same word, 2 for a shared stem or a near spelling, else 0. */
function wordMatch(spoken: string, word: string) {
	if (spoken === word) return 3
	const shorter = Math.min(spoken.length, word.length)
	if (shorter >= 3 && (word.startsWith(spoken) || spoken.startsWith(word))) {
		return 2
	}
	if (shorter >= 5 && !/\d/.test(spoken + word)) {
		const allowed = shorter >= 7 ? 2 : 1
		if (editDistance(spoken, word, allowed) <= allowed) return 2
	}
	return 0
}

function bestWordMatch(spoken: string, words: string[]) {
	return Math.max(0, ...words.map((word) => wordMatch(spoken, word)))
}

type ScoredMenuItem = {
	entry: IndexedMenuItem
	score: number
	/** How well the query matches the item name alone. */
	nameScore: number
	/** Every dish word in the query matched the item name. */
	covered: boolean
}

function scoreMenuItems(menus: AgentMenu[], query: string): ScoredMenuItem[] {
	const queryTokens = tokens(query)
	if (queryTokens.length === 0) return []
	const wanted = normalize(query)
	const dishTokens = queryTokens.filter(
		(token) => !NON_NAME_WORDS.has(token) && !/^\d+$/.test(token),
	)
	return flattenMenuItems(menus)
		.map((entry) => {
			const name = tokens(entry.item.displayName)
			const category = tokens(entry.categoryName)
			const description = tokens(entry.item.description ?? '')
			let nameScore = 0
			let score = 0
			for (const token of queryTokens) {
				const match = bestWordMatch(token, name)
				nameScore += match
				score += match
				if (category.includes(token)) score += 1
				if (description.includes(token)) score += 1
			}
			if (normalize(entry.item.displayName) === wanted) {
				nameScore += 5
				score += 5
			}
			const covered =
				dishTokens.length > 0 &&
				dishTokens.every((token) => bestWordMatch(token, name) > 0)
			return { entry, score, nameScore, covered }
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || b.nameScore - a.nameScore)
}

/**
 * Scores items by how many query words appear in the name, category, and
 * description. Speech-to-text often mangles dish names, so partial word
 * overlap and near spellings are good enough to surface candidates for the
 * model to choose from.
 */
export function searchMenuItems(
	menus: AgentMenu[],
	query: string,
	limit = 5,
): IndexedMenuItem[] {
	return scoreMenuItems(menus, query)
		.slice(0, limit)
		.map(({ entry }) => entry)
}

export type MenuItemResolution =
	| { status: 'found'; entry: IndexedMenuItem }
	/** Several items fit (or only a weak match did); ask the caller which one. */
	| { status: 'ambiguous'; candidates: IndexedMenuItem[] }
	| { status: 'not_found' }

/**
 * Resolves an item id or spoken name to one item only when that is clear: an
 * id, an exact name, or a single item whose name covers every dish word in
 * the request and beats the runner-up. Anything less returns candidates.
 */
export function resolveMenuItem(
	menus: AgentMenu[],
	idOrName: string,
	limit = 5,
): MenuItemResolution {
	const items = flattenMenuItems(menus)
	const byId = items.find((entry) => entry.item.id === idOrName)
	if (byId) return { status: 'found', entry: byId }

	const wanted = normalize(idOrName)
	const exact = items.filter(
		(entry) => normalize(entry.item.displayName) === wanted,
	)
	if (exact.length === 1) return { status: 'found', entry: exact[0]! }
	if (exact.length > 1) {
		return { status: 'ambiguous', candidates: exact.slice(0, limit) }
	}

	const scored = scoreMenuItems(menus, idOrName)
	if (!scored.length) return { status: 'not_found' }

	const covered = scored
		.filter((candidate) => candidate.covered)
		.sort((a, b) => b.nameScore - a.nameScore || b.score - a.score)
	const [best, runnerUp] = covered
	if (best && (!runnerUp || best.nameScore >= runnerUp.nameScore + 2)) {
		return { status: 'found', entry: best.entry }
	}
	const candidates = (covered.length ? covered : scored)
		.slice(0, limit)
		.map(({ entry }) => entry)
	return { status: 'ambiguous', candidates }
}

/** The item for an id or name, or null unless the match is unambiguous. */
export function findMenuItem(menus: AgentMenu[], idOrName: string) {
	const result = resolveMenuItem(menus, idOrName)
	return result.status === 'found' ? result.entry : null
}

function itemIsSoldOut(item: AgentMenuItem) {
	if (!isAvailable(item.availabilityStatus)) return true
	return (
		item.variations.variants.length > 0 &&
		item.variations.variants.every(
			(variant) => variant.availabilityStatus === 'unavailable',
		)
	)
}

function variantLabel(item: AgentMenuItem, valueIds: string[]) {
	return item.variations.groups
		.map((group, index) => {
			const valueId = valueIds[index]
			return group.values.find((value) => value.id === valueId)?.name
		})
		.filter(Boolean)
		.join(', ')
}

/** Nested choice groups deeper than this are ignored (menus are a tree, but guard cycles). */
const MAX_CHOICE_DEPTH = 4

/** A positive max limits selections; null or 0 means no limit. */
function selectionLimit(group: AgentModifierGroup) {
	return group.maxSelections != null && group.maxSelections > 0
		? group.maxSelections
		: null
}

export type DescribedChoiceGroup = {
	groupId: string
	name: string
	required: boolean
	min: number
	max: number | null
	options: Array<{
		optionId: string
		name: string
		price?: string
		/** Follow-up choices that apply only when this option is picked. */
		choices?: DescribedChoiceGroup[]
	}>
}

function describeChoiceGroups(
	groups: AgentModifierGroup[],
	formatPrice: PriceFormatter,
	depth = 0,
): DescribedChoiceGroup[] {
	return groups
		.filter((group) => isAvailable(group.availabilityStatus))
		.map((group) => ({
			groupId: group.id,
			name: group.name,
			required: group.minSelections > 0,
			min: group.minSelections,
			max: selectionLimit(group),
			options: group.options
				.filter((option) => isAvailable(option.availabilityStatus))
				.map((option) => {
					const nested =
						depth + 1 < MAX_CHOICE_DEPTH && option.nestedModifierGroups?.length
							? describeChoiceGroups(
									option.nestedModifierGroups,
									formatPrice,
									depth + 1,
								)
							: []
					return {
						optionId: option.id,
						name: option.displayName,
						price:
							option.price > 0 ? `+${formatPrice(option.price)}` : undefined,
						...(nested.length ? { choices: nested } : {}),
					}
				}),
		}))
}

/** Compact, model-friendly description of a single item. */
export function describeMenuItem(
	entry: IndexedMenuItem,
	formatPrice: PriceFormatter = defaultPriceFormatter,
) {
	const { item } = entry
	const soldOut = itemIsSoldOut(item)
	const tags = [
		item.isVegetarian ? 'vegetarian' : null,
		item.isGlutenFree ? 'gluten-free' : null,
		item.isAlcohol ? 'contains alcohol' : null,
		item.isPopular ? 'popular' : null,
	].filter(Boolean)
	return {
		id: item.id,
		name: item.displayName,
		category: entry.categoryName,
		description: item.description ?? undefined,
		soldOut,
		price: item.variations.variants.length
			? undefined
			: formatPrice(item.price),
		sizes: item.variations.variants
			.filter((variant) => variant.availabilityStatus === 'available')
			.map((variant) => ({
				variantId: variant.id,
				label: variantLabel(item, variant.valueIds),
				price: formatPrice(variant.price),
			})),
		choices: describeChoiceGroups(item.modifierGroups, formatPrice),
		tags,
		allergens: item.allergens.length ? item.allergens : undefined,
		calories:
			item.calorieMin != null
				? item.calorieMax != null && item.calorieMax !== item.calorieMin
					? `${item.calorieMin}-${item.calorieMax}`
					: `${item.calorieMin}`
				: undefined,
	}
}

/** Items the restaurant marked as upsells, excluding what's already ordered. */
export function suggestUpsells(
	menus: AgentMenu[],
	cartItemIds: string[],
	limit = 3,
): IndexedMenuItem[] {
	const inCart = new Set(cartItemIds)
	return flattenMenuItems(menus)
		.filter(
			(entry) =>
				entry.item.isUpsell &&
				!inCart.has(entry.item.id) &&
				!itemIsSoldOut(entry.item),
		)
		.slice(0, limit)
}

// Mirrors the Sites `menuza_cart_{orgId}` localStorage entry so a handoff can be
// written straight into the browser cart.
export const HandoffCartOptionSchema = z.object({
	groupId: z.string().min(1).max(80),
	groupName: z.string().max(200),
	optionId: z.string().min(1).max(80),
	optionName: z.string().max(200),
	priceDelta: z.number().finite(),
	half: z.enum(['whole', 'left', 'right']).optional(),
})

export const HandoffCartItemSchema = z.object({
	id: z.string().min(1).max(80),
	itemId: z.string().min(1).max(80),
	variantId: z.string().max(80).optional(),
	name: z.string().max(200),
	basePrice: z.number().finite(),
	unitPrice: z.number().finite(),
	quantity: z.number().int().min(1).max(99),
	options: z.array(HandoffCartOptionSchema).max(40),
	instructions: z.string().max(500),
})
export type HandoffCartItem = z.infer<typeof HandoffCartItemSchema>

export const HandoffCartSchema = z.array(HandoffCartItemSchema).min(1).max(50)

export type AddCartLineInput = {
	item: string
	variantId?: string | null
	optionIds?: string[]
	quantity?: number
	instructions?: string | null
}

export type AddCartLineResult =
	| { ok: true; line: HandoffCartItem }
	| {
			ok: false
			error: string
			/** Set when the item name fit several items; ask which one. */
			candidates?: Array<{ id: string; name: string }>
	  }

/** One choosable option, with the option it is nested under (if any). */
type OptionNode = {
	group: AgentModifierGroup
	option: AgentMenuOption
	parent: OptionNode | null
}

function indexOptions(
	groups: AgentModifierGroup[],
	parent: OptionNode | null = null,
	depth = 0,
	out: OptionNode[] = [],
): OptionNode[] {
	for (const group of groups) {
		if (!isAvailable(group.availabilityStatus)) continue
		for (const option of group.options) {
			if (!isAvailable(option.availabilityStatus)) continue
			const node: OptionNode = { group, option, parent }
			out.push(node)
			if (depth + 1 < MAX_CHOICE_DEPTH && option.nestedModifierGroups?.length) {
				indexOptions(option.nestedModifierGroups, node, depth + 1, out)
			}
		}
	}
	return out
}

const sameParent = (a: OptionNode | null, b: OptionNode | null) =>
	(a?.option.id ?? null) === (b?.option.id ?? null) &&
	(a?.group.id ?? null) === (b?.group.id ?? null)

/** True when every word of `label` appears among `words`. */
function labelIn(label: string, words: Set<string>) {
	const labelWords = tokens(label)
	return labelWords.length > 0 && labelWords.every((word) => words.has(word))
}

/** The entry with the longest fully matched label, if exactly one has it. */
function longestUnique<T>(entries: T[], labelOf: (entry: T) => string) {
	let best: T[] = []
	let bestLength = 0
	for (const entry of entries) {
		const length = tokens(labelOf(entry)).length
		if (length > bestLength) {
			best = [entry]
			bestLength = length
		} else if (length === bestLength) {
			best.push(entry)
		}
	}
	return best.length === 1 ? best[0]! : null
}

// Words that turn a size into a different size, so "small" must not pick
// "Extra small" just because the label contains it.
const SIZE_QUALIFIERS = new Set([
	'extra',
	'xl',
	'xxl',
	'double',
	'triple',
	'half',
	'mini',
	'super',
	'jumbo',
])

function findVariant(item: AgentMenuItem, idOrLabel: string) {
	const { variants } = item.variations
	const byId = variants.find((variant) => variant.id === idOrLabel)
	if (byId) return byId
	const wanted = normalize(idOrLabel)
	const label = (variant: (typeof variants)[number]) =>
		variantLabel(item, variant.valueIds)
	const exact = variants.find((variant) => normalize(label(variant)) === wanted)
	if (exact) return exact
	const wantedWords = tokens(idOrLabel)
	const words = new Set(wantedWords)
	const fitting = variants.filter((variant) => labelIn(label(variant), words))
	const fit = longestUnique(fitting, label)
	if (fit) return fit
	// A shorter request like "large" for "Large (16 inch)": every word said
	// is in the label, the label adds no size qualifier, and only one fits.
	if (!wantedWords.length) return null
	const covering = variants.filter((variant) => {
		const labelWords = tokens(label(variant))
		return (
			wantedWords.every((word) => labelWords.includes(word)) &&
			!labelWords.some((word) => !words.has(word) && SIZE_QUALIFIERS.has(word))
		)
	})
	return covering.length === 1 ? covering[0]! : null
}

/**
 * Words of the spoken item phrase that are not part of the item's name, such
 * as "large" in "large pepperoni". These can pick a size or a choice.
 */
function extraPhraseWords(phrase: string, item: AgentMenuItem) {
	const name = tokens(item.displayName)
	return new Set(
		tokens(phrase).filter((word) => bestWordMatch(word, name) === 0),
	)
}

function resolveOptionRefs(
	item: AgentMenuItem,
	refs: string[],
): { ok: true; picked: OptionNode[] } | { ok: false; error: string } {
	const index = indexOptions(item.modifierGroups)
	const candidatesByRef = refs.map((ref) => {
		const byId = index.filter((node) => node.option.id === ref)
		if (byId.length) return byId
		const wanted = normalize(ref)
		return index.filter((node) => normalize(node.option.displayName) === wanted)
	})
	const chosenIds = new Set(
		candidatesByRef.flat().map((node) => node.option.id),
	)

	const picked: OptionNode[] = []
	for (const [i, ref] of refs.entries()) {
		const candidates = candidatesByRef[i]!
		if (!candidates.length) {
			return {
				ok: false,
				error: `"${ref}" isn't an available choice for ${item.displayName}.`,
			}
		}
		const reachable = candidates.filter(
			(node) => !node.parent || chosenIds.has(node.parent.option.id),
		)
		if (!reachable.length) {
			const parents = [
				...new Set(candidates.map((node) => node.parent!.option.displayName)),
			].join(' or ')
			return {
				ok: false,
				error: `${candidates[0]!.option.displayName} only goes with ${parents}. Ask if they want that too.`,
			}
		}
		const distinctGroups = new Set(reachable.map((node) => node.group.id))
		if (distinctGroups.size > 1) {
			const groups = [
				...new Set(reachable.map((node) => node.group.name)),
			].join(', ')
			return {
				ok: false,
				error: `"${ref}" is a choice in more than one group (${groups}). Use the option id from get_menu_item.`,
			}
		}
		picked.push(reachable[0]!)
	}
	return { ok: true, picked }
}

/** Checks min/max for each group, then the groups under each chosen option. */
function checkChoiceGroups(
	groups: AgentModifierGroup[],
	picked: OptionNode[],
	parent: OptionNode | null,
	itemName: string,
	depth = 0,
): string | null {
	for (const group of groups) {
		if (!isAvailable(group.availabilityStatus)) continue
		const inGroup = picked.filter(
			(node) => node.group.id === group.id && sameParent(node.parent, parent),
		)
		const max = selectionLimit(group)
		if (max !== null && inGroup.length > max) {
			return `${group.name} allows at most ${max} choice${max === 1 ? '' : 's'}.`
		}
		if (inGroup.length < group.minSelections) {
			const names = group.options
				.filter((option) => isAvailable(option.availabilityStatus))
				.map((option) => option.displayName)
				.slice(0, 8)
				.join(', ')
			const forWhat = parent
				? `${parent.option.displayName} on the ${itemName}`
				: itemName
			return `Ask the caller to choose ${group.name} for ${forWhat}${names ? ` (${names})` : ''}.`
		}
		if (depth + 1 >= MAX_CHOICE_DEPTH) continue
		const seen = new Set<string>()
		for (const node of inGroup) {
			if (seen.has(node.option.id)) continue
			seen.add(node.option.id)
			const error = checkChoiceGroups(
				node.option.nestedModifierGroups ?? [],
				picked,
				node,
				itemName,
				depth + 1,
			)
			if (error) return error
		}
	}
	return null
}

/**
 * Picks choices named in the item phrase ("large" in "large pepperoni") for
 * top-level groups the caller hasn't chosen from yet. Only a single clear
 * match per group is used.
 */
function inferChoicesFromPhrase(
	item: AgentMenuItem,
	extraWords: Set<string>,
	picked: OptionNode[],
): OptionNode[] {
	if (!extraWords.size) return []
	const inferred: OptionNode[] = []
	for (const group of item.modifierGroups) {
		if (!isAvailable(group.availabilityStatus)) continue
		if (picked.some((node) => node.group.id === group.id && !node.parent)) {
			continue
		}
		const fitting = group.options.filter(
			(option) =>
				isAvailable(option.availabilityStatus) &&
				labelIn(option.displayName, extraWords),
		)
		const option = longestUnique(fitting, (entry) => entry.displayName)
		if (option) inferred.push({ group, option, parent: null })
	}
	return inferred
}

/**
 * Validates a caller's choice against the menu and prices it. Errors are
 * phrased so the model can relay them or ask the right follow-up question.
 */
export function buildCartLine(
	menus: AgentMenu[],
	input: AddCartLineInput,
	makeId: () => string,
): AddCartLineResult {
	const resolution = resolveMenuItem(menus, input.item)
	if (resolution.status === 'not_found') {
		return { ok: false, error: `"${input.item}" is not on the menu.` }
	}
	if (resolution.status === 'ambiguous') {
		const candidates = resolution.candidates.map((entry) => ({
			id: entry.item.id,
			name: entry.item.displayName,
		}))
		return {
			ok: false,
			error: `"${input.item}" could be ${candidates.map((c) => c.name).join(', or ')}. Ask which one they want, then use its id.`,
			candidates,
		}
	}
	const { item } = resolution.entry
	if (itemIsSoldOut(item)) {
		return { ok: false, error: `${item.displayName} is sold out right now.` }
	}
	const extraWords =
		item.id === input.item
			? new Set<string>()
			: extraPhraseWords(input.item, item)

	let basePrice = item.price
	let variantId: string | undefined
	const options: HandoffCartItem['options'] = []
	if (item.variations.variants.length) {
		const variant = input.variantId
			? findVariant(item, input.variantId)
			: longestUnique(
					item.variations.variants.filter(
						(candidate) =>
							candidate.availabilityStatus === 'available' &&
							labelIn(variantLabel(item, candidate.valueIds), extraWords),
					),
					(candidate) => variantLabel(item, candidate.valueIds),
				)
		if (!input.variantId && !variant) {
			return {
				ok: false,
				error: `Ask which size or variation of ${item.displayName} they want.`,
			}
		}
		if (!variant || variant.availabilityStatus !== 'available') {
			return {
				ok: false,
				error: `That option for ${item.displayName} isn't available. Offer the listed sizes instead.`,
			}
		}
		basePrice = variant.price
		variantId = variant.id
		item.variations.groups.forEach((group, index) => {
			const value = group.values.find(
				(candidate) => candidate.id === variant.valueIds[index],
			)
			if (value) {
				options.push({
					groupId: group.id,
					groupName: group.name,
					optionId: value.id,
					optionName: value.name,
					priceDelta: 0,
				})
			}
		})
	}

	const resolved = resolveOptionRefs(item, input.optionIds ?? [])
	if (!resolved.ok) return { ok: false, error: resolved.error }
	const picked = [
		...resolved.picked,
		...inferChoicesFromPhrase(item, extraWords, resolved.picked),
	]
	const choiceError = checkChoiceGroups(
		item.modifierGroups,
		picked,
		null,
		item.displayName,
	)
	if (choiceError) return { ok: false, error: choiceError }
	for (const node of picked) {
		options.push({
			groupId: node.group.id,
			groupName: node.group.name,
			optionId: node.option.id,
			optionName: node.option.displayName,
			priceDelta: node.option.price,
		})
	}

	const quantity = Math.min(99, Math.max(1, Math.round(input.quantity ?? 1)))
	const optionsDelta = options.reduce(
		(sum, option) => sum + option.priceDelta,
		0,
	)
	return {
		ok: true,
		line: {
			id: makeId(),
			itemId: item.id,
			...(variantId ? { variantId } : {}),
			name: item.displayName,
			basePrice,
			unitPrice: basePrice + optionsDelta,
			quantity,
			options,
			instructions: (input.instructions ?? '').trim().slice(0, 500),
		},
	}
}

export function cartSubtotal(cart: HandoffCartItem[]) {
	return cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
}

/** One line per cart entry, suitable for reading back to the caller. */
export function summarizeCart(
	cart: HandoffCartItem[],
	formatPrice: PriceFormatter = defaultPriceFormatter,
) {
	return {
		lines: cart.map((line) => ({
			lineId: line.id,
			text: `${line.quantity} × ${line.name}${
				line.options.length
					? ` (${line.options.map((option) => option.optionName).join(', ')})`
					: ''
			}${line.instructions ? `, note: ${line.instructions}` : ''}`,
			total: formatPrice(line.unitPrice * line.quantity),
		})),
		subtotal: formatPrice(cartSubtotal(cart)),
		itemCount: cart.reduce((sum, line) => sum + line.quantity, 0),
	}
}
